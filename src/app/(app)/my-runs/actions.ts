"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability, requireSession, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { recordAudit } from "@/lib/audit";
import {
  checkbox, describeDbError, done, fail, firstIssue, optionalText, optionalUuid,
  requiredDate, returnTo, toObject,
} from "@/lib/actions";
import {
  RUN_NOT_STARTED_STATUSES, checkAssignable, checkAssignmentRemovable, checkStartMyDay,
} from "@/lib/domain/run-assignment";
import { formatAdelaideDate, getAdelaideNow } from "@/lib/domain/timezone";
import { logOrderActivity } from "@/lib/orders/activity";
import { completeLaundryOrder, type DeliveryProof } from "@/lib/orders/complete";
import {
  RECEIVED_BY_MAX, isDeliveryProofPath, readDeliveredQuantities,
} from "@/lib/domain/automation";
import { loadBoardDayJobs, type RunJobItem } from "@/lib/runs/my-runs";
import { assignOneJobToBoard, retireStopIfEmpty } from "@/lib/runs/assign";
import { saveDriverNote } from "@/lib/runs/driver-note";
import {
  DRIVER_NOTE_FIELD, DRIVER_NOTE_MAX, readDriverNote,
} from "@/lib/domain/driver-instructions";
import { describeItem, type OrderStatus } from "@/lib/domain/laundry-orders";

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
  /** Read so the assign form's note is only written when it changed. */
  delivery_instructions: string | null;
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
  "assigned_board_id, assigned_delivery_date, delivery_instructions";

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
  // The single form opens showing the current instruction, so emptying the box
  // clears it — see `readDriverNote`.
  const note = readDriverNote(formData.get(DRIVER_NOTE_FIELD), { blankClears: true });
  if (note.kind === "too_long") {
    return fail(backTo, `Keep the note for the driver to ${DRIVER_NOTE_MAX} characters.`);
  }
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
    // Same board, same day: the only thing that can have changed is the note.
    // Saving it is the whole of the press, rather than refusing the form.
    if (note.kind === "set" && note.value !== (order.delivery_instructions ?? null)) {
      const saved = await saveDriverNote(supabase, session.tenantId, order.id, note.value);
      if (!saved.ok) return fail(backTo, `Job ${order.order_number}: ${saved.error}.`);
      revalidateAssignmentScreens(order.id);
      return done(backTo, note.value
        ? `Note for the driver saved on job ${order.order_number}.`
        : `Note for the driver cleared on job ${order.order_number}.`);
    }
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

  // The note goes on after the assignment, so a refused assignment writes
  // nothing. A note that will not save is said rather than swallowed: the job is
  // assigned, and the round would otherwise go without the instruction.
  let noteProblem: string | null = null;
  if (note.kind === "set" && note.value !== (order.delivery_instructions ?? null)) {
    const saved = await saveDriverNote(supabase, session.tenantId, order.id, note.value);
    if (!saved.ok) noteProblem = saved.error;
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
  if (noteProblem) {
    return fail(backTo, `Job ${order.order_number} assigned to ${board.name} for ${when}, but ${noteProblem}.`);
  }
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
 * "Start my day" — the round's one press before it drives (brief 2.4, G8).
 *
 * It used to be two: Confirm Load, then Start Route, minutes apart, each with
 * its own confirm. The brief asks for one button and one confirm, and the two
 * facts are still kept apart in the database — `load_confirmed_at` and
 * `started_at` are both stamped, on the jobs and on the day's internal runs,
 * because the depot screen, the unload sweep and `guard_route_transition` read
 * them separately. What changed is that a person no longer has to stand between
 * them.
 *
 * **Who is driving.** The press also records the person operating the round
 * today (`daily_routes.operated_by_driver_id`, 0031): a board is a shared login,
 * and "Board 1 delivered it" does not answer "who was holding that parcel?".
 * Optional — a laundry with no driver records still starts its day.
 *
 * **Late work.** A job assigned after the day started is not on the van; the
 * same press, offered again as "Load and take", loads and sends out exactly
 * those jobs. The first confirmation and the first departure are never
 * rewritten — the filters below are what make that true.
 */
export async function startMyDay(formData: FormData): Promise<void> {
  const session = await requireSession();
  const parsed = daySchema.extend({ driver_id: optionalUuid }).safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const supabase = await createClient();
  const permitted = await mayWorkTheDay(supabase, session, parsed.data.board_id);
  if (!permitted.ok) return fail(backTo, permitted.reason);

  const jobs = await loadBoardDayJobs(supabase, session.tenantId, parsed.data.board_id, parsed.data.date);
  const startable = checkStartMyDay(jobs);
  if (!startable.ok) return fail(backTo, startable.reason);

  let driverId: string | null = null;
  if (parsed.data.driver_id) {
    const { data: driver } = await supabase
      .from("drivers").select("id")
      .eq("tenant_id", session.tenantId).eq("id", parsed.data.driver_id).is("deleted_at", null)
      .maybeSingle<{ id: string }>();
    if (!driver) return fail(backTo, "That driver could not be found.");
    driverId = driver.id;
  }

  const at = getAdelaideNow().toISOString();
  const ids = startable.jobs.map((job) => job.id);

  // Loaded: only where nobody has confirmed it yet, so a first confirmation is
  // never rewritten by a second press.
  const { error: loadError } = await supabase
    .from("laundry_orders")
    .update({ load_confirmed_at: at, load_confirmed_by: session.userId })
    .in("id", ids).eq("tenant_id", session.tenantId)
    .is("load_confirmed_at", null);
  if (loadError) return fail(backTo, describeDbError(loadError));

  // Out: every job the round is now holding.
  const { error: outError } = await supabase
    .from("laundry_orders")
    .update({ status: "out_for_delivery" })
    .in("id", ids).eq("tenant_id", session.tenantId)
    // Re-asserted at the write: a filtered UPDATE cannot move a job somebody
    // else has just cancelled or reassigned.
    .eq("status", "assigned");
  if (outError) return fail(backTo, describeDbError(outError));

  await stampDayStarted(supabase, session, parsed.data, at, driverId);

  for (const job of startable.jobs) {
    await logOrderActivity(supabase, session, job.id, {
      activity_type: "status_changed",
      previous: { status: "assigned", load_confirmed_at: job.load_confirmed_at ?? null },
      next: { status: "out_for_delivery", load_confirmed_at: job.load_confirmed_at ?? at, driver: driverId },
      note: "Loaded and out for delivery (Start my day).",
    });
  }
  await recordAudit(session, {
    entity: "laundry_order", entityId: parsed.data.board_id, action: "status_change",
    summary: `day started: ${startable.jobs.length} job(s) out for ${parsed.data.date}`,
    metadata: { boardId: parsed.data.board_id, date: parsed.data.date, driverId, jobs: startable.jobs.length },
  });

  revalidateAssignmentScreens();
  revalidatePath("/run");
  revalidatePath("/runs");
  return done(backTo,
    `${startable.jobs.length} ${startable.jobs.length === 1 ? "job is" : "jobs are"} loaded and `
    + "out for delivery. Press Delivered on each one as you hand it over. Drive safely.");
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
    received_by: optionalText,
    signature_path: optionalText,
    photo_paths: optionalText,
    short: checkbox,
  }).safeParse(toObject(formData));
  const backTo = returnTo(formData, MY_RUNS);
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const supabase = await createClient();
  const order = await loadAssignable(supabase, session.tenantId, parsed.data.order_id);
  if (!order) return fail(backTo, await jobNotHere(supabase, session, parsed.data.order_id));

  const permitted = await mayCompleteOnTheRoad(supabase, session, order);
  if (!permitted.ok) return fail(backTo, permitted.reason);

  const proof = await readDeliveryProof(supabase, session, order, parsed.data, formData);
  if (!proof.ok) return fail(backTo, proof.error);

  const result = await completeLaundryOrder(supabase, session, order, {
    at: getAdelaideNow().toISOString(),
    handledBy: session.userId,
    note: parsed.data.note ?? null,
    // On the road the laundry is demonstrably off the shelf and at the door, so
    // a job still sitting at "assigned" is stepped through rather than refused.
    dispatchIfNeeded: true,
    proof: proof.value,
  });
  if (!result.ok) return fail(backTo, result.error);

  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id, action: "status_change",
    summary: `${order.order_number} delivered${proof.value.short ? " (short)" : ""}`,
    metadata: {
      boardId: proof.value.boardId, driverId: proof.value.driverId,
      signed: Boolean(proof.value.signaturePath), photos: proof.value.photoPaths.length,
    },
  });

  revalidateAssignmentScreens(order.id);
  revalidatePath("/runs");
  revalidatePath("/dashboard");
  return done(backTo, proof.value.short
    ? `Job ${order.order_number} delivered, marked short. The office will see it.`
    : `Job ${order.order_number} delivered.`);
}

const MAX_DELIVERY_PHOTOS = 4;

/**
 * What the round recorded at the door, checked (brief 2.4).
 *
 * The files were uploaded through `/api/media` before the form was posted, so
 * only their keys arrive here — and a key is only accepted if it names *this
 * job's own folder in this laundry's tenant segment*. Anything else is somebody
 * else's evidence, and is refused rather than stored.
 *
 * The board is the one the job is assigned to; the driver is the person
 * operating that round today (`operated_by_driver_id`, stamped by Start my
 * day), or the caller's own driver record when a driver is signed in. The
 * signed-in user is recorded as well, as `delivered_by`, by the shared write.
 */
async function readDeliveryProof(
  supabase: Supabase, session: Session, order: AssignableOrder,
  input: {
    received_by?: string; signature_path?: string; photo_paths?: string; short: boolean;
  },
  formData: FormData,
): Promise<{ ok: true; value: DeliveryProof } | { ok: false; error: string }> {
  const receivedBy = input.received_by?.slice(0, RECEIVED_BY_MAX) ?? null;

  const signaturePath = input.signature_path ?? null;
  if (signaturePath && !isDeliveryProofPath(signaturePath, session.tenantId, order.id)) {
    return { ok: false, error: "That signature does not belong to this job. Sign again." };
  }

  let photoPaths: string[] = [];
  if (input.photo_paths) {
    try {
      const parsed: unknown = JSON.parse(input.photo_paths);
      photoPaths = Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
    } catch {
      photoPaths = [];
    }
  }
  if (photoPaths.length > MAX_DELIVERY_PHOTOS
      || photoPaths.some((path) => !isDeliveryProofPath(path, session.tenantId, order.id))) {
    return { ok: false, error: "A photo does not belong to this job. Take it again." };
  }

  const { data: items } = await supabase
    .from("laundry_order_items")
    .select("id, item_type, custom_description, quantity_type, exact_quantity, bag_count, "
      + "estimated_quantity, notes, ownership")
    .eq("tenant_id", session.tenantId).eq("order_id", order.id)
    .returns<Array<RunJobItem & { id: string }>>();
  const rows = (items ?? []).map((item) => ({
    item,
    takenIn: item.quantity_type === "exact" ? item.exact_quantity : item.estimated_quantity,
  }));
  const counted = readDeliveredQuantities(
    rows.map((row) => ({ id: row.item.id, takenIn: row.takenIn ?? null })),
    toObject(formData), input.short,
  );
  if (!counted.ok) return counted;

  const driverId = await operatingDriver(supabase, session, order);

  return {
    ok: true,
    value: {
      receivedBy,
      signaturePath,
      photoPaths,
      short: counted.short,
      quantities: rows.map((row) => ({
        item_row_id: row.item.id,
        description: describeItem(row.item),
        taken_in: row.takenIn ?? null,
        delivered: counted.quantities.get(row.item.id) ?? null,
      })),
      boardId: order.assigned_board_id,
      driverId,
    },
  };
}

/** The person holding the parcel: a signed-in driver, or the round's operator today. */
async function operatingDriver(
  supabase: Supabase, session: Session, order: AssignableOrder,
): Promise<string | null> {
  const { data: own } = await supabase
    .from("drivers").select("id")
    .eq("tenant_id", session.tenantId).eq("user_id", session.userId).is("deleted_at", null)
    .maybeSingle<{ id: string }>();
  if (own) return own.id;
  if (!order.stop_id) return null;

  const { data: stop } = await supabase
    .from("jobs").select("route_id")
    .eq("tenant_id", session.tenantId).eq("id", order.stop_id)
    .maybeSingle<{ route_id: string | null }>();
  if (!stop?.route_id) return null;
  const { data: run } = await supabase
    .from("daily_routes").select("operated_by_driver_id")
    .eq("tenant_id", session.tenantId).eq("id", stop.route_id)
    .maybeSingle<{ operated_by_driver_id: string | null }>();
  return run?.operated_by_driver_id ?? null;
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
 * Carry Start my day down onto the day's internal runs.
 *
 * The run is what `/run`, the run sheet and — crucially — the inventory unload
 * sweep read, so a day started on My Runs has to be true there too. Two
 * statements, so the first load confirmation and the first departure are never
 * rewritten: `guard_route_transition` (0012) refuses a start without a load but
 * does not refuse a backwards move, and its `coalesce` does not protect
 * `started_at` from a caller that passes one.
 *
 *   1. a run nobody has loaded yet: loaded **and** started in one UPDATE — the
 *      guard sees the new `load_confirmed_at` and lets `in_progress` through;
 *   2. a run already loaded from the depot screen but not started: started.
 *
 * Runs already away are left alone. The operating driver is stamped only where
 * none is recorded yet. Failures are logged rather than surfaced: the jobs are
 * the record the round and the office both work from.
 */
async function stampDayStarted(
  supabase: Supabase, session: Session,
  day: { board_id: string; date: string }, at: string, driverId: string | null,
): Promise<void> {
  const scope = () => supabase.from("daily_routes");
  const driver = driverId ? { operated_by_driver_id: driverId } : {};

  const { error: freshError } = await scope()
    .update({
      load_confirmed_at: at, load_confirmed_by: session.userId,
      started_at: at, status: "in_progress",
    })
    .eq("board_id", day.board_id).eq("route_date", day.date)
    .eq("tenant_id", session.tenantId).is("deleted_at", null)
    .in("status", [...RUN_NOT_STARTED_STATUSES])
    .is("load_confirmed_at", null).is("started_at", null);

  const { error: loadedError } = await scope()
    .update({ started_at: at, status: "in_progress" })
    .eq("board_id", day.board_id).eq("route_date", day.date)
    .eq("tenant_id", session.tenantId).is("deleted_at", null)
    .is("started_at", null)
    .not("load_confirmed_at", "is", null)
    .not("status", "in", "(closed,cancelled)");

  if (driverId) {
    const { error: driverError } = await scope()
      .update(driver)
      .eq("board_id", day.board_id).eq("route_date", day.date)
      .eq("tenant_id", session.tenantId).is("deleted_at", null)
      .is("operated_by_driver_id", null);
    if (driverError) console.error("recording the operating driver failed", driverError.message);
  }

  for (const error of [freshError, loadedError]) {
    if (error) console.error("starting the day's runs failed", { date: day.date, error: error.message });
  }
}
