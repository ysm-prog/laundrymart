import type { createClient } from "@/lib/supabase/server";
import { addDays } from "@/lib/domain/dates";

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * This laundry's public holidays from a day forward, as a set of ISO dates —
 * what `nextDeliveryDay` and `defaultReturnDate` skip. One read, shared by the
 * automatic assignment (2.2), the intake form's default return date (3.4) and
 * the Needs a driver list on Today (3.2), so the three cannot pick different
 * days for the same job. A failed read is an empty set: a delivery day that
 * lands on a holiday is a nuisance, a screen that will not render is worse.
 */
export async function loadHolidaySet(
  supabase: Client, tenantId: string, from: string, days = 400,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("public_holidays").select("holiday_date")
    .eq("tenant_id", tenantId)
    .gte("holiday_date", from).lte("holiday_date", addDays(from, days))
    .returns<Array<{ holiday_date: string }>>();
  return new Set((data ?? []).map((row) => row.holiday_date));
}
