import { ITEM_TYPES, ITEM_TYPE_LABELS, type ItemType } from "@/lib/domain/laundry-orders";

/**
 * The counter's laundry price list: resolving it, with no database in sight.
 *
 * `laundry_prices` (0018) holds one row per kind of laundry either for a
 * customer or for the tenant (`customer_id is null`). This module answers the
 * one question that has a rule in it — **which row wins** — and nothing else:
 * the customer's own price, else the tenant default, else no answer at all.
 * There is no third fallback and emphatically no invented figure.
 *
 * **This module used to price a whole period's jobs as well, and no longer
 * does.** `buildLaundryCharges` and `describeUnpriced` were removed when the
 * rate-card model was adopted (2026-08-17): a job's money is now decided once,
 * by a person, at review time, and frozen into `job_charge_snapshots` (0017).
 * The list this module resolves is still what prices most jobs — it is the tier
 * beneath the rate card, and on the live deployment it is the *only* tier, since
 * no customer holds a card yet — but it is consumed by `priceJob` in
 * `job-pricing.ts` rather than by a second period-level pricer here.
 *
 * Keeping a second batch pricer alive beside the snapshot path would have been
 * exactly the "two answers to what is this customer charged?" that adopting one
 * model was meant to end, and the dead one would have looked live.
 *
 * The bulk-lot rule moved with it and now lives in `job-pricing.ts`: bags if
 * there is a bag rate and a bag count, otherwise the estimated piece count, and
 * a lot with neither cannot be priced and says so.
 */

/** A row of `laundry_prices`. `customer_id` null is the tenant default list. */
export type LaundryPriceRow = {
  customer_id: string | null;
  item_type: string;
  /**
   * The item master row this price is for (0032), or null for a price that
   * covers a whole kind of laundry.
   *
   * A per-item price is the specific answer — TOW001 costs this — and a
   * per-category one is the tier beneath it. Both are resolved here; which wins
   * is stated once, in `priceJob`.
   */
  item_id?: string | null;
  unit_price: number | string | null;
  bag_price: number | string | null;
  taxable: boolean;
};

export type LaundryPrice = {
  /** Per piece. */
  unitPrice: number;
  /** Per bag for a bulk lot, or null when the laundry sets no bag rate. */
  bagPrice: number | null;
  taxable: boolean;
  /** Which row answered: this customer's own price, or the tenant default. */
  source: "customer" | "default";
};

export type BillableJobItem = {
  item_type: string;
  custom_description?: string | null;
  quantity_type: string;
  exact_quantity?: number | null;
  bag_count?: number | null;
  estimated_quantity?: number | null;
};

export type BillableJob = {
  id: string;
  order_number: string;
  items: readonly BillableJobItem[];
};

/** The plain-English name of a kind of laundry, custom descriptions included. */
export function itemLabel(item: Pick<BillableJobItem, "item_type" | "custom_description">): string {
  if (item.item_type === "other") return item.custom_description?.trim() || "Other";
  return ITEM_TYPE_LABELS[item.item_type as ItemType] ?? item.item_type;
}

/**
 * This customer's effective price list: their own row where they have one, the
 * tenant default where they do not, and no entry at all where neither exists.
 *
 * Resolved once per customer rather than per item, because a monthly run reads
 * one tenant's whole price list and then answers thousands of items out of it.
 */
export function priceListFor(
  customerId: string,
  rows: readonly LaundryPriceRow[],
): Map<ItemType, LaundryPrice> {
  const prices = new Map<ItemType, LaundryPrice>();

  for (const itemType of ITEM_TYPES) {
    // `!row.item_id` on both: a price written against one item is not the
    // price of its whole category, and letting it answer here would quietly
    // charge every kind of towel at the rate agreed for one of them.
    const own = rows.find((row) =>
      row.customer_id === customerId && row.item_type === itemType && !row.item_id);
    const fallback = rows.find((row) =>
      row.customer_id === null && row.item_type === itemType && !row.item_id);
    const row = own ?? fallback;
    if (!row) continue;
    prices.set(itemType, toPrice(row, Boolean(own)));
  }

  return prices;
}

function toPrice(row: LaundryPriceRow, isOwn: boolean): LaundryPrice {
  const bagPrice = row.bag_price === null || row.bag_price === undefined
    ? null
    : toNumber(row.bag_price);
  return {
    unitPrice: toNumber(row.unit_price),
    bagPrice: bagPrice !== null && bagPrice > 0 ? bagPrice : null,
    taxable: row.taxable !== false,
    source: isOwn ? "customer" : "default",
  };
}

/**
 * The same resolution, keyed on the **item** rather than the kind of laundry.
 *
 * Separate from `priceListFor` rather than folded into it, because they answer
 * two different questions and the callers want different ones: the price screens
 * show a row per kind of laundry, and the pricer wants the most specific price
 * for the item actually in the bag. Sharing the resolution *rule* — the
 * customer's own row wins, the tenant default answers where they have none, and
 * there is no third fallback — is what matters, and it is the same three lines.
 */
export function itemPriceListFor(
  customerId: string,
  rows: readonly LaundryPriceRow[],
): Map<string, LaundryPrice> {
  const prices = new Map<string, LaundryPrice>();
  const itemIds = [...new Set(
    rows.map((row) => row.item_id).filter((id): id is string => Boolean(id)),
  )];

  for (const itemId of itemIds) {
    const own = rows.find((row) => row.customer_id === customerId && row.item_id === itemId);
    const fallback = rows.find((row) => row.customer_id === null && row.item_id === itemId);
    const row = own ?? fallback;
    if (!row) continue;
    prices.set(itemId, toPrice(row, Boolean(own)));
  }

  return prices;
}

/**
 * The tenant's default list on its own — what a customer with no price of their
 * own is charged, and the fallback column on the per-customer screen.
 *
 * Expressed through `priceListFor` with an id no customer can hold, so the two
 * cannot drift: whatever the generator would fall back to is what the screen
 * shows.
 */
export function defaultPriceList(rows: readonly LaundryPriceRow[]): Map<ItemType, LaundryPrice> {
  return priceListFor("__no-customer__", rows);
}

/** `numeric` columns arrive as strings over PostgREST; a bad value is not a price. */
function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}
