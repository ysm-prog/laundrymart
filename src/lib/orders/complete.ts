import type { Session } from "@/lib/auth/context";
import type { createClient } from "@/lib/supabase/server";
import { describeDbError } from "@/lib/actions";
import { checkTransition, type OrderStatus } from "@/lib/domain/laundry-orders";
import { logOrderActivity } from "@/lib/orders/activity";

/**
 * Finishing a laundry job — the single implementation, called from two places.
 *
 * The counter's own screen has always had this: `completeOrder` in
 * `orders/actions.ts` captures a date, a time and who handled it, and stamps
 * `delivered_*` or `collected_*` depending on which workflow the job is on. My
 * Runs needs the same write from the other end — a driver at a door with a phone
 * — and §30 of the brief is explicit that this must not become a second
 * delivery-completion implementation. So the write lives here and both entry
 * points call it; what differs between them is only the guard in front and where
 * the timestamp comes from.
 *
 * What this function does *not* do is decide whether the caller is allowed. That
 * is the caller's job, because the two answers are genuinely different: the
 * counter asks "do you hold `orders.status`?", the road asks "is this job on a
 * stop of a run that is yours?".
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type CompletionTarget = {
  id: string;
  order_number: string;
  status: OrderStatus;
  delivery_required: boolean;
};

export type CompletionInput = {
  /** The instant it happened, already composed in the right timezone. */
  at: string;
  /** The `auth.users` id of whoever handled it. */
  handledBy: string;
  note?: string | null;
  /**
   * Step a job that is still `ready_for_delivery` through `out_for_delivery`
   * first, rather than refusing it.
   *
   * The database will not let a delivery job be completed off the shelf (0014),
   * and it is right not to: at the counter that transition means somebody forgot
   * to record that the van left. On the road it means the opposite — the driver
   * is holding the laundry at the customer's door, so it demonstrably *did*
   * leave, and the missing step is bookkeeping the run start normally does. So
   * the road passes `true` and the counter does not.
   */
  dispatchIfNeeded?: boolean;
};

export async function completeLaundryOrder(
  supabase: Supabase, session: Session, order: CompletionTarget, input: CompletionInput,
): Promise<{ ok: true; delivered: boolean } | { ok: false; error: string }> {
  let status: OrderStatus = order.status;

  if (input.dispatchIfNeeded
      && status === "ready_for_delivery"
      && order.delivery_required) {
    const step = await advance(supabase, session, order, "out_for_delivery");
    if (!step.ok) return step;
    status = "out_for_delivery";
  }

  const allowed = checkTransition(status, "completed", order.delivery_required);
  if (!allowed.ok) return { ok: false, error: allowed.reason };

  const delivered = order.delivery_required;
  const { error } = await supabase
    .from("laundry_orders")
    .update({
      status: "completed",
      completed_at: input.at,
      ...(delivered
        ? { delivered_at: input.at, delivered_by: input.handledBy }
        : { collected_at: input.at, collected_by: input.handledBy }),
    })
    .eq("id", order.id)
    // RLS already scopes this; the filter states the intent, as elsewhere.
    .eq("tenant_id", session.tenantId);
  if (error) return { ok: false, error: describeDbError(error) };

  await logOrderActivity(supabase, session, order.id, {
    activity_type: delivered ? "delivered" : "collected",
    previous: { status },
    next: { status: "completed", at: input.at, by: input.handledBy },
    note: input.note ?? null,
  });

  return { ok: true, delivered };
}

/** One plain status move, with its timeline row. Shared by the step above. */
async function advance(
  supabase: Supabase, session: Session, order: CompletionTarget, to: OrderStatus,
): Promise<{ ok: true; delivered: boolean } | { ok: false; error: string }> {
  const allowed = checkTransition(order.status, to, order.delivery_required);
  if (!allowed.ok) return { ok: false, error: allowed.reason };

  const { error } = await supabase
    .from("laundry_orders").update({ status: to })
    .eq("id", order.id).eq("tenant_id", session.tenantId);
  if (error) return { ok: false, error: describeDbError(error) };

  await logOrderActivity(supabase, session, order.id, {
    activity_type: "status_changed",
    previous: { status: order.status },
    next: { status: to },
  });
  return { ok: true, delivered: order.delivery_required };
}

/**
 * Mark every delivery job on a run as having physically left.
 *
 * Called when a run starts. This is a statement of fact rather than a shortcut:
 * the van has pulled out with that laundry on it, so `out_for_delivery` is
 * simply true, and leaving the jobs at `ready_for_delivery` would have the Jobs
 * screen claiming the linen is still on the shelf all morning.
 *
 * It is emphatically not completion — nothing here marks a job delivered, and a
 * run that closes with work still on it leaves that work outstanding (§14, §31).
 * Jobs already out, completed or cancelled are left exactly as they are.
 */
export async function dispatchRunJobs(
  supabase: Supabase, session: Session, routeId: string,
): Promise<number> {
  const { data: stops } = await supabase
    .from("jobs").select("id").eq("route_id", routeId).is("deleted_at", null)
    .returns<Array<{ id: string }>>();
  if (!stops?.length) return 0;

  const { data: orders } = await supabase
    .from("laundry_orders")
    .select("id, status")
    .in("stop_id", stops.map((stop) => stop.id))
    .eq("delivery_required", true)
    .eq("status", "ready_for_delivery")
    .returns<Array<{ id: string; status: OrderStatus }>>();
  if (!orders?.length) return 0;

  const { error } = await supabase
    .from("laundry_orders")
    .update({ status: "out_for_delivery" })
    .in("id", orders.map((order) => order.id))
    .eq("tenant_id", session.tenantId);
  // A run that started is more important than the bookkeeping behind it: the
  // caller has already stamped the run, so a failure here is reported to the
  // log and the driver's day continues. The jobs stay dispatchable by hand.
  if (error) {
    console.error("dispatching run jobs failed", { routeId, error: error.message });
    return 0;
  }

  for (const order of orders) {
    await logOrderActivity(supabase, session, order.id, {
      activity_type: "status_changed",
      previous: { status: order.status },
      next: { status: "out_for_delivery" },
      note: "The run this job is on left the depot.",
    });
  }
  return orders.length;
}
