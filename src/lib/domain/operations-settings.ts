/**
 * How this laundry works, as three settings (Darshan's review, Phase 3, and the
 * client's change request 3 of 2026-11-23).
 *
 *   - **Plant stages** (brief 3.9, G13). Production batches — washing, drying,
 *     folding, packing — are a whole subsystem ATS does not use: the live
 *     database holds no batch. Until it does, every screen that shows them is a
 *     wall of zeros that reads as broken. So they are behind a switch, **off by
 *     default**. Hiding rather than linking was the brief's preference and the
 *     repo gave no reason to do otherwise: `production_batches` is joined to a
 *     run (`route_id`) and to stock, never to a laundry job, so there is no
 *     half-built link to finish.
 *   - **Default turnaround** (brief 3.4). How many days after it is taken in a
 *     job is promised back when the customer has no round to set the day.
 *
 *   - **Workflow** (change request 3). `simplified` — the default — finishes a
 *     laundry job the moment it is saved, so it is ready to invoice with no
 *     round, no delivery stage and no completion form. `full` is the original
 *     process: new → in the plant → ready → a round → out → completed. Nothing
 *     about the full process is removed; the setting only decides whether a
 *     new job walks it. **The database reads the same key** (0065): in the
 *     simplified workflow a delivery job may be completed from a plant stage
 *     without first going out on a round, and an absent key means simplified
 *     there too, so the two never disagree about the default.
 *
 * Stored in `tenants.settings.operations`, written through
 * `save_tenant_settings` (0057 adds the key). Nothing throws on a bad stored
 * value: it falls back to the default.
 */

export const WORKFLOWS = ["simplified", "full"] as const;
export type Workflow = (typeof WORKFLOWS)[number];

export const WORKFLOW_LABELS: Record<Workflow, string> = {
  simplified: "Simplified — a new job is completed and ready to invoice as soon as it is saved",
  full: "Full — jobs go through the plant, a delivery round and delivery before they are completed",
};

export type OperationsSettings = {
  /** Whether a new job is finished on save (`simplified`) or walks every stage (`full`). */
  workflow: Workflow;
  /** Show the plant: Linen › In the plant, its rail count and Today's tiles. */
  plantStages: boolean;
  /** Days from receipt to the promised return date, for a customer with no round. */
  defaultTurnaroundDays: number;
};

export const TURNAROUND_MIN = 0;
export const TURNAROUND_MAX = 30;

export const DEFAULT_OPERATIONS: OperationsSettings = {
  workflow: "simplified",
  plantStages: false,
  defaultTurnaroundDays: 2,
};

export function parseOperations(settings: unknown): OperationsSettings {
  const bag = settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).operations : undefined;
  const stored = bag && typeof bag === "object" && !Array.isArray(bag)
    ? bag as Record<string, unknown> : {};
  const days = stored.defaultTurnaroundDays;
  return {
    workflow: stored.workflow === "full" || stored.workflow === "simplified"
      ? stored.workflow : DEFAULT_OPERATIONS.workflow,
    plantStages: typeof stored.plantStages === "boolean" ? stored.plantStages : DEFAULT_OPERATIONS.plantStages,
    defaultTurnaroundDays: typeof days === "number" && Number.isInteger(days)
      && days >= TURNAROUND_MIN && days <= TURNAROUND_MAX
      ? days : DEFAULT_OPERATIONS.defaultTurnaroundDays,
  };
}

/** Read the posted form into a value the writer accepts, or say what is wrong. */
export function readOperationsForm(
  posted: { plantStages: unknown; defaultTurnaroundDays: unknown; workflow?: unknown },
): { ok: true; value: OperationsSettings } | { ok: false; error: string } {
  // Absent is the default, so a form that predates the setting cannot switch a
  // laundry back to the full workflow by leaving the field out.
  const workflow = posted.workflow === undefined || posted.workflow === null || posted.workflow === ""
    ? DEFAULT_OPERATIONS.workflow : posted.workflow;
  if (workflow !== "simplified" && workflow !== "full") {
    return { ok: false, error: "Choose the simplified or the full workflow." };
  }
  const text = String(posted.defaultTurnaroundDays ?? "").trim();
  if (!/^\d{1,2}$/.test(text)) {
    return { ok: false, error: `The turnaround is a whole number of days, ${TURNAROUND_MIN} to ${TURNAROUND_MAX}.` };
  }
  const days = Number(text);
  if (days > TURNAROUND_MAX) {
    return { ok: false, error: `The turnaround is a whole number of days, ${TURNAROUND_MIN} to ${TURNAROUND_MAX}.` };
  }
  return {
    ok: true,
    value: { workflow, plantStages: posted.plantStages === "on", defaultTurnaroundDays: days },
  };
}
