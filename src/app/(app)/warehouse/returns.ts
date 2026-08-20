/**
 * What came back off a run, ready to be counted at the depot.
 *
 * A plain module rather than part of `actions.ts`, because that file is
 * `"use server"` and may only export async server actions — the count page and
 * the count action both need these reads.
 */

import { createClient } from "@/lib/supabase/server";

export type ReturnedItem = {
  itemId: string;
  name: string;
  sku: string;
  /** What the driver booked out of the customers on this run. */
  driverQuantity: number;
};

export type UncountedRun = {
  id: string;
  code: string;
  name: string | null;
  route_date: string;
  unloaded_at: string | null;
  depot_id: string | null;
  registration: string | null;
};

type PickupLineRow = {
  item_id: string;
  quantity: number;
  items: { name: string; sku: string } | null;
};

/**
 * The driver's own count for a run, summed per item.
 *
 * Only `quantity` counts: anything the driver marked damaged or missing at the
 * customer never entered the van, so it is not linen the depot can find on the
 * floor. Sorted by name because the operator reads this list against a trolley,
 * not against a database.
 */
export async function driverCountsForRoute(routeId: string): Promise<ReturnedItem[]> {
  const supabase = await createClient();

  const { data: pickups } = await supabase
    .from("pickups").select("id").eq("route_id", routeId)
    .returns<Array<{ id: string }>>();

  const pickupIds = (pickups ?? []).map((pickup) => pickup.id);
  if (pickupIds.length === 0) return [];

  const { data: lines } = await supabase
    .from("pickup_lines")
    .select("item_id, quantity, items(name, sku)")
    .in("pickup_id", pickupIds)
    .gt("quantity", 0)
    .returns<PickupLineRow[]>();

  const byItem = new Map<string, ReturnedItem>();
  for (const line of lines ?? []) {
    const existing = byItem.get(line.item_id);
    if (existing) {
      existing.driverQuantity += line.quantity;
      continue;
    }
    byItem.set(line.item_id, {
      itemId: line.item_id,
      name: line.items?.name ?? "Unknown item",
      sku: line.items?.sku ?? "",
      driverQuantity: line.quantity,
    });
  }

  return [...byItem.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Runs whose van has been unloaded but whose linen nobody has counted yet.
 *
 * "Not counted" is "has no batch": the unique index on (tenant, route) makes a
 * batch the single record that a run has been booked into the plant, so there
 * is no second flag to keep in step with it.
 */
export async function uncountedRuns(): Promise<UncountedRun[]> {
  const supabase = await createClient();

  const { data: runs } = await supabase
    .from("daily_routes")
    // daily_routes has two FKs to vehicles (vehicle_id, trailer_id), so the
    // embed must name the constraint or PostgREST rejects it with PGRST201.
    .select("id, code, name, route_date, unloaded_at, depot_id, " +
            "vehicles!daily_routes_vehicle_id_fkey(registration)")
    .not("unloaded_at", "is", null)
    .order("unloaded_at", { ascending: false })
    .limit(20)
    .returns<Array<Omit<UncountedRun, "registration"> & {
      vehicles: { registration: string } | null;
    }>>();

  const candidates = runs ?? [];
  if (candidates.length === 0) return [];

  const { data: counted } = await supabase
    .from("production_batches")
    .select("route_id")
    .in("route_id", candidates.map((run) => run.id))
    .is("deleted_at", null)
    .returns<Array<{ route_id: string | null }>>();

  const done = new Set((counted ?? []).map((batch) => batch.route_id));

  return candidates
    .filter((run) => !done.has(run.id))
    .map(({ vehicles, ...run }) => ({ ...run, registration: vehicles?.registration ?? null }));
}
