import type { Session } from "@/lib/auth/context";
import type { createClient } from "@/lib/supabase/server";

/**
 * One line of a job's timeline, written beside the change that caused it.
 *
 * Lifted out of `orders/actions.ts` unchanged when My Runs arrived: a job can
 * now be moved by the counter, by a dispatcher assigning it to a van, and by the
 * driver who hands it over, and all three have to write to the same timeline in
 * the same shape. A second logger would produce a page where half the history
 * is missing depending on who did the work.
 *
 * Failures are logged and swallowed, exactly as `recordAudit()` does: a job that
 * was delivered must not report itself as failed because the note about it could
 * not be written. The audit log remains the tamper-evident record; this is the
 * human-readable one on the page.
 */

export type OrderActivityType =
  | "created" | "status_changed" | "updated" | "items_changed"
  | "assigned" | "delivered" | "collected" | "cancelled"
  // Added by 0015. Distinct from `assigned`, which means "handed to a member of
  // staff" — a timeline that cannot tell that apart from "put on John's van" is
  // a timeline nobody can answer a question with.
  | "run_assigned" | "run_reassigned" | "run_removed";

export type ActivityEntry = {
  activity_type: OrderActivityType;
  previous?: Record<string, unknown> | null;
  next?: Record<string, unknown> | null;
  note?: string | null;
};

export async function logOrderActivity(
  supabase: Awaited<ReturnType<typeof createClient>>,
  session: Session,
  orderId: string,
  entry: ActivityEntry,
): Promise<void> {
  try {
    const { error } = await supabase.from("laundry_order_activity").insert({
      tenant_id: session.tenantId,
      order_id: orderId,
      actor_id: session.userId,
      activity_type: entry.activity_type,
      previous_value: entry.previous ?? null,
      new_value: entry.next ?? null,
      note: entry.note ?? null,
    });
    if (error) console.error("job activity insert failed", { orderId, error: error.message });
  } catch (cause) {
    console.error("job activity insert threw", cause);
  }
}
