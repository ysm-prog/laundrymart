import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { checkTransition, ORDER_STATUS_LABELS, type OrderStatus } from "@/lib/domain/laundry-orders";
import { logOrderActivity } from "@/lib/orders/activity";
import { autoAssignOnReady, type AutoAssignResult } from "@/lib/runs/auto-assign";

type Client = Awaited<ReturnType<typeof createClient>>;

export type MarkReadyOutcome =
  | { ok: true; orderNumber: string; assigned: AutoAssignResult }
  | { ok: false; orderNumber: string; reason: string };

/**
 * Move one job from the plant to Ready (brief 3.3).
 *
 * The board's bulk Mark ready and the docket scan both come through here, and
 * do what the job page's own Ready step does: the same transition rule, the
 * same timeline entry and audit row, and then **ready means assigned** (2.2) —
 * a delivery job goes onto its customer's round by itself. Only the plant
 * stages are moved: a job that is already ready, on a round or finished is
 * reported, never walked backwards.
 *
 * The UPDATE names the status it expects, so two people scanning the same
 * docket cannot both move it; the second one reads "already ready".
 */
export async function markOrderReady(
  supabase: Client, session: Session, orderId: string,
): Promise<MarkReadyOutcome> {
  const { data: order } = await supabase
    .from("laundry_orders")
    .select("id, order_number, status, delivery_required")
    .eq("tenant_id", session.tenantId).eq("id", orderId)
    .maybeSingle<{ id: string; order_number: string; status: OrderStatus; delivery_required: boolean }>();
  if (!order) return { ok: false, orderNumber: orderId.slice(0, 8), reason: "it is not in this laundry" };

  if (order.status !== "new" && order.status !== "in_progress") {
    return {
      ok: false, orderNumber: order.order_number,
      reason: `it is already ${ORDER_STATUS_LABELS[order.status]?.toLowerCase() ?? order.status}`,
    };
  }
  const allowed = checkTransition(order.status, "ready_for_delivery", order.delivery_required);
  if (!allowed.ok) return { ok: false, orderNumber: order.order_number, reason: allowed.reason };

  const { data: moved, error } = await supabase
    .from("laundry_orders")
    .update({ status: "ready_for_delivery" })
    .eq("tenant_id", session.tenantId).eq("id", order.id).eq("status", order.status)
    .select("id");
  if (error) return { ok: false, orderNumber: order.order_number, reason: error.message };
  if (!moved?.length) {
    return { ok: false, orderNumber: order.order_number, reason: "somebody else moved it a moment ago" };
  }

  await logOrderActivity(supabase, session, order.id, {
    activity_type: "status_changed",
    previous: { status: order.status },
    next: { status: "ready_for_delivery" },
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id, action: "status_change",
    summary: `${order.order_number}: ${order.status} → ready_for_delivery`,
  });

  return { ok: true, orderNumber: order.order_number, assigned: await autoAssignOnReady(supabase, session, order.id) };
}
