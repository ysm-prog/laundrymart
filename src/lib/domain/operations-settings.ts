/**
 * How this laundry works, as two settings (Darshan's review, Phase 3).
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
 * Stored in `tenants.settings.operations`, written through
 * `save_tenant_settings` (0057 adds the key). Nothing throws on a bad stored
 * value: it falls back to the default.
 */

export type OperationsSettings = {
  /** Show the plant: Linen › In the plant, its rail count and Today's tiles. */
  plantStages: boolean;
  /** Days from receipt to the promised return date, for a customer with no round. */
  defaultTurnaroundDays: number;
};

export const TURNAROUND_MIN = 0;
export const TURNAROUND_MAX = 30;

export const DEFAULT_OPERATIONS: OperationsSettings = {
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
    plantStages: typeof stored.plantStages === "boolean" ? stored.plantStages : DEFAULT_OPERATIONS.plantStages,
    defaultTurnaroundDays: typeof days === "number" && Number.isInteger(days)
      && days >= TURNAROUND_MIN && days <= TURNAROUND_MAX
      ? days : DEFAULT_OPERATIONS.defaultTurnaroundDays,
  };
}

/** Read the posted form into a value the writer accepts, or say what is wrong. */
export function readOperationsForm(
  posted: { plantStages: unknown; defaultTurnaroundDays: unknown },
): { ok: true; value: OperationsSettings } | { ok: false; error: string } {
  const text = String(posted.defaultTurnaroundDays ?? "").trim();
  if (!/^\d{1,2}$/.test(text)) {
    return { ok: false, error: `The turnaround is a whole number of days, ${TURNAROUND_MIN} to ${TURNAROUND_MAX}.` };
  }
  const days = Number(text);
  if (days > TURNAROUND_MAX) {
    return { ok: false, error: `The turnaround is a whole number of days, ${TURNAROUND_MIN} to ${TURNAROUND_MAX}.` };
  }
  return { ok: true, value: { plantStages: posted.plantStages === "on", defaultTurnaroundDays: days } };
}
