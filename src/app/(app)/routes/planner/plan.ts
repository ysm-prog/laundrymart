/**
 * Rules the dispatch board and the action that commits it both have to agree on.
 *
 * Lives beside `actions.ts` rather than inside it because a `"use server"`
 * module may only export async functions — the same split as `run/checklist.ts`
 * and `warehouse/stages.ts`.
 */

import { z } from "zod";

/**
 * The same rule as `requiredDate` in `lib/actions`, restated rather than
 * imported: this module is pulled into the *client* bundle by `planner-board`,
 * and `lib/actions` reaches for `next/headers` to set the flash cookie. Importing
 * it here builds clean and typechecks clean, then fails the bundle.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker");

/** Column id for the tray of stops that have no run yet. */
export const UNASSIGNED = "unassigned";

/**
 * A stop stops being plannable the moment the driver touches it. Moving a stop
 * that has been arrived at, collected from or completed would rewrite where work
 * that has already happened happened.
 */
export function isMovable(job: { status: string; progress_status: string }): boolean {
  return !["completed", "cancelled"].includes(job.status) && job.progress_status === "not_started";
}

/** Runs that can still gain, lose or reorder stops. */
export function isReceiving(status: string): boolean {
  return !["closed", "cancelled"].includes(status);
}

export function lockReason(job: { status: string; progress_status: string }): string | null {
  if (job.status === "completed") return "Completed";
  if (job.status === "cancelled") return "Cancelled";
  if (job.progress_status !== "not_started") return "Driver on site";
  return null;
}

/* ----------------------------------------------------------------- capacity */

/**
 * How much of the truck a plan uses.
 *
 * There is no promised weight per stop anywhere in the schema, so the estimate
 * is the customer's own recent collections and nothing else. Stops for a
 * customer with no weighed history contribute zero and are counted separately,
 * so the meter can say how much of the run it is actually speaking for rather
 * than implying a total it cannot support.
 */
export type LoadEstimate = {
  kg: number;
  known: number;
  unknown: number;
  capacityKg: number | null;
  /** Fraction of capacity used, or null when the run has no vehicle. */
  ratio: number | null;
  over: boolean;
};

export function estimateLoad(
  jobs: ReadonlyArray<{ estimateKg: number | null }>,
  capacityKg: number | null,
): LoadEstimate {
  let kg = 0;
  let known = 0;
  let unknown = 0;

  for (const job of jobs) {
    if (job.estimateKg == null) unknown += 1;
    else { kg += job.estimateKg; known += 1; }
  }

  const rounded = Math.round(kg);
  const ratio = capacityKg && capacityKg > 0 ? rounded / capacityKg : null;
  return { kg: rounded, known, unknown, capacityKg, ratio, over: ratio != null && ratio > 1 };
}

/** Most recent weighed collections to average over, per customer. */
export const WEIGHT_SAMPLE = 6;

/**
 * Mean weight per customer from their recent weighed collections. Rows are
 * expected newest-first; only the first `WEIGHT_SAMPLE` per customer count, so
 * a customer whose volume has changed is not anchored to last year.
 */
export function averageWeights(
  rows: ReadonlyArray<{ customer_id: string; total_weight_kg: number | string | null }>,
  sample = WEIGHT_SAMPLE,
): Map<string, number> {
  const seen = new Map<string, { total: number; count: number }>();

  for (const row of rows) {
    const weight = Number(row.total_weight_kg ?? 0);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const bucket = seen.get(row.customer_id) ?? { total: 0, count: 0 };
    if (bucket.count >= sample) continue;
    bucket.total += weight;
    bucket.count += 1;
    seen.set(row.customer_id, bucket);
  }

  const averages = new Map<string, number>();
  for (const [customerId, bucket] of seen) {
    if (bucket.count > 0) averages.set(customerId, bucket.total / bucket.count);
  }
  return averages;
}

/* ------------------------------------------------------------ the payload */

/**
 * The whole board as one posted field.
 *
 * A planner is a sequence of trial moves — committing each drag separately would
 * mean the run sheet is briefly wrong after every one of them, and a
 * half-applied plan is worse than an unapplied one. So the board composes
 * locally and commits once, through a hidden JSON input.
 *
 * The schema lives here rather than in `actions.ts` so it can be asserted
 * against the shape `PlannerBoard` actually posts. That contract being
 * untestable — a `"use server"` module can export nothing but server actions —
 * is how the identical arrangement on the job form shipped broken and stayed
 * broken behind a green `verify`.
 *
 * Note the crew fields: the board holds them as `""` when nobody is picked, so
 * they are `z.literal("")`, never `null`. `planner-board.tsx` types them
 * `string` and `page.tsx` writes `route.driver_id ?? ""` — if either ever starts
 * emitting `null`, `parseDispatchPlan` rejects it by name instead of silently
 * dropping the crew.
 */
export const planSchema = z.object({
  date: isoDate,
  columns: z.array(z.object({
    // The unassigned tray is a column with no route behind it.
    routeId: z.union([z.string().uuid(), z.literal(UNASSIGNED)]),
    jobIds: z.array(z.string().uuid()).max(500),
    driverId: z.union([z.string().uuid(), z.literal("")]).optional(),
    vehicleId: z.union([z.string().uuid(), z.literal("")]).optional(),
  })).max(60),
});

export type DispatchPlan = z.infer<typeof planSchema>;

/** The posted plan, or the sentence explaining why it could not be read. */
export type PlanResult =
  | { ok: true; plan: DispatchPlan }
  | { ok: false; problem: string };

export function parseDispatchPlan(raw: FormDataEntryValue | null | undefined): PlanResult {
  let payload: unknown;
  try {
    payload = JSON.parse(typeof raw === "string" ? raw : "");
  } catch {
    return { ok: false, problem: "The plan could not be read. Reload the page and try again." };
  }
  const parsed = planSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, problem: `${where}${issue?.message ?? "The plan could not be read."}` };
  }
  return { ok: true, plan: parsed.data };
}
