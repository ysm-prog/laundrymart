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
import { loadBoardDayJobs } from "@/lib/runs/my-runs";
import { assignOneJobToBoard, retireStopIfEmpty } from "@/lib/runs/assign";
import type { OrderStatus } from "@/lib/domain/laundry-orders";

/**
 * Writes for the assignment workflow: giving a job to a board for a day, taking
 * it back, confirming the load, starting the route, and finishing a delivery.
 *
 * Same shape as every other action file here — tenant from the session, Zod at
 * the edge, `return fail(...)` / `return done(...)` so the message rides the
 * flash cookie. Four rules are specific to this module:
 *
 * - **The assignment the user makes is a board and a date.** Nobody names a
 *   run. `resolveRun`/`findOrCreateStop` below keep the internal `daily_routes`
 *   and `jobs` rows in step because the depot load, the inventory unload sweep
 *   and the offline capture screen are all built on them — but that resolution
 *   is bookkeeping, it is never a question put to a person, and no run code
 *   appears in any message this file produces.
 * - **Assignment never touches the laundry.** Board, date, status and the
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
  assigned_board_id: string | null;
  assigned_delivery_date: string | null;
};

const ASSIGNABLE_COLUMNS =
  "id, order_number, status, delivery_required, customer_id, stop_id, due_date, " +
  "assigned_board_id, assigned_delivery_date";

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
 * board a moment ago", which was untrue and unactionable.
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
  board_id: z.string().uuid("Please select a Board."),
  assigned_delivery_date: requiredDate,
  note: optionalText,
});

/**
 * Give a job to a board for a delivery date.
 *
 * The whole user-facing action is the two answers in the schema above. What
 * happens underneath — finding the board's run for that day or opening one,
 * finding the stop that run already makes at this customer or adding one — is
 * resolved here so that assigning six jobs for one customer to one morning
 * produces one run, one stop and six jobs under it rather than six of each.
 *
 * Handles reassignment through the same path: the job keeps its identity, its
 * status and its history, and only the board, the date and the internal
 * placement move.
 */
export async function assignJobToBoard(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = assignSchema.safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const { order_id: orderId, board_id: boardId } = parsed.data;
  const deliveryDate = parsed.data.assigned_delivery_date;
  const supabase = await createClient();

  const order = await loadAssignable(supabase, session.tenantId, orderId);
  if (!order) return fail(backTo, await jobNotHere(supabase, session, orderId));

  const reassigning = !!order.assigned_board_id;

  // Reassigning a job that has already left is a management override, not an
  // ordinary dispatch decision: the round is holding it somewhere.
  if (order.status === "out_for_delivery" && !can(session.role, "orders.manage")) {
    return fail(backTo,
      `Job ${order.order_number} is already out for delivery. Only a manager can move it now.`);
  }

  const eligible = checkAssignable(order, { allowAssigned: true });
  if (!eligible.ok) return fail(backTo, eligible.reason);

  const board = await activeBoard(supabase, session.tenantId, boardId);
  if ("error" in board) return fail(backTo, board.error);

  if (order.assigned_board_id === boardId && order.assigned_delivery_date === deliveryDate) {
    return fail(backTo,
      `Job ${order.order_number} is already with ${board.name} for `
      + `${formatAdelaideDate(deliveryDate, "medium")}.`);
  }

  const previousBoardName = order.assigned_board_id
    ? (await boardName(supabase, session.tenantId, order.assigned_board_id))
    : null;
  // ---- the internal bookkeeping, which no user ever sees ------------------
  // Shared with the Runs screen's bulk move (`lib/runs/assign.ts`), so one job
  // and forty go through exactly the same write.
  const assigned = await assignOneJobToBoard(supabase, session, {
    orderId: order.id, boardId, deliveryDate,
    current: {
      status: order.status,
      assigned_board_id: order.assigned_board_id,
      stop_id: order.stop_id,
      customer_id: order.customer_id,
    },
  });
  if (!assigned.ok) {
    // The race case gets the sentence that names what to do about it; every
    // other failure is already a sentence.
    return fail(backTo, assigned.error.startsWith("somebody else")
      ? "Somebody else changed this job's board a moment ago. Open it again to see where it is now."
      : assigned.error);
  }

  await logOrderActivity(supabase, session, order.id, {
    activity_type: reassigning ? "run_reassigned" : "run_assigned",
    previous: {
      board: previousBoardName,
      assigned_delivery_date: order.assigned_delivery_date,
    },
    next: { board: board.name, assigned_delivery_date: deliveryDate },
    note: parsed.data.note ?? null,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id,
    action: reassigning ? "reassign" : "assign",
    summary: `${order.order_number} → ${board.name} ${deliveryDate}`,
    metadata: { boardId, deliveryDate, reassigning, runId: assigned.runId, stopId: assigned.stopId },
  });

  revalidateAssignmentScreens(order.id);

  const when = formatAdelaideDate(deliveryDate, "medium");
  return done(backTo,
    reassigning
      ? `Job ${order.order_number} moved to ${board.name} for ${when}.`
      : `Job ${order.order_number} assigned to ${board.name} for ${when}.`,
    { href: `${MY_RUNS}?date=${deliveryDate}&board=${boardId}`, label: "See the day" });
}

/**
 * Take a job's board and date away.
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

  const previousBoardName =
    await boardName(supabase, session.tenantId, order.assigned_board_id as string);
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
      board: previousBoardName,
      assigned_delivery_date: order.assigned_delivery_date,
      status: order.status,
    },
    next: { board: null, assigned_delivery_date: null, status: "ready_for_delivery" },
    note: parsed.data.note ?? null,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id, action: "unassign",
    summary: `${order.order_number} taken off ${previousBoardName ?? "its board"}`,
  });

  revalidateAssignmentScreens(order.id);
  return done(backTo,
    `Job ${order.order_number} is back in the ready-for-delivery queue. `
    + "Nothing else about it changed.");
}

/* --------------------------------------------------- the round's own day */

const daySchema = z.object({
  board_id: z.string().uuid(),
  date: requiredDate,
});

/**
 * Who may act on this round's day, re-derived from the database every time.
 *
 * A board may only ever act on its own — the `board_id` in the form is
 * checked against the boards row behind the login, so posting somebody
 * else's id is refused rather than merely not offered. `routes.write` (dispatch
 * and management) may act on anyone's, which is the existing convention for
 * looking at another round's day.
 */
async function mayWorkTheDay(
  supabase: Supabase, session: Session, boardId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (can(session.role, "routes.write")) return { ok: true };
  if (!can(session.role, "run.execute")) {
    return { ok: false, reason: `Your role (${session.role}) cannot work a delivery run.` };
  }

  const { data: own } = await supabase
    .from("boards").select("id")
    .eq("tenant_id", session.tenantId).eq("user_id", session.userId)
    .is("deleted_at", null).maybeSingle<{ id: string }>();
  if (!own) return { ok: false, reason: "Your login is not linked to a board." };
  if (own.id !== boardId) return { ok: false, reason: "That is another round's day." };
  return { ok: true };
}

/**
 * "Everything for this day is on the van."
 *
 * Replaces the vehicle inspection as the round's start-of-day action, and it is
 * deliberately not one: no checklist, no pass/fail, no defect capture, no
 * vehicle status. It records that the assigned laundry was loaded — a round,
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
  const permitted = await mayWorkTheDay(supabase, session, parsed.data.board_id);
  if (!permitted.ok) return fail(backTo, permitted.reason);

  const jobs = await loadBoardDayJobs(supabase, session.tenantId, parsed.data.board_id, parsed.data.date);
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
    entity: "laundry_order", entityId: parsed.data.board_id, action: "status_change",
    summary: `load confirmed: ${loadable.jobs.length} job(s) for ${parsed.data.date}`,
    metadata: { boardId: parsed.data.board_id, date: parsed.data.date, jobs: loadable.jobs.length },
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
 * that did not happen. The round confirms the load again to pick it up.
 */
export async function startDayRoute(formData: FormData): Promise<void> {
  const session = await requireSession();
  const parsed = daySchema.safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const supabase = await createClient();
  const permitted = await mayWorkTheDay(supabase, session, parsed.data.board_id);
  if (!permitted.ok) return fail(backTo, permitted.reason);

  const jobs = await loadBoardDayJobs(supabase, session.tenantId, parsed.data.board_id, parsed.data.date);
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
      note: "The round started the route for this day.",
    });
  }
  await recordAudit(session, {
    entity: "laundry_order", entityId: parsed.data.board_id, action: "status_change",
    summary: `route started: ${startable.jobs.length} job(s) out for ${parsed.data.date}`,
    metadata: { boardId: parsed.data.board_id, date: parsed.data.date },
  });

  revalidateAssignmentScreens();
  revalidatePath("/run");
  return done(backTo,
    `Route started — ${startable.jobs.length} `
    + `${startable.jobs.length === 1 ? "job is" : "jobs are"} out for delivery. Drive safely.`);
}

/* -------------------------------------------------------- round's delivery */

/**
 * "Delivered" pressed at the customer's door.
 *
 * The permission model here is the one place this feature does anything
 * unusual, so it is worth being explicit. A board holds no `orders.*`
 * capability at all — their world is their own work, and that is the existing
 * design, not an oversight. Rather than inventing a capability (and with it a
 * second permission system), authorisation is *resource* based, exactly as
 * `daily_routes` RLS already is:
 *
 *   - anyone holding `orders.status` may do this from any screen, as before; or
 *   - the caller holds `run.execute` **and** the job is assigned to them.
 *
 * The second branch is re-derived from the database on every call, never from
 * the form, so a board posting another round's order id is refused rather
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
  if (!order.assigned_board_id) {
    return { ok: false, reason: "That job is not assigned to a board, so it cannot be delivered from here." };
  }

  const { data: board } = await supabase
    .from("boards").select("id")
    .eq("tenant_id", session.tenantId).eq("user_id", session.userId)
    .is("deleted_at", null).maybeSingle<{ id: string }>();
  if (!board) return { ok: false, reason: "Your login is not linked to a board." };
  if (order.assigned_board_id !== board.id) {
    return { ok: false, reason: "That job is on another round." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------- resolution */

async function activeBoard(
  supabase: Supabase, tenantId: string, boardId: string,
): Promise<{ id: string; name: string } | { error: string }> {
  const { data } = await supabase
    .from("boards").select("id, name, status")
    .eq("tenant_id", tenantId)
    .eq("id", boardId).is("deleted_at", null)
    .maybeSingle<{ id: string; name: string; status: string }>();
  if (!data) return { error: "That board could not be found." };
  if (data.status !== "active") {
    return { error: `${data.name} is not an active board, so work cannot be assigned to it.` };
  }
  return { id: data.id, name: data.name };
}

async function boardName(
  supabase: Supabase, tenantId: string, boardId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("boards").select("name")
    .eq("tenant_id", tenantId).eq("id", boardId)
    .maybeSingle<{ name: string }>();
  return data?.name ?? null;
}

/**
 * Carry a day-level round action down onto the internal run rows.
 *
 * The run is what `/run`, the run sheet and — crucially — the inventory unload
 * sweep read, so a load confirmed or a route started on My Runs has to be true
 * there too. Failures are logged rather than surfaced: the jobs are the record
 * the round and the office both work from, and refusing a Start Route because a
 * bookkeeping row would not move is the wrong trade.
 */
/**
 * Record the depot load on the day's internal runs.
 *
 * **Only runs still at the depot, and only a timestamp that is not already
 * there.** `guard_route_transition` (0012) refuses a start without a confirmed
 * load and a close without an unload, but it does *not* refuse a backwards
 * move — so without the status filter, a round confirming a job assigned after
 * it had already left would set its moving run back to `load_confirmed`,
 * and the depot screen would offer to start a run that is halfway round the
 * suburbs. Confirming again for late work is deliberate (§22); falsifying the
 * first confirmation is not, which is why `load_confirmed_at` is written only
 * where it is still null — the same rule `setRouteStatus` has always used.
 */
async function stampDepotLoad(
  supabase: Supabase, session: Session,
  day: { board_id: string; date: string }, at: string,
): Promise<void> {
  const { error } = await supabase
    .from("daily_routes")
    .update({ load_confirmed_at: at, load_confirmed_by: session.userId, status: "load_confirmed" })
    .eq("board_id", day.board_id)
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
  day: { board_id: string; date: string }, at: string,
): Promise<void> {
  const { error } = await supabase
    .from("daily_routes")
    .update({ status: "in_progress", started_at: at })
    .eq("board_id", day.board_id)
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
