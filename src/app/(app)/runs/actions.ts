"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, firstIssue, requiredDate, toObject } from "@/lib/actions";
import { logOrderActivity } from "@/lib/orders/activity";
import { assignOneJobToBoard } from "@/lib/runs/assign";
import type { Session } from "@/lib/auth/context";
import { checkSequence, parseSequencePlan, type OrderableStop } from "./sequence";

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

/** The stops on one board's day, in their stored order. */
async function loadRunStops(
  supabase: Supabase, tenantId: string, boardId: string, date: string,
): Promise<Array<OrderableStop & { route_id: string; sequence: number }>> {
  const { data: routes } = await supabase
    .from("daily_routes")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("board_id", boardId)
    .eq("route_date", date)
    .is("deleted_at", null)
    .not("status", "in", "(cancelled)")
    .returns<Array<{ id: string }>>();

  const routeIds = (routes ?? []).map((route) => route.id);
  if (routeIds.length === 0) return [];

  const { data } = await supabase
    .from("jobs")
    .select("id, route_id, sequence, status, progress_status")
    .eq("tenant_id", tenantId)
    .in("route_id", routeIds)
    .is("deleted_at", null)
    .order("sequence")
    .returns<Array<OrderableStop & { route_id: string; sequence: number }>>();
  return data ?? [];
}

/**
 * Save a new order for one board's day.
 *
 * The whole order is posted and written at once, because a board is a sequence
 * and saving each drag would leave the run sheet transiently wrong after every
 * one — the same argument the dispatch planner makes for Apply plan.
 *
 * Positions are rewritten from 1, not nudged. Nudging preserves whatever gaps
 * and duplicates the data already had, and "position 3" on a run sheet has to
 * mean the third call.
 */
export async function reorderRunStops(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const raw = formData.get("plan");
  const parsed = parseSequencePlan(typeof raw === "string" ? raw : null);
  if (!parsed.ok) return fail(RUNS, parsed.error);

  const { board_id: boardId, date, stops: proposed } = parsed.plan;
  const back = `${RUNS}?date=${date}&board=${boardId}`;
  const supabase = await createClient();

  const stops = await loadRunStops(supabase, session.tenantId, boardId, date);
  if (stops.length === 0) {
    return fail(back, "There is nothing on that board for that day any more.");
  }

  // Re-checked here even though the board refuses to compose a bad plan: the
  // browser is not the boundary, and the run may have moved on since the page
  // was rendered.
  const valid = checkSequence(proposed, stops);
  if (!valid.ok) return fail(back, valid.error);

  const bySeq = new Map(stops.map((stop) => [stop.id, stop.sequence]));
  let moved = 0;

  for (const [index, id] of proposed.entries()) {
    const position = index + 1;
    if (bySeq.get(id) === position) continue;
    const { error } = await supabase
      .from("jobs")
      .update({ sequence: position })
      .eq("id", id)
      .eq("tenant_id", session.tenantId);
    if (error) return fail(back, describeDbError(error));
    moved += 1;
  }

  if (moved === 0) return done(back, "That is already the order.");

  await recordAudit(session, {
    entity: "daily_route", entityId: boardId, action: "update",
    summary: `Run order changed for ${date} (${moved} stop(s) moved)`,
    metadata: { boardId, date, order: proposed },
  });

  revalidatePath(RUNS);
  revalidatePath("/my-runs");
  return done(back, `Run order saved — ${moved} stop(s) moved.`);
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
