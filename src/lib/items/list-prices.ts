import type { SupabaseClient } from "@supabase/supabase-js";
import type { LaundryPriceRow } from "@/lib/domain/laundry-billing";
import { buildItemPriceRows, type PricedItem, type PriceValue } from "@/lib/domain/laundry-prices";

/**
 * Hang this customer's listed price on each item a picker is about to offer.
 *
 * **This is the read that makes a price edit visible.** Every screen that turns
 * an item into money — the job's Charges card, the invoice line composer — used
 * `items.sell_price` and nothing else, so the laundry price list governed
 * `priceJob` and no screen at all. An owner could re-rate `T40` and watch the
 * next charge they typed still carry the old number.
 *
 * One read per screen, resolved through the same `buildItemPriceRows` the price
 * screens render from and the same precedence `priceListFor` applies: the
 * customer's own rate wins, the usual price answers where they have none, and
 * there is no third fallback. Sharing the resolution is the point — a second
 * copy of "which row wins" is how the screen and the pricer come to disagree
 * about what a customer is charged.
 *
 * **The tenant is named rather than left to RLS** (§23). `is_member()` is true
 * of every laundry for a platform admin, and the usual list is the row with
 * `customer_id is null` — so unfiltered, two laundries' lists both come back and
 * whichever the plan returned first would price the job. This read feeds a
 * write, which is exactly the case that rule exists for.
 *
 * Degrades to "no listed price" rather than throwing: a refused or empty read
 * leaves every item on its own selling price, which is what these screens did
 * before this existed. A job page must not 500 because a price list could not be
 * read.
 */
export async function attachListPrices<T extends PricedItem>(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string | null,
  items: readonly T[],
): Promise<Array<T & { list_price: PriceValue | null }>> {
  if (items.length === 0) return [];

  const scope = supabase
    .from("laundry_prices")
    .select("customer_id, item_type, item_id, unit_price, bag_price, taxable")
    .eq("tenant_id", tenantId)
    .not("item_id", "is", null);

  const { data } = await (customerId
    ? scope.or(`customer_id.eq.${customerId},customer_id.is.null`)
    : scope.is("customer_id", null)
  ).returns<LaundryPriceRow[]>();

  // `buildItemPriceRows` resolves each item against the scope it is given, so
  // passing the customer id here is what makes their own rate win. With none —
  // a manual invoice raised against nobody — the usual list is the answer.
  return buildItemPriceRows(items, data ?? [], customerId)
    .map(({ item, price }) => ({ ...item, list_price: price }));
}
