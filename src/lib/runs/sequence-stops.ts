import type { createClient } from "@/lib/supabase/server";
import { loadRunDay } from "@/lib/runs/run-day";
import type { SequenceStop } from "@/app/(app)/runs/sequence";

/**
 * A board's day, read as the ordering board needs to draw it.
 *
 * **Shared because two screens now order the same run.** The Runs screen is
 * where a day is planned; My Runs is where a manager is standing when they
 * notice the round should call at the school before the hotel. Two reads of
 * "what is on this run, and in what order" would be two answers waiting to
 * disagree — and the version they render with is the version the save is
 * checked against, so a second query here would be a concurrency bug rather
 * than a duplication.
 *
 * The tenant is a **required argument** rather than left to RLS, the convention
 * `run-day.ts` and `my-runs.ts` already hold: a platform admin's session reads
 * every laundry (0019), and every stop id read here is posted back into a write
 * scoped to one.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

type StopRow = {
  id: string;
  sequence: number;
  status: string;
  progress_status: string;
  customers: { id: string; business_name: string } | null;
  customer_locations: {
    address_line1: string | null; suburb: string | null; state: string | null;
  } | null;
};

type JobRow = {
  id: string; order_number: string; stop_id: string;
  laundry_order_items: Array<{ id: string }>;
};

export type BoardSequence = {
  /** The runs the day is spread over — one normally, two for a split shift. */
  routeIds: string[];
  /** The order's concurrency token, as the page rendered with it. */
  version: number;
  stops: SequenceStop[];
  /** Every job on the day, counted once. */
  jobCount: number;
  /** Stops the round has already been to, which cannot move. */
  workedCount: number;
};

export async function loadBoardSequence(
  supabase: Supabase, tenantId: string, boardId: string, date: string,
): Promise<BoardSequence> {
  const day = await loadRunDay(supabase, tenantId, boardId, date);
  const stops = await loadSequenceStops(supabase, tenantId, day.routeIds);
  return {
    routeIds: day.routeIds,
    version: day.version,
    stops,
    jobCount: stops.reduce((total, stop) => total + stop.jobs.length, 0),
    workedCount: stops.filter((stop) => stop.progress_status !== "not_started").length,
  };
}

/** The stops on a set of runs, in stored order, with their laundry under them. */
export async function loadSequenceStops(
  supabase: Supabase, tenantId: string, routeIds: readonly string[],
): Promise<SequenceStop[]> {
  if (routeIds.length === 0) return [];

  const { data: stopRows } = await supabase
    .from("jobs")
    .select("id, sequence, status, progress_status, customers(id, business_name), " +
            "customer_locations(address_line1, suburb, state)")
    .eq("tenant_id", tenantId)
    .in("route_id", routeIds)
    .is("deleted_at", null)
    .order("sequence")
    .returns<StopRow[]>();

  const stops = stopRows ?? [];
  if (stops.length === 0) return [];

  // One read for every stop's laundry rather than one per stop.
  const { data: jobRows } = await supabase
    .from("laundry_orders")
    .select("id, order_number, stop_id, laundry_order_items(id)")
    .eq("tenant_id", tenantId)
    .in("stop_id", stops.map((stop) => stop.id))
    .not("status", "in", "(cancelled)")
    .order("order_number")
    .returns<JobRow[]>();

  const jobsByStop = new Map<string, SequenceStop["jobs"]>();
  for (const job of jobRows ?? []) {
    const bucket = jobsByStop.get(job.stop_id) ?? [];
    bucket.push({
      id: job.id,
      orderNumber: job.order_number,
      itemCount: job.laundry_order_items?.length ?? 0,
    });
    jobsByStop.set(job.stop_id, bucket);
  }

  return stops.map((stop) => ({
    id: stop.id,
    status: stop.status,
    progress_status: stop.progress_status,
    customerName: stop.customers?.business_name ?? "Unknown customer",
    address: [
      stop.customer_locations?.address_line1,
      stop.customer_locations?.suburb,
      stop.customer_locations?.state,
    ].filter(Boolean).join(", ") || null,
    jobs: jobsByStop.get(stop.id) ?? [],
  }));
}
