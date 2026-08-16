import type { SupabaseClient } from "@supabase/supabase-js";
import { chooseDeliverySource, describeUnavailable } from "./delivery-stock";

/**
 * Book one delivery line out of stock.
 *
 * Shared by the office/driver action (`recordDelivery`) and the offline outbox
 * (`/api/sync`), for the reason `lib/routes/unload.ts` is shared by the two
 * unload paths: the two used to carry the same `in_transit → at_customer` move
 * copied out by hand, so a fix to one silently left the other broken — and the
 * offline one is the path a driver in a car park actually uses.
 *
 * Returns null on success, or a sentence to show the operator.
 */
export async function deliverLineFromStock(
  supabase: SupabaseClient,
  {
    tenantId, itemId, quantity, job, deliveryId, notes,
  }: {
    tenantId: string;
    itemId: string;
    quantity: number;
    job: { id: string; customer_id: string; vehicle_id: string | null; depot_id: string | null };
    deliveryId: string;
    notes?: string | null;
  },
): Promise<string | null> {
  if (quantity <= 0) return null;

  // Both pools in one read: the van's and the depot's. `maybeSingle` is wrong
  // here — a missing pool row is the ordinary case (nothing of this item has
  // ever been on that van), not an error.
  const { data: pools } = await supabase
    .from("inventory_pools")
    .select("state, quantity, vehicle_id, depot_id")
    .eq("tenant_id", tenantId)
    .eq("item_id", itemId)
    .eq("owner_type", "laundry_owned")
    .in("state", ["in_transit", "at_depot"]);

  const onVehicle = job.vehicle_id
    ? (pools ?? [])
        .filter((p) => p.state === "in_transit" && p.vehicle_id === job.vehicle_id)
        .reduce((total, p) => total + (p.quantity ?? 0), 0)
    : 0;
  const atDepot = job.depot_id
    ? (pools ?? [])
        .filter((p) => p.state === "at_depot" && p.depot_id === job.depot_id)
        .reduce((total, p) => total + (p.quantity ?? 0), 0)
    : 0;

  const source = chooseDeliverySource({
    quantity, onVehicle, atDepot,
    vehicleId: job.vehicle_id, depotId: job.depot_id,
  });

  if (source.from === null) {
    // Only now is the name worth a query: naming the item is what makes the
    // message actionable, and the happy path should not pay for it.
    const { data: item } = await supabase
      .from("items").select("name").eq("id", itemId).maybeSingle();
    return describeUnavailable(
      (item?.name as string | undefined) ?? "that item",
      quantity, source.onVehicle, source.atDepot,
    );
  }

  const { error } = await supabase.rpc("move_inventory", {
    p_tenant: tenantId,
    p_item: itemId,
    p_owner_type: "laundry_owned",
    p_quantity: quantity,
    p_from_state: source.from,
    p_to_state: "at_customer",
    p_reason: "delivery",
    p_from_customer: null,
    p_from_depot: source.from === "at_depot" ? source.depotId : null,
    p_from_vehicle: source.from === "in_transit" ? source.vehicleId : null,
    p_to_customer: job.customer_id,
    p_to_depot: null,
    p_to_vehicle: null,
    p_job: job.id,
    p_pickup: null,
    p_delivery: deliveryId,
    p_notes: notes ?? null,
  });

  return error ? error.message : null;
}
