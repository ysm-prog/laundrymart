"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  describeDbError, done, fail, firstIssue, requiredDate, returnTo, toObject,
} from "@/lib/actions";
import { logOrderActivity } from "@/lib/orders/activity";
import { assignOneJobToBoard } from "@/lib/runs/assign";
import { loadRunDay } from "@/lib/runs/run-day";
import type { Session } from "@/lib/auth/context";
import {
  SEQUENCE_CONFLICT, SEQUENCE_SAVED,
  buildSequenceAudit, checkSequence, movedCount, parseSequencePlan,
} from "./sequence";

/**
 * The office's two decisions about a board's day: what order, and which board.
 *
 * Neither is a change to any job. Reordering rewrites `jobs.sequence` and
 * nothing else — no customer, no laundry, no price, no status — which is the
 * client's own requirement and is worth stating because the two facts live on
 * different rows and it would be easy to touch both.
 */

const RUNS = "/runs";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * **Save & Lock** — the office's decision about the order of a board's day.
 *
 * The whole order is posted and written at once, because a board is a sequence
 * and saving each drag would leave the run sheet transiently wrong after every
 * one. Nothing is written while somebody is dragging; nothing is written by
 * Cancel; and the run is locked again the moment this returns, which is the
 * whole of the requirement's lock/edit/save cycle.
 *
 * **`routes.sequence`, not `routes.write`.** Planning a day and deciding the
 * order of the calls turned out to be two decisions, and the second belongs to
 * the Owner and the Office manager alone — a dispatcher holds the first.
 *
 * **The screen is not the boundary.** Every check below is repeated in the
 * database: `apply_run_sequence()` re-resolves the run from (tenant, board,
 * date) rather than trusting a posted run id, compares and swaps the version,
 * and verifies the posted set is exactly this run's stops — and the guard
 * triggers refuse the write outright to a role that may not order a run. What
 * is done here is done for the **message**: a refusal from Postgres names a
 * constraint, and a manager needs a sentence about their run.
 */
export async function reorderRunStops(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.sequence");
  const raw = formData.get("plan");
  const parsed = parseSequencePlan(typeof raw === "string" ? raw : null);
  if (!parsed.ok) return fail(returnTo(formData, RUNS), parsed.error);

  const {
    board_id: boardId, date, stops: proposed, expected_version: expected,
  } = parsed.plan;
  // My Runs draws this same board, and a manager who adjusts a run from the
  // round's own day has to land back on it — being moved to another screen
  // reads as the save having done something else. `returnTo` refuses anything
  // that is not a plain same-site path, so the field cannot redirect anywhere.
  const back = returnTo(formData, `${RUNS}?date=${date}&board=${boardId}`);
  const supabase = await createClient();

  // Named rather than left to RLS (§23): a platform admin's session reads every
  // laundry, and this board id arrives from the browser.
  const day = await loadRunDay(supabase, session.tenantId, boardId, date);
  if (day.stops.length === 0) {
    return fail(back, "There is nothing on that board for that day any more.");
  }

  // Re-checked here even though the board refuses to compose a bad plan: the
  // browser is not the boundary, and the run may have moved on since the page
  // was rendered.
  const valid = checkSequence(proposed, day.stops);
  if (!valid.ok) return fail(back, valid.error);

  // Somebody else saved while this page was open. Caught here so the manager
  // gets the sentence rather than a database refusal; `apply_run_sequence()`
  // catches the narrower race — two saves that both pass this check — inside
  // the transaction that writes the positions.
  if (day.version !== expected) return fail(back, SEQUENCE_CONFLICT);

  const previous = day.stops.map((stop) => stop.id);
  const moved = movedCount(previous, proposed);
  if (moved === 0) return done(back, "That is already the order.");

  // One statement, so the run is never transiently numbered twice — the reason
  // `save_laundry_order_items()` exists in the same shape. It also renumbers
  // from 1, which repairs whatever gaps or duplicates the stored data carried.
  const { data: version, error } = await supabase.rpc("apply_run_sequence", {
    t: session.tenantId,
    board: boardId,
    run_date: date,
    stop_ids: proposed,
    expected_version: expected,
  });
  if (error) {
    return fail(back, error.message?.includes("updated by another user")
      ? SEQUENCE_CONFLICT
      : describeDbError(error));
  }

  // Built by a pure rule so the requirement's list — previous order, new order,
  // board, date, actor, role — is asserted by a test rather than by reading.
  await recordAudit(session, buildSequenceAudit({
    boardId, date,
    runIds: day.routeIds,
    previous, next: proposed,
    actorId: session.userId,
    role: session.role,
    version: version ?? expected + 1,
  }));

  revalidatePath(RUNS);
  revalidatePath("/my-runs");
  return done(back, SEQUENCE_SAVED);
}

/**
 * Move a job to another board, singly or in bulk.
 *
 * This is a **reassignment**, so it goes through the same door a single
 * assignment does: `assignJobToBoard` finds or opens the target board's run for
 * the day, moves the stop, and lets `guard_laundry_order_assignment` refuse
 * anything incoherent. Reimplementing that here would be a second answer to
 * "what does assigning mean", and the two would drift.
 *
 * One request for the whole selection, capped and refused rather than truncated
 * past the cap — the contract the billing bulk actions already hold. Partial
 * success reports both numbers and names each reason, because a batch that
 * half-worked and said "done" is how work quietly goes missing.
 */
const MAX_REASSIGN = 200;

export async function reassignJobsToBoard(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = z.object({
    board_id: z.uuid("Choose a board to move the work to."),
    date: requiredDate,
    return_date: requiredDate.optional(),
    return_board: z.string().optional(),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(RUNS, firstIssue(parsed.error));

  const orderIds = formData.getAll("selected")
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const back = `${RUNS}?date=${parsed.data.return_date ?? parsed.data.date}`
    + (parsed.data.return_board ? `&board=${parsed.data.return_board}` : "");

  if (orderIds.length === 0) return fail(back, "Select at least one job to move.");
  if (orderIds.length > MAX_REASSIGN) {
    return fail(back,
      `That is ${orderIds.length} jobs. Move at most ${MAX_REASSIGN} at a time so a failure is readable.`);
  }

  const supabase = await createClient();
  const { data: board } = await supabase
    .from("boards").select("id, name, status")
    .eq("tenant_id", session.tenantId).eq("id", parsed.data.board_id)
    .is("deleted_at", null)
    .maybeSingle<{ id: string; name: string; status: string }>();
  if (!board) return fail(back, "That board is not in this laundry.");
  if (board.status !== "active") {
    return fail(back, `${board.name} is not active, so work cannot be moved to it.`);
  }

  const moved: string[] = [];
  const skipped: Array<{ orderNumber: string; reason: string }> = [];

  for (const orderId of orderIds) {
    const result = await moveOneJob(supabase, session, orderId, board, parsed.data.date);
    if (result.ok) moved.push(result.orderNumber);
    else skipped.push({ orderNumber: result.orderNumber, reason: result.reason });
  }

  revalidatePath(RUNS);
  revalidatePath("/my-runs");
  revalidatePath("/orders");

  if (moved.length === 0) {
    const first = skipped[0];
    return fail(back, first
      ? `Nothing moved — ${first.orderNumber}: ${first.reason}`
      : "Nothing moved.");
  }

  const tail = skipped.length > 0
    ? ` ${skipped.length} could not be moved (${skipped[0]!.orderNumber}: ${skipped[0]!.reason}).`
    : "";
  return done(back, `${moved.length} job(s) moved to ${board.name}.${tail}`);
}

/**
 * One job's move, sharing the assignment path rather than restating it.
 *
 * `assignOneJobToBoard` is the same write the job page's Assign performs — one
 * implementation, so a bulk move and a single one cannot mean different things.
 * What differs here is only what the operator is told: a reason per job rather
 * than a sentence.
 */
async function moveOneJob(
  supabase: Supabase,
  session: Session,
  orderId: string,
  board: { id: string; name: string },
  date: string,
): Promise<{ ok: true; orderNumber: string } | { ok: false; orderNumber: string; reason: string }> {
  const { data: order } = await supabase
    .from("laundry_orders")
    .select("id, order_number, status, delivery_required, assigned_board_id, assigned_delivery_date, stop_id, customer_id")
    .eq("tenant_id", session.tenantId)
    .eq("id", orderId)
    .maybeSingle<{
      id: string; order_number: string; status: string; delivery_required: boolean;
      assigned_board_id: string | null; assigned_delivery_date: string | null;
      stop_id: string | null; customer_id: string;
    }>();

  if (!order) return { ok: false, orderNumber: orderId.slice(0, 8), reason: "not in this laundry" };
  if (!order.delivery_required) {
    return { ok: false, orderNumber: order.order_number, reason: "the customer is collecting it" };
  }
  if (order.status === "completed" || order.status === "cancelled") {
    return { ok: false, orderNumber: order.order_number, reason: `it is ${order.status}` };
  }
  if (order.assigned_board_id === board.id && order.assigned_delivery_date === date) {
    return { ok: false, orderNumber: order.order_number, reason: `it is already on ${board.name}` };
  }

  const result = await assignOneJobToBoard(supabase, session, {
    orderId, boardId: board.id, deliveryDate: date,
    current: {
      status: order.status,
      assigned_board_id: order.assigned_board_id,
      stop_id: order.stop_id,
      customer_id: order.customer_id,
    },
  });
  if (!result.ok) return { ok: false, orderNumber: order.order_number, reason: result.error };

  await logOrderActivity(supabase, session, order.id, {
    activity_type: order.assigned_board_id ? "run_reassigned" : "run_assigned",
    previous: { board: order.assigned_board_id, assigned_delivery_date: order.assigned_delivery_date },
    next: { board: board.name, assigned_delivery_date: date },
  });

  return { ok: true, orderNumber: order.order_number };
}
