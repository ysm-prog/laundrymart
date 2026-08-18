"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability, requireSession, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { recordAudit } from "@/lib/audit";
import {
  describeDbError, done, fail, firstIssue, optionalText,
  requiredDate, returnTo, toObject,
} from "@/lib/actions";
import {
  RUN_NOT_STARTED_STATUSES, checkAssignable, checkAssignmentRemovable,
  checkConfirmLoad, checkStartRoute,
} from "@/lib/domain/run-assignment";
import { formatAdelaideDate, getAdelaideNow } from "@/lib/domain/timezone";
import { logOrderActivity } from "@/lib/orders/activity";
import { completeLaundryOrder } from "@/lib/orders/complete";
import { loadDriverDayJobs } from "@/lib/runs/my-runs";
import type { OrderStatus } from "@/lib/domain/laundry-orders";

/**
 * Writes for the assignment workflow: giving a job to a driver for a day, taking
 * it back, confirming the load, starting the route, and finishing a delivery.
 *
 * Same shape as every other action file here — tenant from the session, Zod at
 * the edge, `return fail(...)` / `return done(...)` so the message rides the
 * flash cookie. Four rules are specific to this module:
 *
 * - **The assignment the user makes is a driver and a date.** Nobody names a
 *   run. `resolveRun`/`findOrCreateStop` below keep the internal `daily_routes`
 *   and `jobs` rows in step because the depot load, the inventory unload sweep
 *   and the offline capture screen are all built on them — but that resolution
 *   is bookkeeping, it is never a question put to a person, and no run code
 *   appears in any message this file produces.
 * - **Assignment never touches the laundry.** Driver, date, status and the
 *   internal placement. No customer, no items, no instructions, no priority, no
 *   address. If you find yourself adding one of those to an update here, the
 *   model has drifted.
 * - **Every guard is checked twice on purpose.** The `check*` helpers run here
 *   so the user gets a sentence; the guard triggers in migration 0016 run in the
 *   database because this action is not the boundary.
 * - **Assignment is `routes.write`.** The existing "plan and assign" capability.
 *   No new capability and no new role was introduced for this feature.
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
  assigned_driver_id: string | null;
  assigned_delivery_date: string | null;
};

const ASSIGNABLE_COLUMNS =
  "id, order_number, status, delivery_required, customer_id, stop_id, due_date, " +
  "assigned_driver_id, assigned_delivery_date";

async function loadAssignable(
  supabase: Supabase, tenantId: string, id: string,
): Promise<AssignableOrder | null> {
  const { data } = await supabase
    .from("laundry_orders")
    .select(ASSIGNABLE_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle<AssignableOrder>();
  return data ?? null;
}

/** Every screen that shows an assignment, refreshed together. */
function revalidateAssignmentScreens(orderId?: string): void {
  revalidatePath(MY_RUNS);
  revalidatePath("/orders");
  if (orderId) {
    revalidatePath(`/orders/${orderId}`);
    revalidatePath(`${MY_RUNS}/jobs/${orderId}`);
  }
}

/**
 * Why a job this laundry does not own could not be found.
 *
 * `loadAssignable` is scoped to the active laundry, so for ten of the eleven
 * roles a miss really is "no such job" — RLS would have refused it anyway. A
 * platform admin is the exception: their session reads *every* laundry (0019)
 * while every write here is filtered to the one they are working in, so they can
 * open a job they cannot act on. Before this, that combination produced a run
 * and a stop in the wrong business and then a tenant-filtered UPDATE that
 * matched nothing — reported to the user as "somebody else changed this job's
 * driver a moment ago", which was untrue and unactionable.
 *
 * One extra read, only on the failure path, to turn a dead end into an
 * instruction. Two plain queries rather than a `tenants(name)` embed: this repo
 * has been bitten by an embed that compiled and died at request time.
 */
async function jobNotHere(
  supabase: Supabase, session: Session, orderId: string,
): Promise<string> {
  const { data: order } = await supabase
    .from("laundry_orders").select("order_number, tenant_id").eq("id", orderId)
    .maybeSingle<{ order_number: string; tenant_id: string }>();
  if (!order || order.tenant_id === session.tenantId) return "That job could not be found.";

  const { data: owner } = await supabase
    .from("tenants").select("name").eq("id", order.tenant_id)
    .maybeSingle<{ name: string }>();

  return owner?.name
    ? `Job ${order.order_number} belongs to ${owner.name}. Switch laundry in the account `
      + "menu, then open the job again."
    : `Job ${order.order_number} belongs to another laundry. Switch laundry in the account `
      + "menu, then open the job again.";
}

/* ------------------------------------------------------------ assignment */

const assignSchema = z.object({
  order_id: z.string().uuid("That job could not be found."),
  driver_id: z.string().uuid("Please select a Driver."),
  assigned_delivery_date: requiredDate,
  note: optionalText,
});

/**
 * Give a job to a driver for a delivery date.
 *
 * The whole user-facing action is the two answers in the schema above. What
 * happens underneath — finding the driver's run for that day or opening one,
 * finding the stop that run already makes at this customer or adding one — is
 * resolved here so that assigning six jobs for one customer to one morning
 * produces one run, one stop and six jobs under it rather than six of each.
 *
 * Handles reassignment through the same path: the job keeps its identity, its
 * status and its history, and only the driver, the date and the internal
 * placement move.
 */
export async function assignJobToDriver(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = assignSchema.safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const { order_id: orderId, driver_id: driverId } = parsed.data;
  const deliveryDate = parsed.data.assigned_delivery_date;
  const supabase = await createClient();

  const order = await loadAssignable(supabase, session.tenantId, orderId);
  if (!order) return fail(backTo, await jobNotHere(supabase, session, orderId));

  const reassigning = !!order.assigned_driver_id;

  // Reassigning a job that has already left is a management override, not an
  // ordinary dispatch decision: the driver is holding it somewhere.
  if (order.status === "out_for_delivery" && !can(session.role, "orders.manage")) {
    return fail(backTo,
      `Job ${order.order_number} is already out for delivery. Only a manager can move it now.`);
  }

  const eligible = checkAssignable(order, { allowAssigned: true });
  if (!eligible.ok) return fail(backTo, eligible.reason);

  const driver = await activeDriver(supabase, session.tenantId, driverId);
  if ("error" in driver) return fail(backTo, driver.error);

  if (order.assigned_driver_id === driverId && order.assigned_delivery_date === deliveryDate) {
    return fail(backTo,
      `Job ${order.order_number} is already with ${driver.full_name} for `
      + `${formatAdelaideDate(deliveryDate, "medium")}.`);
  }

  const previousDriverName = order.assigned_driver_id
    ? (await driverName(supabase, session.tenantId, order.assigned_driver_id))
    : null;
  const previousStopId = order.stop_id;

  // ---- the internal bookkeeping, which no user ever sees ------------------
  const run = await resolveRun(supabase, session, { driverId, runDate: deliveryDate });
  if ("error" in run) return fail(backTo, run.error);

  const stop = await findOrCreateStop(supabase, session, { run, customerId: order.customer_id });
  if ("error" in stop) return fail(backTo, stop.error);

  // The conditional filter is the race guard: two people pressing Assign on the
  // same job at the same moment cannot both win, because the second one's
  // UPDATE matches no row and returns nothing.
  const base = supabase
    .from("laundry_orders")
    .update({
      assigned_driver_id: driverId,
      assigned_delivery_date: deliveryDate,
      assigned_at: getAdelaideNow().toISOString(),
      assigned_by: session.userId,
      stop_id: stop.id,
      // A job that changes hands has not been loaded onto the new van.
      load_confirmed_at: null,
      load_confirmed_by: null,
      // Only a fresh assignment moves the status; a reassignment of a job that
      // is already out keeps it out.
      ...(order.status === "ready_for_delivery" ? { status: "assigned" as const } : {}),
    })
    .eq("id", order.id)
    .eq("tenant_id", session.tenantId);

  const { data: updated, error } = await (
    reassigning
      ? base.eq("assigned_driver_id", order.assigned_driver_id as string)
      : base.is("assigned_driver_id", null)
  ).select("id");
  if (error) return fail(backTo, describeDbError(error));
  if (!updated?.length) {
    return fail(backTo,
      "Somebody else changed this job's driver a moment ago. Open it again to see where it is now.");
  }

  // A stop the job has just left, with nothing else to do at it, is a visit to
  // nowhere on somebody's morning. Retired quietly, and only when demonstrably
  // empty and untouched.
  if (previousStopId && previousStopId !== stop.id) {
    await retireStopIfEmpty(supabase, session, previousStopId);
  }

  await logOrderActivity(supabase, session, order.id, {
    activity_type: reassigning ? "run_reassigned" : "run_assigned",
    previous: {
      driver: previousDriverName,
      assigned_delivery_date: order.assigned_delivery_date,
    },
    next: { driver: driver.full_name, assigned_delivery_date: deliveryDate },
    note: parsed.data.note ?? null,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id,
    action: reassigning ? "reassign" : "assign",
    summary: `${order.order_number} → ${driver.full_name} ${deliveryDate}`,
    metadata: { driverId, deliveryDate, reassigning, runId: run.id, stopId: stop.id },
  });

  revalidateAssignmentScreens(order.id);

  const when = formatAdelaideDate(deliveryDate, "medium");
  return done(backTo,
    reassigning
      ? `Job ${order.order_number} moved to ${driver.full_name} for ${when}.`
      : `Job ${order.order_number} assigned to ${driver.full_name} for ${when}.`,
    { href: `${MY_RUNS}?date=${deliveryDate}&driver=${driverId}`, label: "See the day" });
}

/**
 * Take a job's driver and date away.
 *
 * The job goes back to Ready for delivery and into the unassigned queue with its
 * laundry, its customer and its whole history intact. This must never read as a
 * cancellation, which is why nothing here writes a reason, a cancelled state or
 * a completion — the only thing that changes is who was going to take it.
 *
 * The status move is what clears the assignment: `guard_laundry_order_transition`
 * nulls the four columns and the stop on `assigned → ready_for_delivery`, so the
 * database cannot be left holding half an assignment even if this action is
 * wrong about what it is writing.
 */
export async function removeJobAssignment(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = z.object({
    order_id: z.string().uuid(),
    note: optionalText,
  }).safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const supabase = await createClient();
  const order = await loadAssignable(supabase, session.tenantId, parsed.data.order_id);
  if (!order) return fail(backTo, await jobNotHere(supabase, session, parsed.data.order_id));

  const removable = checkAssignmentRemovable(order);
  if (!removable.ok) return fail(backTo, removable.reason);

  const previousDriverName =
    await driverName(supabase, session.tenantId, order.assigned_driver_id as string);
  const previousStopId = order.stop_id;

  const { error } = await supabase
    .from("laundry_orders")
    .update({ status: "ready_for_delivery" })
    .eq("id", order.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  if (previousStopId) await retireStopIfEmpty(supabase, session, previousStopId);

  await logOrderActivity(supabase, session, order.id, {
    activity_type: "run_removed",
    previous: {
      driver: previousDriverName,
      assigned_delivery_date: order.assigned_delivery_date,
      status: order.status,
    },
    next: { driver: null, assigned_delivery_date: null, status: "ready_for_delivery" },
    note: parsed.data.note ?? null,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id, action: "unassign",
    summary: `${order.order_number} taken off ${previousDriverName ?? "its driver"}`,
  });

  revalidateAssignmentScreens(order.id);
  return done(backTo,
    `Job ${order.order_number} is back in the ready-for-delivery queue. `
    + "Nothing else about it changed.");
}

/* -------------------------------------------------- the driver's own day */

const daySchema = z.object({
  driver_id: z.string().uuid(),
  date: requiredDate,
});

/**
 * Who may act on this driver's day, re-derived from the database every time.
 *
 * A driver may only ever act on their own — the `driver_id` in the form is
 * checked against the drivers row behind their login, so posting somebody
 * else's id is refused rather than merely not offered. `routes.write` (dispatch
 * and management) may act on anyone's, which is the existing convention for
 * looking at another driver's day.
 */
async function mayWorkTheDay(
  supabase: Supabase, session: Session, driverId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (can(session.role, "routes.write")) return { ok: true };
  if (!can(session.role, "run.execute")) {
    return { ok: false, reason: `Your role (${session.role}) cannot work a delivery run.` };
  }

  const { data: own } = await supabase
    .from("drivers").select("id")
    .eq("tenant_id", session.tenantId).eq("user_id", session.userId)
    .is("deleted_at", null).maybeSingle<{ id: string }>();
  if (!own) return { ok: false, reason: "Your login is not linked to a driver record." };
  if (own.id !== driverId) return { ok: false, reason: "That is somebody else's day." };
  return { ok: true };
}

/**
 * "Everything for this day is on the van."
 *
 * Replaces the vehicle inspection as the driver's start-of-day action, and it is
 * deliberately not one: no checklist, no pass/fail, no defect capture, no
 * vehicle status. It records that the assigned laundry was loaded — a driver,
 * a date, an instant and the jobs it covered.
 *
 * One activity row per job, and only for jobs it actually changed, so pressing
 * it twice adds nothing. The internal run for the day is stamped alongside,
 * because that is what the depot screen and the unload sweep read.
 */
export async function confirmDayLoad(formData: FormData): Promise<void> {
  const session = await requireSession();
  const parsed = daySchema.safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const supabase = await createClient();
  const permitted = await mayWorkTheDay(supabase, session, parsed.data.driver_id);
  if (!permitted.ok) return fail(backTo, permitted.reason);

  const jobs = await loadDriverDayJobs(supabase, session.tenantId, parsed.data.driver_id, parsed.data.date);
  const loadable = checkConfirmLoad(jobs);
  if (!loadable.ok) return fail(backTo, loadable.reason);

  const at = getAdelaideNow().toISOString();
  const { error } = await supabase
    .from("laundry_orders")
    .update({ load_confirmed_at: at, load_confirmed_by: session.userId })
    .in("id", loadable.jobs.map((job) => job.id))
    .eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await stampDepotLoad(supabase, session, parsed.data, at);

  for (const job of loadable.jobs) {
    await logOrderActivity(supabase, session, job.id, {
      activity_type: "status_changed",
      previous: { load_confirmed_at: null },
      next: { load_confirmed_at: at },
      note: "Confirmed as loaded for the day's deliveries.",
    });
  }
  await recordAudit(session, {
    entity: "laundry_order", entityId: parsed.data.driver_id, action: "status_change",
    summary: `load confirmed: ${loadable.jobs.length} job(s) for ${parsed.data.date}`,
    metadata: { driverId: parsed.data.driver_id, date: parsed.data.date, jobs: loadable.jobs.length },
  });

  revalidateAssignmentScreens();
  revalidatePath("/run");
  return done(backTo,
    `Load confirmed — ${loadable.jobs.length} ${loadable.jobs.length === 1 ? "job" : "jobs"} `
    + `ready to go out for ${formatAdelaideDate(parsed.data.date, "medium")}.`);
}

/**
 * "I'm on the road."
 *
 * Moves the day's *load-confirmed* jobs from Assigned to Out for delivery, which
 * is what removes the need for anybody in the office to press "mark out for
 * delivery". Work assigned after the load was confirmed is deliberately left
 * behind — it is not on the van, and sweeping it out would record a departure
 * that did not happen. The driver confirms the load again to pick it up.
 */
export async function startDayRoute(formData: FormData): Promise<void> {
  const session = await requireSession();
  const parsed = daySchema.safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const supabase = await createClient();
  const permitted = await mayWorkTheDay(supabase, session, parsed.data.driver_id);
  if (!permitted.ok) return fail(backTo, permitted.reason);

  const jobs = await loadDriverDayJobs(supabase, session.tenantId, parsed.data.driver_id, parsed.data.date);
  const startable = checkStartRoute(jobs);
  if (!startable.ok) return fail(backTo, startable.reason);

  const { error } = await supabase
    .from("laundry_orders")
    .update({ status: "out_for_delivery" })
    .in("id", startable.jobs.map((job) => job.id))
    .eq("tenant_id", session.tenantId)
    // Re-asserted at the write: the set was read a moment ago and the guard
    // trigger would refuse anything else anyway, but a filtered UPDATE cannot
    // move a job somebody else has just cancelled.
    .eq("status", "assigned");
  if (error) return fail(backTo, describeDbError(error));

  await stampRouteStarted(supabase, session, parsed.data, getAdelaideNow().toISOString());

  for (const job of startable.jobs) {
    await logOrderActivity(supabase, session, job.id, {
      activity_type: "status_changed",
      previous: { status: "assigned" },
      next: { status: "out_for_delivery" },
      note: "The driver started the route for this day.",
    });
  }
  await recordAudit(session, {
    entity: "laundry_order", entityId: parsed.data.driver_id, action: "status_change",
    summary: `route started: ${startable.jobs.length} job(s) out for ${parsed.data.date}`,
    metadata: { driverId: parsed.data.driver_id, date: parsed.data.date },
  });

  revalidateAssignmentScreens();
  revalidatePath("/run");
  return done(backTo,
    `Route started — ${startable.jobs.length} `
    + `${startable.jobs.length === 1 ? "job is" : "jobs are"} out for delivery. Drive safely.`);
}

/* ------------------------------------------------------- driver's delivery */

/**
 * "Delivered" pressed at the customer's door.
 *
 * The permission model here is the one place this feature does anything
 * unusual, so it is worth being explicit. A driver holds no `orders.*`
 * capability at all — their world is their own work, and that is the existing
 * design, not an oversight. Rather than inventing a capability (and with it a
 * second permission system), authorisation is *resource* based, exactly as
 * `daily_routes` RLS already is:
 *
 *   - anyone holding `orders.status` may do this from any screen, as before; or
 *   - the caller holds `run.execute` **and** the job is assigned to them.
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
  const order = await loadAssignable(supabase, session.tenantId, parsed.data.order_id);
  if (!order) return fail(backTo, await jobNotHere(supabase, session, parsed.data.order_id));

  const permitted = await mayCompleteOnTheRoad(supabase, session, order);
  if (!permitted.ok) return fail(backTo, permitted.reason);

  const result = await completeLaundryOrder(supabase, session, order, {
    at: getAdelaideNow().toISOString(),
    handledBy: session.userId,
    note: parsed.data.note ?? null,
    // On the road the laundry is demonstrably off the shelf and at the door, so
    // a job still sitting at "assigned" is stepped through rather than refused.
    dispatchIfNeeded: true,
  });
  if (!result.ok) return fail(backTo, result.error);

  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id, action: "status_change",
    summary: `${order.order_number} delivered`,
  });

  revalidateAssignmentScreens(order.id);
  return done(backTo, `Job ${order.order_number} marked delivered.`);
}

async function mayCompleteOnTheRoad(
  supabase: Supabase, session: Session, order: AssignableOrder,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (can(session.role, "orders.status")) return { ok: true };

  if (!can(session.role, "run.execute")) {
    return { ok: false, reason: `Your role (${session.role}) cannot complete a delivery.` };
  }
  if (!order.assigned_driver_id) {
    return { ok: false, reason: "That job is not assigned to a driver, so it cannot be delivered from here." };
  }

  const { data: driver } = await supabase
    .from("drivers").select("id")
    .eq("tenant_id", session.tenantId).eq("user_id", session.userId)
    .is("deleted_at", null).maybeSingle<{ id: string }>();
  if (!driver) return { ok: false, reason: "Your login is not linked to a driver record." };
  if (order.assigned_driver_id !== driver.id) {
    return { ok: false, reason: "That job is assigned to somebody else." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------- resolution */

async function activeDriver(
  supabase: Supabase, tenantId: string, driverId: string,
): Promise<{ id: string; full_name: string } | { error: string }> {
  const { data } = await supabase
    .from("drivers").select("id, full_name, status")
    .eq("tenant_id", tenantId)
    .eq("id", driverId).is("deleted_at", null)
    .maybeSingle<{ id: string; full_name: string; status: string }>();
  if (!data) return { error: "That driver could not be found." };
  if (data.status !== "active") {
    return { error: `${data.full_name} is not an active driver, so work cannot be assigned to them.` };
  }
  return { id: data.id, full_name: data.full_name };
}

async function driverName(
  supabase: Supabase, tenantId: string, driverId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("drivers").select("full_name")
    .eq("tenant_id", tenantId).eq("id", driverId)
    .maybeSingle<{ full_name: string }>();
  return data?.full_name ?? null;
}

type ResolvedRun = {
  id: string; code: string; route_date: string; depot_id: string | null;
  driver_id: string | null; vehicle_id: string | null;
};

/**
 * The internal run for a driver on a date — reused if one is open, opened if not.
 *
 * **Nobody is ever asked about this.** The run used to be a choice put to the
 * dispatcher when a driver had more than one open on a day; under the simplified
 * model there is no run in the user's vocabulary to choose between, so the
 * earliest open one wins deterministically. A driver working a morning and an
 * afternoon van still has both runs — the day's work simply gathers on the first
 * of them, which is the same answer the old screen defaulted to when there was
 * only one.
 */
async function resolveRun(
  supabase: Supabase, session: Session,
  { driverId, runDate }: { driverId: string; runDate: string },
): Promise<ResolvedRun | { error: string }> {
  const { data: open } = await supabase
    .from("daily_routes")
    .select("id, code, route_date, depot_id, driver_id, vehicle_id")
    .eq("tenant_id", session.tenantId)
    .eq("driver_id", driverId).eq("route_date", runDate)
    .is("deleted_at", null)
    .not("status", "in", "(closed,cancelled)")
    .order("code")
    .limit(1)
    .returns<ResolvedRun[]>();

  if (open?.length) return open[0]!;
  return createRun(supabase, session, driverId, runDate);
}

async function createRun(
  supabase: Supabase, session: Session, driverId: string, runDate: string,
): Promise<ResolvedRun | { error: string }> {
  // Numbered by the same atomic sequence every other number in this app uses,
  // so two people assigning at the same moment cannot collide on
  // `uq_daily_routes_day`. The code is internal — it is never shown.
  const { data: code, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "run", p: "RUN" });
  if (numberError) return { error: describeDbError(numberError) };

  const { data: driver } = await supabase
    .from("drivers").select("depot_id")
    .eq("tenant_id", session.tenantId).eq("id", driverId)
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
    summary: `${run.code} for ${runDate} (created automatically on assignment)`,
  });
  return run;
}

/**
 * The stop this customer is visited at on this run — reused if the run already
 * calls there, added at the end of the route if it does not.
 *
 * Several jobs for one business gather under one visit rather than producing a
 * duplicate call each. The lookup is by customer, because a stop is a visit to a
 * business and the driver knocks once.
 */
async function findOrCreateStop(
  supabase: Supabase, session: Session,
  { run, customerId }: { run: ResolvedRun; customerId: string },
): Promise<{ id: string; job_number: string } | { error: string }> {
  const { data: existing } = await supabase
    .from("jobs")
    .select("id, job_number")
    .eq("tenant_id", session.tenantId)
    .eq("route_id", run.id).eq("customer_id", customerId)
    .is("deleted_at", null)
    .not("status", "in", "(cancelled)")
    .order("sequence")
    .limit(1)
    .returns<Array<{ id: string; job_number: string }>>();

  if (existing?.length) return existing[0]!;

  const { data: number, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "job", p: "JOB" });
  if (numberError) return { error: describeDbError(numberError) };

  // Where the run currently ends. A new call goes on the end rather than being
  // slotted into the middle.
  const { data: last } = await supabase
    .from("jobs").select("sequence")
    .eq("tenant_id", session.tenantId)
    .eq("route_id", run.id).is("deleted_at", null)
    .order("sequence", { ascending: false }).limit(1)
    .maybeSingle<{ sequence: number }>();

  const { data: location } = await supabase
    .from("customer_locations")
    .select("id")
    .eq("tenant_id", session.tenantId)
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

/**
 * Soft-delete a stop a job has just left, but only if it is demonstrably empty.
 *
 * "Empty" is strict on purpose: no other laundry order points at it, the driver
 * has not started it, and no paperwork has been recorded against it. Anything
 * else is a real visit with a real history, and it stays. A failure here is
 * cosmetic — a stale empty stop is untidy, a lost one is not recoverable — so it
 * is logged rather than surfaced.
 */
async function retireStopIfEmpty(
  supabase: Supabase, session: Session, stopId: string,
): Promise<void> {
  const { count: remaining } = await supabase
    .from("laundry_orders")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenantId)
    .eq("stop_id", stopId);
  if ((remaining ?? 0) > 0) return;

  const { data: stop } = await supabase
    .from("jobs")
    .select("id, status, progress_status, arrived_at, completed_at, service_type")
    .eq("tenant_id", session.tenantId)
    .eq("id", stopId).is("deleted_at", null)
    .maybeSingle<{
      id: string; status: string; progress_status: string;
      arrived_at: string | null; completed_at: string | null; service_type: string;
    }>();
  if (!stop) return;
  // Only the stops this feature creates, and only untouched ones.
  if (stop.service_type !== "delivery") return;
  if (stop.progress_status !== "not_started") return;
  if (stop.arrived_at || stop.completed_at) return;
  if (!["scheduled", "assigned"].includes(stop.status)) return;

  const { count: paperwork } = await supabase
    .from("deliveries")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenantId)
    .eq("job_id", stopId);
  if ((paperwork ?? 0) > 0) return;

  const { error } = await supabase
    .from("jobs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", stopId).eq("tenant_id", session.tenantId);
  if (error) console.error("retiring an emptied stop failed", { stopId, error: error.message });
}

/**
 * Carry a day-level driver action down onto the internal run rows.
 *
 * The run is what `/run`, the run sheet and — crucially — the inventory unload
 * sweep read, so a load confirmed or a route started on My Runs has to be true
 * there too. Failures are logged rather than surfaced: the jobs are the record
 * the driver and the office both work from, and refusing a driver's Start Route
 * because a bookkeeping row would not move is the wrong trade.
 */
/**
 * Record the depot load on the day's internal runs.
 *
 * **Only runs still at the depot, and only a timestamp that is not already
 * there.** `guard_route_transition` (0012) refuses a start without a confirmed
 * load and a close without an unload, but it does *not* refuse a backwards
 * move — so without the status filter, a driver confirming a job assigned after
 * they had already left would set their moving run back to `load_confirmed`,
 * and the depot screen would offer to start a run that is halfway round the
 * suburbs. Confirming again for late work is deliberate (§22); falsifying the
 * first confirmation is not, which is why `load_confirmed_at` is written only
 * where it is still null — the same rule `setRouteStatus` has always used.
 */
async function stampDepotLoad(
  supabase: Supabase, session: Session,
  day: { driver_id: string; date: string }, at: string,
): Promise<void> {
  const { error } = await supabase
    .from("daily_routes")
    .update({ load_confirmed_at: at, load_confirmed_by: session.userId, status: "load_confirmed" })
    .eq("driver_id", day.driver_id)
    .eq("route_date", day.date)
    .eq("tenant_id", session.tenantId)
    .is("deleted_at", null)
    .in("status", [...RUN_NOT_STARTED_STATUSES])
    .is("load_confirmed_at", null);
  if (error) {
    console.error("recording the depot load failed", { date: day.date, error: error.message });
  }
}

/**
 * Mark the day's internal runs as away.
 *
 * Filtered to runs that have **not already started**, so a second Start Route —
 * which the late-work flow above makes an ordinary thing to press — cannot
 * rewrite the moment the driver actually left. `started_at` is a record of
 * something that happened, and the guard's own `coalesce` does not protect it
 * when the caller passes a value.
 *
 * Also filtered to runs whose load *is* confirmed. A run opened by an
 * assignment made after the load has none, and `guard_route_transition` would
 * refuse it — taking the whole statement, and with it the runs that legitimately
 * should have started, down with it.
 */
async function stampRouteStarted(
  supabase: Supabase, session: Session,
  day: { driver_id: string; date: string }, at: string,
): Promise<void> {
  const { error } = await supabase
    .from("daily_routes")
    .update({ status: "in_progress", started_at: at })
    .eq("driver_id", day.driver_id)
    .eq("route_date", day.date)
    .eq("tenant_id", session.tenantId)
    .is("deleted_at", null)
    .is("started_at", null)
    .not("load_confirmed_at", "is", null)
    .not("status", "in", "(closed,cancelled)");
  if (error) {
    console.error("starting the day's runs failed", { date: day.date, error: error.message });
  }
}
