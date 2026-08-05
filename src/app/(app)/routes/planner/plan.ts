/**
 * Rules the dispatch board and the action that commits it both have to agree on.
 *
 * Lives beside `actions.ts` rather than inside it because a `"use server"`
 * module may only export async functions — the same split as `run/checklist.ts`
 * and `warehouse/stages.ts`.
 */

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
