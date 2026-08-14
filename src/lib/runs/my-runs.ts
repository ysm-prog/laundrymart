import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import type { Session } from "@/lib/auth/context";

/**
 * Reading a day's assigned work.
 *
 * Everything here is a composition over tables that already existed — no My Runs
 * table, no denormalised copy of a run onto a job. That is deliberate and it is
 * what makes §37 of the brief true for free: an assignment made in the Jobs
 * screen shows up here on the next render because there is only one place the
 * answer is stored.
 *
 * Three reads rather than one embedded query. PostgREST *can* reverse-embed
 * `laundry_orders` from `jobs`, but this app has already been bitten once by an
 * embed that compiled, tested and then failed at request time because a table
 * had two foreign keys to the same place (see the 2026-08-05 changelog). Three
 * plain `in` filters are boring, are covered by the indexes 0004 and 0015
 * declare, and cannot develop that class of fault.
 *
 * RLS does the security. A driver's session already sees only their own
 * `daily_routes`, only their own `jobs`, and — since 0015 — only the
 * `laundry_orders` sitting on their own stops. The explicit `driver_id` filter
 * below is a statement of intent, not the boundary.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type RunDriver = {
  id: string;
  full_name: string;
  status: string;
  phone: string | null;
};

export type RunJobItem = {
  item_type: string;
  custom_description: string | null;
  quantity_type: string;
  exact_quantity: number | null;
  bag_count: number | null;
  estimated_quantity: number | null;
  notes: string | null;
};

export type RunJob = {
  id: string;
  order_number: string;
  status: string;
  priority: string;
  delivery_required: boolean;
  due_date: string | null;
  delivery_window: string | null;
  expected_delivery_time: string | null;
  delivery_address: string | null;
  delivery_instructions: string | null;
  special_instructions: string | null;
  customer_id: string;
  stop_id: string | null;
  laundry_order_items: RunJobItem[];
};

export type RunStop = {
  id: string;
  job_number: string;
  sequence: number;
  service_type: string;
  status: string;
  progress_status: string;
  arrived_at: string | null;
  completed_at: string | null;
  notes: string | null;
  customers: {
    id: string; business_name: string; phone: string | null; special_instructions: string | null;
  } | null;
  customer_locations: {
    name: string; address_line1: string | null; suburb: string | null;
    state: string | null; postcode: string | null; access_notes: string | null;
  } | null;
  /** The laundry to hand over here. Empty on a collection-only stop. */
  jobs: RunJob[];
};

export type Run = {
  id: string;
  code: string;
  name: string;
  route_date: string;
  status: string;
  driver_id: string | null;
  vehicle_id: string | null;
  /** Recorded and surfaced, but not a gate on starting — see migration 0012. */
  inspection_id: string | null;
  load_confirmed_at: string | null;
  started_at: string | null;
  returned_at: string | null;
  unloaded_at: string | null;
  closed_at: string | null;
  notes: string | null;
  stops: RunStop[];
};

/* ------------------------------------------------------------- the driver */

/** The driver record behind a login, if there is one. */
export async function driverForUser(
  supabase: Supabase, userId: string,
): Promise<RunDriver | null> {
  const { data } = await supabase
    .from("drivers")
    .select("id, full_name, status, phone")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle<RunDriver>();
  return data ?? null;
}

/**
 * The drivers a manager may look at. Active only: a driver on leave or archived
 * cannot be given work, so offering them in a picker is offering a dead end.
 * An inactive driver whose *historical* runs are being reviewed still resolves
 * by id through `driverById`.
 */
export async function listActiveDrivers(supabase: Supabase): Promise<RunDriver[]> {
  const { data } = await supabase
    .from("drivers")
    .select("id, full_name, status, phone")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("full_name")
    .returns<RunDriver[]>();
  return data ?? [];
}

export async function driverById(supabase: Supabase, id: string): Promise<RunDriver | null> {
  const { data } = await supabase
    .from("drivers").select("id, full_name, status, phone")
    .eq("id", id).maybeSingle<RunDriver>();
  return data ?? null;
}

/**
 * Who this page is about, and whether the viewer may choose someone else.
 *
 * A driver is always themselves — §10 is explicit that they are never asked to
 * pick their own name, and the `?driver=` parameter is ignored for them rather
 * than merely hidden, so typing one into the address bar changes nothing. RLS
 * would refuse the rows anyway; this makes the screen say so honestly instead
 * of showing an empty day under someone else's name.
 *
 * `routes.write` is the existing "plan and assign" capability, which is exactly
 * the population that should be able to look at another driver's day. No new
 * capability and no new role.
 */
export async function resolveDriverScope(
  supabase: Supabase, session: Session, requested?: string,
): Promise<{
  driver: RunDriver | null;
  canChooseDriver: boolean;
  isSelf: boolean;
  drivers: RunDriver[];
}> {
  const own = await driverForUser(supabase, session.userId);
  const canChooseDriver = can(session.role, "routes.write");

  if (!canChooseDriver) {
    return { driver: own, canChooseDriver: false, isSelf: true, drivers: [] };
  }

  const drivers = await listActiveDrivers(supabase);
  if (!requested || requested === "me") {
    return { driver: own, canChooseDriver: true, isSelf: true, drivers };
  }

  const chosen = drivers.find((entry) => entry.id === requested)
    ?? await driverById(supabase, requested);
  return {
    driver: chosen,
    canChooseDriver: true,
    isSelf: !!own && chosen?.id === own.id,
    drivers,
  };
}

/* ---------------------------------------------------------------- the day */

/**
 * Every run this driver has on this date, with its stops in route order and the
 * laundry grouped under each stop.
 *
 * Note the plural throughout: nothing here assumes one run per driver per day.
 * The schema never did — `uq_daily_routes_day` is `(tenant, date, code)` — and a
 * morning van and an afternoon van are an ordinary week, so `/run`'s
 * `maybeSingle()` was quietly showing one of them and hiding the other.
 */
export async function loadRuns(
  supabase: Supabase, driverId: string, routeDate: string,
): Promise<Run[]> {
  const { data: routes } = await supabase
    .from("daily_routes")
    .select(
      "id, code, name, route_date, status, driver_id, vehicle_id, inspection_id, " +
      "load_confirmed_at, started_at, returned_at, unloaded_at, closed_at, notes",
    )
    .eq("driver_id", driverId)
    .eq("route_date", routeDate)
    .is("deleted_at", null)
    .order("code")
    .returns<Omit<Run, "stops">[]>();

  if (!routes?.length) return [];

  const stops = await loadStops(supabase, routes.map((route) => route.id));
  return routes.map((route) => ({
    ...route,
    stops: stops.filter((stop) => stop.routeId === route.id).map(({ routeId, ...stop }) => {
      void routeId;
      return stop;
    }),
  }));
}

type StopWithRoute = RunStop & { routeId: string };

async function loadStops(supabase: Supabase, routeIds: string[]): Promise<StopWithRoute[]> {
  const { data } = await supabase
    .from("jobs")
    .select(
      "id, route_id, job_number, sequence, service_type, status, progress_status, " +
      "arrived_at, completed_at, notes, " +
      "customers(id, business_name, phone, special_instructions), " +
      "customer_locations(name, address_line1, suburb, state, postcode, access_notes)",
    )
    .in("route_id", routeIds)
    .is("deleted_at", null)
    // The existing route order, not a new one. §16 is explicit that a second
    // sorting mechanism must not be invented where `sequence` already exists.
    .order("sequence")
    .returns<Array<Omit<StopWithRoute, "jobs" | "routeId"> & { route_id: string }>>();

  const stops = data ?? [];
  if (stops.length === 0) return [];

  const jobs = await loadJobsForStops(supabase, stops.map((stop) => stop.id));
  return stops.map(({ route_id, ...stop }) => ({
    ...stop,
    routeId: route_id,
    jobs: jobs.filter((job) => job.stop_id === stop.id),
  }));
}

export async function loadJobsForStops(supabase: Supabase, stopIds: string[]): Promise<RunJob[]> {
  if (stopIds.length === 0) return [];
  const { data } = await supabase
    .from("laundry_orders")
    .select(
      "id, order_number, status, priority, delivery_required, due_date, delivery_window, " +
      "expected_delivery_time, delivery_address, delivery_instructions, special_instructions, " +
      "customer_id, stop_id, " +
      "laundry_order_items(item_type, custom_description, quantity_type, exact_quantity, " +
      "bag_count, estimated_quantity, notes)",
    )
    .in("stop_id", stopIds)
    // Urgent laundry first inside a stop, then oldest promise first.
    .order("priority", { ascending: false })
    .order("due_date", { nullsFirst: false })
    .returns<RunJob[]>();
  return data ?? [];
}

/* ------------------------------------------------------- the unassigned --- */

export type UnassignedJob = RunJob & {
  customers: { id: string; business_name: string } | null;
};

/**
 * Delivery work that is ready to leave and on nobody's run.
 *
 * The dispatcher's queue, and the *only* list in this feature that reaches
 * beyond one driver's own rows — which is why it is gated on `routes.write` at
 * every call site. Customer pickups are excluded here as well as in the trigger
 * (§22): they are not delivery work, and a queue that offers them invites the
 * mistake the guard then has to refuse.
 */
export async function loadUnassignedDeliveryJobs(
  supabase: Supabase, options: { onOrBefore?: string; limit?: number } = {},
): Promise<UnassignedJob[]> {
  let query = supabase
    .from("laundry_orders")
    .select(
      "id, order_number, status, priority, delivery_required, due_date, delivery_window, " +
      "expected_delivery_time, delivery_address, delivery_instructions, special_instructions, " +
      "customer_id, stop_id, customers(id, business_name), " +
      "laundry_order_items(item_type, custom_description, quantity_type, exact_quantity, " +
      "bag_count, estimated_quantity, notes)",
    )
    .is("stop_id", null)
    .eq("delivery_required", true)
    .eq("status", "ready_for_delivery");

  // "Due by the day being planned" — including anything already late, which is
  // the work most in need of a van.
  if (options.onOrBefore) query = query.lte("due_date", options.onOrBefore);

  const { data } = await query
    .order("due_date", { nullsFirst: false })
    .limit(options.limit ?? 50)
    .returns<UnassignedJob[]>();
  return data ?? [];
}

/** The runs a job could be added to: this driver, this date, still open. */
export async function loadOpenRuns(
  supabase: Supabase, driverId: string, routeDate: string,
): Promise<Array<Pick<Run, "id" | "code" | "name" | "status">>> {
  const { data } = await supabase
    .from("daily_routes")
    .select("id, code, name, status")
    .eq("driver_id", driverId)
    .eq("route_date", routeDate)
    .is("deleted_at", null)
    .not("status", "in", "(closed,cancelled)")
    .order("code")
    .returns<Array<Pick<Run, "id" | "code" | "name" | "status">>>();
  return data ?? [];
}
