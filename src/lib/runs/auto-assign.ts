import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { addDays } from "@/lib/domain/dates";
import { formatAdelaideDate, getAdelaideToday } from "@/lib/domain/timezone";
import { checkAssignable } from "@/lib/domain/run-assignment";
import {
  autoAssignDecision, nextDeliveryDay, parseAutomation, type AutoAssignSkip,
} from "@/lib/domain/automation";
import { logOrderActivity } from "@/lib/orders/activity";
import { assignOneJobToBoard } from "@/lib/runs/assign";

/**
 * "Ready means assigned" (Darshan's BA review, brief 2.2, design rule 3).
 *
 * A delivery job that reaches Ready for delivery used to sit in the *Needs a
 * driver* queue until somebody gave it a board and a date by hand — for a
 * customer whose round everybody already knew. When the customer has a round
 * (`customers.collection_board_id`, 0047) the job now goes straight onto it, for
 * the first delivering day on or after its expected date (`nextDeliveryDay`).
 *
 * **Through the existing assignment routine, not beside it**:
 * `assignOneJobToBoard` is the write the job page's Assign and the Runs bulk
 * move already share, so `guard_laundry_order_assignment` (0016/0031) still
 * judges it, the run and stop are found or opened the same way, and the
 * activity row is the same verb. On the caller's own client, so RLS — and
 * 0025's restrictive write layer — still decide whether the caller could have
 * made the change by hand.
 *
 * **Never fails the move that called it.** The job is Ready whatever happens
 * here; a refusal leaves it in *Needs a driver*, exactly where it was before
 * this existed, and the reason is handed back for the toast.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type AutoAssignResult =
  | { state: "assigned"; boardName: string; date: string }
  | { state: "skipped"; skip: AutoAssignSkip }
  | { state: "failed"; error: string };

export async function autoAssignOnReady(
  supabase: Supabase, session: Session, orderId: string,
): Promise<AutoAssignResult> {
  try {
    const { data: order } = await supabase
      .from("laundry_orders")
      .select("id, order_number, status, delivery_required, assigned_board_id, stop_id, "
        + "customer_id, expected_delivery_date")
      .eq("tenant_id", session.tenantId).eq("id", orderId)
      .maybeSingle<{
        id: string; order_number: string; status: string; delivery_required: boolean;
        assigned_board_id: string | null; stop_id: string | null; customer_id: string;
        expected_delivery_date: string | null;
      }>();
    if (!order) return { state: "failed", error: "that job could not be found" };

    const [{ data: tenant }, { data: customer }] = await Promise.all([
      supabase.from("tenants").select("settings").eq("id", session.tenantId)
        .maybeSingle<{ settings: unknown }>(),
      supabase.from("customers").select("collection_board_id")
        .eq("tenant_id", session.tenantId).eq("id", order.customer_id)
        .maybeSingle<{ collection_board_id: string | null }>(),
    ]);

    const decision = autoAssignDecision({
      settings: parseAutomation(tenant?.settings),
      status: order.status,
      deliveryRequired: order.delivery_required,
      assignedBoardId: order.assigned_board_id,
      customerBoardId: customer?.collection_board_id ?? null,
    });
    if (!decision.assign) return { state: "skipped", skip: decision.skip };

    const eligible = checkAssignable(order);
    if (!eligible.ok) return { state: "failed", error: eligible.reason };

    const { data: board } = await supabase
      .from("boards").select("id, name, status")
      .eq("tenant_id", session.tenantId).eq("id", decision.boardId).is("deleted_at", null)
      .maybeSingle<{ id: string; name: string; status: string }>();
    if (!board || board.status !== "active") {
      return { state: "failed", error: "the customer's round is not an active board" };
    }

    const today = getAdelaideToday();
    const { data: holidays } = await supabase
      .from("public_holidays").select("holiday_date")
      .eq("tenant_id", session.tenantId)
      .gte("holiday_date", today).lte("holiday_date", addDays(today, 400))
      .returns<Array<{ holiday_date: string }>>();
    const date = nextDeliveryDay(
      order.expected_delivery_date, today,
      new Set((holidays ?? []).map((row) => row.holiday_date)),
    );

    const assigned = await assignOneJobToBoard(supabase, session, {
      orderId: order.id, boardId: board.id, deliveryDate: date,
      current: {
        status: order.status, assigned_board_id: null,
        stop_id: order.stop_id, customer_id: order.customer_id,
      },
    });
    if (!assigned.ok) return { state: "failed", error: assigned.error };

    await logOrderActivity(supabase, session, order.id, {
      activity_type: "run_assigned",
      previous: { board: null, assigned_delivery_date: null },
      next: { board: board.name, assigned_delivery_date: date, automatic: true },
      note: `Assigned automatically to the customer's round, ${board.name}, `
        + `for ${formatAdelaideDate(date, "medium")}.`,
    });
    await recordAudit(session, {
      entity: "laundry_order", entityId: order.id, action: "assign",
      summary: `${order.order_number} → ${board.name} ${date} (automatic)`,
      metadata: { boardId: board.id, deliveryDate: date, automatic: true, runId: assigned.runId },
    });

    return { state: "assigned", boardName: board.name, date };
  } catch (cause) {
    console.error("automatic assignment threw", { orderId, cause });
    return { state: "failed", error: "the automatic assignment could not run" };
  }
}

/** The sentence appended to "Job LJ… is now ready for delivery." */
export function autoAssignSentence(result: AutoAssignResult): string {
  if (result.state === "assigned") {
    return ` It is on ${result.boardName} for ${formatAdelaideDate(result.date, "medium")}.`;
  }
  if (result.state === "failed") {
    return ` It could not be put on the customer's round (${result.error}), so it is waiting under Needs a driver.`;
  }
  if (result.skip === "no_round") {
    return " The customer has no round set, so it is waiting under Needs a driver.";
  }
  return "";
}
