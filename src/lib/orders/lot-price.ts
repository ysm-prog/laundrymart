import type { createClient } from "@/lib/supabase/server";
import { GST_RATE_FALLBACK } from "@/lib/domain/items";
import { STANDARD_LOT_PRICE_EX_GST } from "@/lib/domain/lot-booking";

type Client = Awaited<ReturnType<typeof createClient>>;

export type StandardLotPrice = {
  /** What a lot booked today costs, excluding GST. */
  unitPriceExGst: number;
  gstRate: number;
  /** True when the laundry has saved a price; false when this is the default. */
  saved: boolean;
};

/**
 * The laundry's standard lot price today (0067) — the price 0066's trigger
 * fixes on a job the moment it becomes a lot booking — and its GST rate.
 *
 * Read on the caller's client, so a role that may not read prices gets the
 * default back rather than the real figure. Callers only show it to a
 * `pricing.read` holder, which is the same set `can_read_pricing()` admits.
 *
 * **The tenant is named rather than left to RLS** (§23): a platform admin's
 * session reads every laundry's row.
 */
export async function loadStandardLotPrice(supabase: Client, tenantId: string): Promise<StandardLotPrice> {
  const [{ data: setting }, { data: tenant }] = await Promise.all([
    supabase.from("tenant_lot_prices").select("unit_price_ex_gst")
      .eq("tenant_id", tenantId)
      .maybeSingle<{ unit_price_ex_gst: number | string }>(),
    supabase.from("tenants").select("gst_rate").eq("id", tenantId)
      .maybeSingle<{ gst_rate: number | string | null }>(),
  ]);
  const saved = setting ? Number(setting.unit_price_ex_gst) : NaN;
  const rate = Number(tenant?.gst_rate ?? GST_RATE_FALLBACK);
  return {
    unitPriceExGst: Number.isFinite(saved) && saved > 0 ? saved : STANDARD_LOT_PRICE_EX_GST,
    gstRate: Number.isFinite(rate) ? rate : GST_RATE_FALLBACK,
    saved: Number.isFinite(saved) && saved > 0,
  };
}
