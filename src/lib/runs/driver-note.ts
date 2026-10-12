import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Write the assign forms' "Note for the driver" onto the job (2026-10-12).
 *
 * `laundry_orders.delivery_instructions` is the job's own instruction, which
 * `driverInstructions` puts first on My Runs. So a note written while assigning
 * reaches the round through the block that already exists, with no new column.
 *
 * Shared by the single Assign and the Runs screen's bulk move, for the reason
 * `lib/runs/assign.ts` is: one write, so the two cannot mean different things.
 *
 * **Tenant named, and the row count read back.** The id is posted (§23). 0025's
 * restrictive write layer refuses a caller outside it by matching **zero rows
 * with no error**, so an update that touched nothing is reported as a failure
 * rather than allowed to pass as "note saved".
 */
export async function saveDriverNote(
  supabase: SupabaseClient,
  tenantId: string,
  orderId: string,
  value: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("laundry_orders")
    .update({ delivery_instructions: value })
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .select("id");
  if (error) return { ok: false, error: "the note for the driver could not be saved" };
  if (!data || data.length === 0) {
    return { ok: false, error: "the note for the driver was not saved — your role cannot change this job" };
  }
  return { ok: true };
}
