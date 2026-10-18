import { createClient } from "@/lib/supabase/server";
import { getAdelaideToday } from "@/lib/domain/timezone";
import { parseOperations } from "@/lib/domain/operations-settings";
import { defaultReturnDate, prefillFromLastJob } from "@/lib/domain/intake";
import type { OrderItemInput } from "@/lib/domain/laundry-orders";
import { loadHolidaySet } from "@/lib/runs/holidays";

export type IntakeDefaults = {
  /** The customer's last job's laundry, as rows for this one. Empty when there is none. */
  items: OrderItemInput[];
  /** The last job's number, said on the form so the prefill is not a mystery. */
  lastOrderNumber: string | null;
  returnDate: string;
  /** "Board 1, Tuesdays" when the date came from the round; null when from the turnaround. */
  roundLabel: string | null;
};

const WEEKDAYS = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

/**
 * The defaults for a customer, worked out once (brief 3.4). **Not a server
 * action** — it takes the tenant as an argument, so it must never be callable
 * from a browser; the action in `orders/intake-actions.ts` derives the tenant
 * from the session and calls this, and so does the new-job page.
 */
export async function intakeDefaultsFor(tenantId: string, customerId: string): Promise<IntakeDefaults | null> {
  const supabase = await createClient();
  const today = getAdelaideToday();

  const [customer, tenant, lastJob, holidays] = await Promise.all([
    supabase.from("customers")
      .select("collection_weekday, boards(name)")
      .eq("tenant_id", tenantId).eq("id", customerId)
      .maybeSingle<{ collection_weekday: number | null; boards: { name: string } | null }>(),
    supabase.from("tenants").select("settings").eq("id", tenantId)
      .maybeSingle<{ settings: unknown }>(),
    supabase.from("laundry_orders")
      .select("id, order_number")
      .eq("tenant_id", tenantId).eq("customer_id", customerId).neq("status", "cancelled")
      .order("received_at", { ascending: false }).limit(1)
      .maybeSingle<{ id: string; order_number: string }>(),
    loadHolidaySet(supabase, tenantId, today),
  ]);
  if (!customer.data) return null;

  const { data: lastItems } = lastJob.data
    ? await supabase.from("laundry_order_items")
        .select("item_id, item_type, custom_description, quantity_type, exact_quantity, bag_count, estimated_quantity, notes, ownership")
        .eq("tenant_id", tenantId).eq("order_id", lastJob.data.id)
        .order("created_at").returns<OrderItemInput[]>()
    : { data: [] as OrderItemInput[] };

  const weekday = customer.data.collection_weekday;
  const operations = parseOperations(tenant.data?.settings);
  return {
    items: prefillFromLastJob(lastItems ?? []),
    lastOrderNumber: lastJob.data?.order_number ?? null,
    returnDate: defaultReturnDate({
      today, roundWeekday: weekday, turnaroundDays: operations.defaultTurnaroundDays, holidays,
    }),
    roundLabel: weekday
      ? `${customer.data.boards?.name ?? "their round"}, ${WEEKDAYS[weekday - 1]}`
      : null,
  };
}

