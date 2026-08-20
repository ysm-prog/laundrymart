import { createClient } from "@/lib/supabase/server";
import { describeDbError } from "@/lib/actions";

/**
 * Move everything still on a run's vehicle back into depot receiving.
 *
 * Shared by the driver's own unload on /run and by an office user unloading the
 * run on their behalf from /routes/daily/:id. Both paths have to make the same
 * inventory movements: a run marked unloaded without them leaves stock stranded
 * in `in_transit` on a vehicle that has already been reassigned.
 *
 * Returns a human-readable message on failure, or `null` on success.
 */
export async function sweepVehicleToDepot(
  tenantId: string,
  routeId: string,
): Promise<string | null> {
  const supabase = await createClient();

  const { data: route } = await supabase
    .from("daily_routes")
    .select("id, vehicle_id, depot_id")
    .eq("id", routeId).eq("tenant_id", tenantId)
    .maybeSingle();
  if (!route) return "That run could not be found.";
  if (!route.vehicle_id) return null;

  const { data: onboard } = await supabase
    .from("inventory_pools")
    .select("item_id, owner_type, quantity")
    .eq("state", "in_transit").eq("vehicle_id", route.vehicle_id).gt("quantity", 0);

  for (const pool of onboard ?? []) {
    const { error } = await supabase.rpc("move_inventory", {
      p_tenant: tenantId,
      p_item: pool.item_id,
      p_owner_type: pool.owner_type,
      p_quantity: pool.quantity,
      p_from_state: "in_transit",
      p_to_state: "at_depot",
      p_reason: "unload",
      p_from_customer: null,
      p_from_depot: null,
      p_from_vehicle: route.vehicle_id,
      p_to_customer: null,
      p_to_depot: route.depot_id,
      p_to_vehicle: null,
      p_job: null,
      p_pickup: null,
      p_delivery: null,
      p_notes: "run unload",
    });
    if (error) return describeDbError(error);
  }

  return null;
}
