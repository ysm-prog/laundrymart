import type { createClient } from "@/lib/supabase/server";

/**
 * The fallback rate, re-exported from the pure module so this file is the one
 * place a screen has to import from — and so there is exactly one copy of the
 * number. It lives in `lib/domain/items.ts` because `coding.ts` needs it too and
 * is reachable from the client bundle, which this module is not.
 */
export { GST_RATE_FALLBACK } from "@/lib/domain/items";
import { GST_RATE_FALLBACK as FALLBACK } from "@/lib/domain/items";

/**
 * This laundry's GST rate.
 *
 * Read where an item's price has to be turned into a line rate — an item priced
 * GST-**exclusive** is grossed up before it becomes an invoice line or a job
 * charge (`lineRateFromItem`), and doing that needs the rate the laundry
 * actually charges rather than a constant.
 *
 * The tenant is a **required argument** rather than left to RLS (§23): a
 * platform admin's session reads every laundry, and this number goes on to
 * decide what a customer is billed.
 *
 * Two older readers of this column are deliberately left as they are —
 * `createCreditNote` reads it inline, and `lib/pdf/invoice-data.ts` takes it as
 * part of a wider select of the tenant. Neither is on this path and neither is
 * wrong; folding them in would be churn in files this change does not otherwise
 * touch.
 */
export async function tenantGstRate(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
): Promise<number> {
  const { data } = await supabase
    .from("tenants").select("gst_rate").eq("id", tenantId).maybeSingle<{ gst_rate: number }>();
  const rate = Number(data?.gst_rate ?? FALLBACK);
  // A missing row, a null, or something unparseable all mean "we could not find
  // out" — and a NaN rate would silently turn every grossed-up price into NaN.
  return Number.isFinite(rate) && rate >= 0 ? rate : FALLBACK;
}
