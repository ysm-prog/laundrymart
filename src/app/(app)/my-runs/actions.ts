"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability, requireSession, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { recordAudit } from "@/lib/audit";
import {
  describeDbError, done, fail, firstIssue, optionalText, optionalUuid,
  requiredDate, returnTo, toObject,
} from "@/lib/actions";
import { checkAssignable } from "@/lib/domain/run-assignment";
import { formatAdelaideDate, getAdelaideNow } from "@/lib/domain/timezone";
import { logOrderActivity } from "@/lib/orders/activity";
import { completeLaundryOrder } from "@/lib/orders/complete";
import type { OrderStatus } from "@/lib/domain/laundry-orders";

/**
 * Writes for My Runs: putting a Job on a Run, taking it off, and finishing it.
 *
 * Same shape as every other action file here — tenant from the session, Zod at
 * the edge, `return fail(...)` / `return done(...)` so the message rides the
 * flash cookie. Three rules are specific to this module:
 *
 * - **Assignment writes one column.** `laundry_orders.stop_id`, and nothing
 *   else. No status is touched, no laundry is touched, no customer record is
 *   touched. If you find yourself adding a second field to an assignment update
 *   here, the model has drifted.
 * - **Every guard is checked twice on purpose.** `checkAssignable()` runs here
 *   so the user gets a sentence; `guard_laundry_order_assignment()` runs in the
 *   database because this action is not the boundary.
 * - **Assignment is `routes.write`.** That is the existing "plan and assign"
 *   capability — the dispatcher's. No new capability and no new role were
 *   introduced for this feature.
 */

const MY_RUNS = "/my-runs";

/* ------------------------------------------------------------------ types */

type Supabase = Awaited<ReturnType<typeof createClient>>;

type AssignableOrder = {
  id: string;
  order_number: string;
  status: OrderStatus;
  delivery_required: boolean;
  customer_id: string;
  stop_id: string | null;
  due_date: string | null;
};

async function loadAssignable(supabase: Supabase, id: string): Promise<AssignableOrder | null> {
  const { data } = await supabase
    .from("laundry_orders")
    .select("id, order_number, status, delivery_required, customer_id, stop_id, due_date")
    .eq("id", id)
    .maybeSingle<AssignableOrder>();
  return data ?? null;
}

/* ------------------------------------------------------------ assignment */

const assignSchema = z.object({
  order_id: z.string().uuid("That job could not be found."),
  driver_id: z.string().uuid("Please choose a driver."),
  run_date: requiredDate,
  /** A specific run, when the driver has more than one on the day. */
  run_id: optionalUuid,
  note: optionalText,
});

/**
 * Put a job on a driver's run for a date — creating the run and the stop if the
 * day does not have them yet, and reusing both when it does.
 *
 * The find-or-create is the whole point of §23 and §27: a dispatcher assigning
 * six jobs to one customer on one morning must end up with one run, one stop and
 * six jobs under it, not six runs. So the lookups come first and creation is the
 * fallback, never the default.
 */
export async function assignJobToRun(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = assignSchema.safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const { order_id: orderId, driver_id: driverId, run_date: runDate } = parsed.data;
  const supabase = await createClient();

  const order = await loadAssignable(supabase, orderId);
  if (!order) return fail(backTo, "That job could not be found.");

  const reassigning = !!order.stop_id;
  const eligible = checkAssignable(order, { allowAssigned: true });
  if (!eligible.ok) return fail(backTo, eligible.reason);

  const driver = await activeDriver(supabase, driverId);
  if ("error" in driver) return fail(backTo, driver.error);

  const run = await resolveRun(supabase, session, {
    driverId, runDate, runId: parsed.data.run_id ?? null,
  });
  if ("error" in run) return fail(backTo, run.error);

  // Already exactly where it is being sent — say so rather than writing a
  // no-op and a misleading timeline entry.
  const previous = order.stop_id ? await describeAssignment(supabase, order.stop_id) : null;
  if (previous?.runId === run.id) {
    return fail(backTo,
      `Job ${order.order_number} is already on ${driver.full_name}'s ${run.code} run.`);
  }

  const stop = await findOrCreateStop(supabase, session, {
    run, customerId: order.customer_id,
  });
  if ("error" in stop) return fail(backTo, stop.error);

  // The conditional filter is the race guard (§27): two dispatchers pressing
  // Assign on the same job at the same moment cannot both win, because the
  // second one's UPDATE matches no row and returns nothing.
  const base = supabase
    .from("laundry_orders")
    .update({ stop_id: stop.id })
    .eq("id", order.id)
    .eq("tenant_id", session.tenantId);
  const { data: updated, error } = await (
    reassigning ? base.eq("stop_id", order.stop_id as string) : base.is("stop_id", null)
  ).select("id");
  if (error) return fail(backTo, describeDbError(error));
  if (!updated?.length) {
    return fail(backTo,
      "Somebody else changed this job's run a moment ago. Open it again to see where it is now.");
  }

  await logOrderActivity(supabase, session, order.id, {
    activity_type: reassigning ? "run_reassigned" : "run_assigned",
    previous: previous
      ? { driver: previous.driverName, run: previous.runCode, run_date: previous.runDate }
      : { driver: null, run: null },
    next: { driver: driver.full_name, run: run.code, run_date: runDate, stop: stop.job_number },
    note: parsed.data.note ?? null,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id,
    action: reassigning ? "reassign" : "assign",
    summary: `${order.order_number} → ${driver.full_name} ${run.code} ${runDate}`,
    metadata: { runId: run.id, stopId: stop.id, driverId, runDate, reassigning },
  });

  revalidatePath(MY_RUNS);
  revalidatePath("/orders");
  revalidatePath(`/orders/${order.id}`);
  revalidatePath(`/routes/daily/${run.id}`);

  const when = formatAdelaideDate(runDate, "medium");
  return done(backTo,
    reassigning
      ? `Job ${order.order_number} moved to ${driver.full_name} — ${run.code}, ${when}.`
      : `Job ${order.order_number} assigned to ${driver.full_name} — ${run.code}, ${when}.`,
    { href: `${MY_RUNS}?date=${runDate}&driver=${driverId}`, label: "See the run" });
}

/**
 * Take a job off a run.
 *
 * Dispatch only. The job keeps its status, its laundry, its customer and its
 * whole history — §28 is emphatic that this must not read as a cancellation,
 * and the only column that changes is the one that says which van it is on.
 */
export async function removeJobFromRun(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = z.object({
    order_id: z.string().uuid(),
    note: optionalText,
  }).safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const supabase = await createClient();
  const order = await loadAssignable(supabase, parsed.data.order_id);
  if (!order) return fail(backTo, "That job could not be found.");
  if (!order.stop_id) return fail(backTo, "That job is not on a run.");

  const previous = await describeAssignment(supabase, order.stop_id);

  const { error } = await supabase
    .from("laundry_orders")
    .update({ stop_id: null })
    .eq("id", order.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await logOrderActivity(supabase, session, order.id, {
    activity_type: "run_removed",
    previous: previous
      ? { driver: previous.driverName, run: previous.runCode, run_date: previous.runDate }
      : null,
    next: { driver: null, run: null },
    note: parsed.data.note ?? null,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id, action: "unassign",
    summary: `${order.order_number} taken off ${previous?.runCode ?? "its run"}`,
  });

  revalidatePath(MY_RUNS);
  revalidatePath("/orders");
  revalidatePath(`/orders/${order.id}`);
  return done(backTo,
    `Job ${order.order_number} is off the run and back in the unassigned queue. `
    + "Nothing else about it changed.");
}

/** An empty run for a driver on a date, for a day the templates did not cover. */
export async function createRunForDriver(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = z.object({
    driver_id: z.string().uuid("Please choose a driver."),
    run_date: requiredDate,
  }).safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const supabase = await createClient();
  const driver = await activeDriver(supabase, parsed.data.driver_id);
  if ("error" in driver) return fail(backTo, driver.error);

  const created = await createRun(supabase, session, parsed.data.driver_id, parsed.data.run_date);
  if ("error" in created) return fail(backTo, created.error);

  revalidatePath(MY_RUNS);
  revalidatePath("/routes/daily");
  return done(backTo,
    `Created run ${created.code} for ${driver.full_name} on `
    + `${formatAdelaideDate(parsed.data.run_date, "medium")}.`);
}

/* ------------------------------------------------------- driver's delivery */

/**
 * "Delivered" pressed at the customer's door.
 *
 * The permission model here is the one place this feature does anything
 * unusual, so it is worth being explicit. A driver holds no `orders.*`
 * capability at all — their world is their own run, and that is the existing
 * design, not an oversight. Rather than inventing a capability (and with it a
 * second permission system, which §3 forbids), authorisation is *resource*
 * based, exactly as `daily_routes` RLS already is:
 *
 *   - anyone holding `orders.status` may do this from any screen, as before; or
 *   - the caller holds `run.execute` **and** the job sits on a stop of a run
 *     whose driver is them.
 *
 * The second branch is re-derived from the database on every call, never from
 * the form, so a driver posting another driver's order id is refused rather
 * than merely not shown the button.
 */
export async function markJobDelivered(formData: FormData): Promise<void> {
  const session = await requireSession();
  const parsed = z.object({
    order_id: z.string().uuid(),
    note: optionalText,
  }).safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const supabase = await createClient();
  const order = await loadAssignable(supabase, parsed.data.order_id);
  if (!order) return fail(backTo, "That job could not be found.");

  const permitted = await mayCompleteOnTheRoad(supabase, session, order);
  if (!permitted.ok) return fail(backTo, permitted.reason);

  const result = await completeLaundryOrder(supabase, session, order, {
    at: getAdelaideNow().toISOString(),
    handledBy: session.userId,
    note: parsed.data.note ?? null,
    // On the road the laundry is demonstrably off the shelf and at the door, so
    // a job still sitting at "ready" is stepped through rather than refused.
    dispatchIfNeeded: true,
  });
  if (!result.ok) return fail(backTo, result.error);

  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id, action: "status_change",
    summary: `${order.order_number} delivered on the run`,
  });

  revalidatePath(MY_RUNS);
  revalidatePath("/orders");
  revalidatePath(`/orders/${order.id}`);
  return done(backTo, `Job ${order.order_number} marked delivered.`);
}

async function mayCompleteOnTheRoad(
  supabase: Supabase, session: Session, order: AssignableOrder,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (can(session.role, "orders.status")) return { ok: true };

  if (!can(session.role, "run.execute")) {
    return { ok: false, reason: `Your role (${session.role}) cannot complete a delivery.` };
  }
  if (!order.stop_id) {
    return { ok: false, reason: "That job is not on a run, so it cannot be delivered from here." };
  }

  const { data: driver } = await supabase
    .from("drivers").select("id").eq("user_id", session.userId)
    .is("deleted_at", null).maybeSingle<{ id: string }>();
  if (!driver) return { ok: false, reason: "Your login is not linked to a driver record." };

  const assignment = await describeAssignment(supabase, order.stop_id);
  if (assignment?.driverId !== driver.id) {
    return { ok: false, reason: "That job is on somebody else's run." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------- resolution */

async function activeDriver(
  supabase: Supabase, driverId: string,
): Promise<{ id: string; full_name: string } | { error: string }> {
  const { data } = await supabase
    .from("drivers").select("id, full_name, status")
    .eq("id", driverId).is("deleted_at", null)
    .maybeSingle<{ id: string; full_name: string; status: string }>();
  if (!data) return { error: "That driver could not be found." };
  if (data.status !== "active") {
    return { error: `${data.full_name} is not an active driver, so work cannot be assigned to them.` };
  }
  return { id: data.id, full_name: data.full_name };
}

type ResolvedRun = { id: string; code: string; route_date: string; depot_id: string | null;
                     driver_id: string | null; vehicle_id: string | null };

/**
 * The run a job is going on: the one that was chosen, the day's only open one,
 * or a new one.
 *
 * When a driver has several open runs on the date and none was named, this
 * refuses rather than guessing — "morning" and "afternoon" are different
 * promises to the customer, and picking one silently is how linen arrives at
 * 4pm for a gym that closes at noon.
 */
async function resolveRun(
  supabase: Supabase, session: Session,
  { driverId, runDate, runId }: { driverId: string; runDate: string; runId: string | null },
): Promise<ResolvedRun | { error: string }> {
  const { data: open } = await supabase
    .from("daily_routes")
    .select("id, code, route_date, depot_id, driver_id, vehicle_id, status")
    .eq("driver_id", driverId).eq("route_date", runDate)
    .is("deleted_at", null)
    .not("status", "in", "(closed,cancelled)")
    .order("code")
    .returns<Array<ResolvedRun & { status: string }>>();

  const runs = open ?? [];

  if (runId) {
    const chosen = runs.find((run) => run.id === runId);
    if (!chosen) {
      return { error: "That run is not open for this driver on this date. Choose another." };
    }
    return chosen;
  }

  if (runs.length === 1) return runs[0]!;
  if (runs.length > 1) {
    return { error: `That driver has ${runs.length} runs on this date — choose which one.` };
  }
  return createRun(supabase, session, driverId, runDate);
}

async function createRun(
  supabase: Supabase, session: Session, driverId: string, runDate: string,
): Promise<ResolvedRun | { error: string }> {
  // Numbered by the same atomic sequence every other number in this app uses,
  // so two dispatchers creating a run at the same moment cannot collide on
  // `uq_daily_routes_day`.
  const { data: code, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "run", p: "RUN" });
  if (numberError) return { error: describeDbError(numberError) };

  const { data: driver } = await supabase
    .from("drivers").select("depot_id").eq("id", driverId)
    .maybeSingle<{ depot_id: string | null }>();

  const { data: run, error } = await supabase
    .from("daily_routes")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      route_date: runDate,
      code: code as string,
      name: "Deliveries",
      driver_id: driverId,
      depot_id: driver?.depot_id ?? session.depotId,
      status: "planned",
    })
    .select("id, code, route_date, depot_id, driver_id, vehicle_id")
    .single<ResolvedRun>();
  if (error) return { error: describeDbError(error) };

  await recordAudit(session, {
    entity: "daily_route", entityId: run.id, action: "create",
    summary: `${run.code} for ${runDate}`,
  });
  return run;
}

/**
 * The stop this customer is visited at on this run — reused if the run already
 * calls there, created at the end of the route if it does not.
 *
 * This is what makes §16 work: several jobs for one business gather under one
 * stop card rather than producing a duplicate visit each. The lookup is by
 * customer, because a stop is a visit to a business and the driver knocks once.
 */
async function findOrCreateStop(
  supabase: Supabase, session: Session,
  { run, customerId }: { run: ResolvedRun; customerId: string },
): Promise<{ id: string; job_number: string } | { error: string }> {
  const { data: existing } = await supabase
    .from("jobs")
    .select("id, job_number, sequence, status")
    .eq("route_id", run.id).eq("customer_id", customerId)
    .is("deleted_at", null)
    .not("status", "in", "(cancelled)")
    .order("sequence")
    .returns<Array<{ id: string; job_number: string; sequence: number; status: string }>>();

  if (existing?.length) return { id: existing[0]!.id, job_number: existing[0]!.job_number };

  const { data: number, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "job", p: "JOB" });
  if (numberError) return { error: describeDbError(numberError) };

  // Where the run currently ends. A new call goes on the end rather than being
  // slotted into the middle — resequencing somebody's planned morning is the
  // dispatch planner's job, not a side effect of assigning one job.
  const { data: last } = await supabase
    .from("jobs").select("sequence")
    .eq("route_id", run.id).is("deleted_at", null)
    .order("sequence", { ascending: false }).limit(1)
    .maybeSingle<{ sequence: number }>();

  const { data: location } = await supabase
    .from("customer_locations")
    .select("id, is_primary")
    .eq("customer_id", customerId).eq("is_delivery", true)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();

  const { data: stop, error } = await supabase
    .from("jobs")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      route_id: run.id,
      depot_id: run.depot_id,
      customer_id: customerId,
      location_id: location?.id ?? null,
      driver_id: run.driver_id,
      vehicle_id: run.vehicle_id,
      job_number: number as string,
      scheduled_date: run.route_date,
      sequence: (last?.sequence ?? 0) + 1,
      service_type: "delivery",
      status: run.driver_id ? "assigned" : "scheduled",
    })
    .select("id, job_number")
    .single<{ id: string; job_number: string }>();
  if (error) return { error: describeDbError(error) };

  return stop;
}

/** Who currently has this job, read back through the one authoritative chain. */
async function describeAssignment(
  supabase: Supabase, stopId: string,
): Promise<{ runId: string; runCode: string; runDate: string;
             driverId: string | null; driverName: string } | null> {
  const { data } = await supabase
    .from("jobs")
    .select("route_id, daily_routes(id, code, route_date, driver_id, drivers(id, full_name))")
    .eq("id", stopId)
    .maybeSingle<{
      route_id: string | null;
      daily_routes: {
        id: string; code: string; route_date: string; driver_id: string | null;
        drivers: { id: string; full_name: string } | null;
      } | null;
    }>();

  const run = data?.daily_routes;
  if (!run) return null;
  return {
    runId: run.id,
    runCode: run.code,
    runDate: run.route_date,
    driverId: run.driver_id,
    driverName: run.drivers?.full_name ?? "an unassigned run",
  };
}
