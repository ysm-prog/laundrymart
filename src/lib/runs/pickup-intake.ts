import type { createClient } from "@/lib/supabase/server";
import {
  intakeItemsFromPickup, type PickupIntake, type PickupItem,
} from "@/lib/domain/pickup-intake";

/**
 * A collection, read for the counter to take in as laundry.
 *
 * Everything that *decides* is in `lib/domain/pickup-intake.ts`; this module is
 * the reads, which is the half no unit test can reach. The write is
 * `createOrder` — unchanged apart from carrying the link, so laundry is still
 * taken in through one door.
 *
 * **The tenant is named on every read** (§23). A platform admin's session reads
 * every laundry, and the customer id and the item ids that come back here are
 * posted straight into a job scoped to one — so an unfiltered read would offer
 * one business's collection to a counter working in another, which the guard
 * would then refuse with a sentence nobody could act on.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type CollectionToTakeIn = {
  id: string;
  customerId: string;
  customerName: string;
  /** The stop it was collected at, so the job can point back at the visit. */
  stopId: string;
  pickupDate: string | null;
  completedAt: string | null;
  driverId: string | null;
  driverName: string | null;
  bagCount: number;
  totalWeightKg: number | null;
  notes: string | null;
  /** The job it has already been taken in as, if it has. */
  takenInAs: { id: string; orderNumber: string } | null;
} & PickupIntake;

type PickupRow = {
  id: string; job_id: string; customer_id: string;
  pickup_date: string | null; completed_at: string | null;
  driver_id: string | null; bag_count: number; total_weight_kg: number | null;
  notes: string | null;
  customers: { business_name: string } | null;
  drivers: { full_name: string } | null;
  pickup_lines: Array<{
    item_id: string; quantity: number; damaged_quantity: number;
    missing_quantity: number; notes: string | null;
  }>;
};

/**
 * One collection, with the laundry rows it would seed and what it could not.
 *
 * Null when there is no such collection in this laundry — which is the same
 * answer as one belonging to another business, deliberately: the counter cannot
 * act on either, and telling them apart would confirm that something is behind
 * an id they were not given.
 */
export async function collectionToTakeIn(
  supabase: Supabase, tenantId: string, pickupId: string,
): Promise<CollectionToTakeIn | null> {
  const { data: pickup } = await supabase
    .from("pickups")
    .select("id, job_id, customer_id, pickup_date, completed_at, driver_id, bag_count, " +
            "total_weight_kg, notes, customers(business_name), drivers(full_name), " +
            "pickup_lines(item_id, quantity, damaged_quantity, missing_quantity, notes)")
    .eq("tenant_id", tenantId)
    .eq("id", pickupId)
    .maybeSingle<PickupRow>();
  if (!pickup) return null;

  const lines = pickup.pickup_lines ?? [];
  const [items, takenInAs] = await Promise.all([
    // Only the items this collection actually names, and *whatever their
    // status* — an item since retired has to be nameable in the notice saying
    // why its line was left off, which a catalogue filtered to active ones
    // cannot do.
    pickupItems(supabase, tenantId, lines.map((line) => line.item_id)),
    takenInJob(supabase, tenantId, pickup.id),
  ]);

  return {
    id: pickup.id,
    customerId: pickup.customer_id,
    customerName: pickup.customers?.business_name ?? "This customer",
    stopId: pickup.job_id,
    pickupDate: pickup.pickup_date,
    completedAt: pickup.completed_at,
    driverId: pickup.driver_id,
    driverName: pickup.drivers?.full_name ?? null,
    bagCount: pickup.bag_count,
    totalWeightKg: pickup.total_weight_kg,
    notes: pickup.notes,
    takenInAs,
    ...intakeItemsFromPickup(lines, items),
  };
}

async function pickupItems(
  supabase: Supabase, tenantId: string, itemIds: string[],
): Promise<Map<string, PickupItem>> {
  const wanted = [...new Set(itemIds)];
  if (wanted.length === 0) return new Map();

  const { data } = await supabase
    .from("items")
    .select("id, item_code, name, laundry_category, status, deleted_at")
    .eq("tenant_id", tenantId)
    .in("id", wanted)
    .returns<Array<{
      id: string; item_code: string | null; name: string;
      laundry_category: string | null; status: string; deleted_at: string | null;
    }>>();

  return new Map((data ?? []).map((item) => [item.id, {
    id: item.id,
    item_code: item.item_code,
    name: item.name,
    laundry_category: item.laundry_category,
    // The same filter the job form's own catalogue uses, so "pickable" here and
    // "in the picker" there cannot disagree.
    pickable: item.status === "active" && item.deleted_at === null,
  }]));
}

/**
 * The live job this collection is already on, if any.
 *
 * A **cancelled** job does not count, matching `uq_laundry_orders_source_pickup`
 * exactly: cancelling is how a take-in against the wrong customer is undone, and
 * the collection is then still sitting there needing to be taken in. A reader
 * that disagreed with the index would either offer a link the database refuses
 * or hide one it would accept.
 */
async function takenInJob(
  supabase: Supabase, tenantId: string, pickupId: string,
): Promise<{ id: string; orderNumber: string } | null> {
  const { data } = await supabase
    .from("laundry_orders")
    .select("id, order_number")
    .eq("tenant_id", tenantId)
    .eq("source_pickup_id", pickupId)
    .neq("status", "cancelled")
    .maybeSingle<{ id: string; order_number: string }>();
  return data ? { id: data.id, orderNumber: data.order_number } : null;
}

/**
 * How many collection ids go into one `.in()`.
 *
 * A uuid is 36 characters and supabase-js sends a filtered read as a **GET**, so
 * the ids ride in the query string: the Collections list caps at 200, which is
 * ~7.5 kB of URL — inside most limits and not by much, and the shape that took
 * the due-collections list down when it was 400. Two bounded round trips beat
 * one that fails only on the busiest day.
 */
const ID_BATCH = 100;

/**
 * Which of a page of collections are already on a job.
 *
 * Batched reads rather than one per row: the question is "are any of these on a
 * job?", and the answer for a hundred of them is a single filtered select.
 */
export async function takenInByPickup(
  supabase: Supabase, tenantId: string, pickupIds: string[],
): Promise<Map<string, { id: string; orderNumber: string }>> {
  const wanted = [...new Set(pickupIds)];
  const found = new Map<string, { id: string; orderNumber: string }>();

  for (let at = 0; at < wanted.length; at += ID_BATCH) {
    const { data } = await supabase
      .from("laundry_orders")
      .select("id, order_number, source_pickup_id")
      .eq("tenant_id", tenantId)
      .in("source_pickup_id", wanted.slice(at, at + ID_BATCH))
      .neq("status", "cancelled")
      .returns<Array<{ id: string; order_number: string; source_pickup_id: string }>>();
    for (const job of data ?? []) {
      found.set(job.source_pickup_id, { id: job.id, orderNumber: job.order_number });
    }
  }
  return found;
}
