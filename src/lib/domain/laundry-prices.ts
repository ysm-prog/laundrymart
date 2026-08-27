/**
 * The laundry price list, keyed on the item code the staff actually type.
 *
 * **What this replaces, and why.** `laundry_prices` (0018) has always been able
 * to hold a price either for a *kind of laundry* — one of the nine `ITEM_TYPES`
 * — or, since 0032, for one row of the item master. Both tiers are read by
 * `priceJob`, and until now **only the first could be written**: the two price
 * screens rendered nine fixed rows and never touched `item_id`. So the item tier
 * was a feature with no entry point, and the nine categories were the whole of
 * the list an owner could maintain.
 *
 * That gap had a visible cost on the live deployment, and it is the reason this
 * module exists rather than a preference: with no usable price list, the laundry
 * put the price **into the item code**. `T22`, `T38` and `T40` are three items
 * all named "Towels - Black", differing only in rate. Three master records where
 * there should be one item and three prices — and every one of them a separate
 * thing to keep in step with the books.
 *
 * So the list is per item code now. The category tier is left in
 * `laundry-billing.ts` because jobs written before an item was picked still
 * resolve through it and `priceJob` still consults it, but nothing writes one
 * any more.
 *
 * Pure: no database, no React. The screens are the thin part — a rule stated
 * inside a component is a rule no unit test can reach, which is the trap this
 * repo records shipping three times.
 */

import { ITEM_TYPES, type ItemType } from "./laundry-orders";
import type { LaundryPrice, LaundryPriceRow } from "./laundry-billing";
import { GST_RATE_FALLBACK, lineRateFromItem, sellPriceLabel } from "./items";
import { taxableFromTaxCode } from "./accounts";
import { money } from "@/lib/format";
import { round2 } from "./pricing";

/** What these rules need of an item. Deliberately less than a row. */
export type PricedItem = {
  id: string;
  item_code: string | null;
  name: string;
  laundry_category?: string | null;
  selling_unit?: string | null;
  sell_price?: number | string | null;
  sell_price_basis?: string | null;
};

/** One line of the price screen: the item, its price here, and what it falls back to. */
export type ItemPriceRow<T extends PricedItem = PricedItem> = {
  item: T;
  /** The price stored in *this* scope. Null where this scope has none. */
  price: PriceValue | null;
  /**
   * The tenant default, shown beside a customer's own row — so leaving it blank
   * reads as "charge them the usual price" rather than as an omission.
   */
  fallback: PriceValue | null;
};

export type PriceValue = {
  unitPrice: number;
  bagPrice: number | null;
  taxable: boolean;
};

/* ------------------------------------------------------ the item_type column */

/**
 * The `item_type` a per-item price row must carry.
 *
 * `laundry_prices.item_type` is NOT NULL and predates the item tier, so a
 * per-item row still has to name one. It is **derived from the item, never
 * typed**, for the same reason `sync_laundry_item_type` derives a job row's:
 * a price filed against TOW001 under "sheets" would sit in the sheet bucket
 * with nobody able to see why.
 *
 * `other` for an item with no category — a chemical, a glove, a fee — because
 * those are still sellable and a laundry may well want a price for one. It does
 * not make them laundry: `priceListFor` ignores every row carrying an
 * `item_id`, so a per-item row can never answer for a whole category.
 */
export function laundryPriceItemType(item: Pick<PricedItem, "laundry_category">): ItemType {
  const category = item.laundry_category?.trim();
  return category && (ITEM_TYPES as readonly string[]).includes(category)
    ? (category as ItemType)
    : "other";
}

/* --------------------------------------------------------- building the rows */

const toValue = (price: LaundryPrice | undefined): PriceValue | null =>
  price ? { unitPrice: price.unitPrice, bagPrice: price.bagPrice, taxable: price.taxable } : null;

/**
 * This scope's price for each item, and what it falls back to.
 *
 * `customerId` null is the tenant's own list, which has no fallback beneath it —
 * a kind of laundry with no price there is genuinely unpriced, which the pricer
 * reports rather than billing at nothing.
 *
 * Resolved through the same map `priceJob` reads, so the screen cannot show a
 * price the pricer would not charge.
 */
export function buildItemPriceRows<T extends PricedItem>(
  items: readonly T[],
  rows: readonly LaundryPriceRow[],
  customerId: string | null,
): Array<ItemPriceRow<T>> {
  const own = new Map<string, LaundryPrice>();
  const defaults = new Map<string, LaundryPrice>();

  for (const row of rows) {
    if (!row.item_id) continue;
    const target = row.customer_id === null
      ? defaults
      : (customerId !== null && row.customer_id === customerId ? own : null);
    // First wins, matching `priceListFor`'s own `.find()`: the unique index
    // makes a second row impossible, and picking a winner deterministically
    // beats letting the plan's row order decide.
    if (target && !target.has(row.item_id)) target.set(row.item_id, toPrice(row));
  }

  const scope = customerId === null ? defaults : own;
  return items.map((item) => ({
    item,
    price: toValue(scope.get(item.id)),
    fallback: customerId === null ? null : toValue(defaults.get(item.id)),
  }));
}

/** Restated rather than imported: `laundry-billing.ts` keeps its `toPrice` private. */
function toPrice(row: LaundryPriceRow): LaundryPrice {
  const bag = row.bag_price === null || row.bag_price === undefined ? null : toNumber(row.bag_price);
  return {
    unitPrice: toNumber(row.unit_price),
    bagPrice: bag !== null && bag > 0 ? bag : null,
    taxable: row.taxable !== false,
    source: row.customer_id === null ? "default" : "customer",
  };
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

/* ------------------------------------------------------------- the live rate */

/**
 * What an item costs on a line **right now** — the whole of "an owner's edit
 * reflects live wherever an item code is linked".
 *
 * Two sources, and the order is the point:
 *
 * 1. **The laundry price list.** What the owner set for this item code, for
 *    this customer or as the usual price. Taken *verbatim*: a list rate is
 *    already what the customer pays, GST and all — the same convention
 *    `priceFromList` writes a job charge under, and the same one
 *    `recalculate_invoice` totals a line under (0043).
 * 2. **The item's own selling price**, grossed up through `lineRateFromItem`
 *    when the item states it GST-exclusive. This is what every screen did
 *    before there was a list, and it is what still answers for an item nobody
 *    has priced.
 *
 * **The list rate is deliberately not grossed up, and mixing the two up moves
 * money.** `items.sell_price` is MYOB's list price and carries a *basis*; a
 * price-list rate is a rate the owner typed into a box labelled "what the
 * customer pays". Applying the item's basis to the owner's number would add 10%
 * to a figure they already decided, on a charge that approval then freezes.
 *
 * `taxable` follows the same tier: where the list answered, the list's GST tick
 * is the answer, so picking an item by hand and pressing "Price this job" cannot
 * disagree about the same item. Where it did not, the caller's own resolution
 * (the item's tax code, then its account's) is left exactly as it was — `null`
 * means "no opinion here".
 */
export function liveItemRate(
  item: Pick<PricedItem, "sell_price" | "sell_price_basis">,
  listPrice: PriceValue | null | undefined,
  options: { taxable?: boolean | null; gstRate?: number } = {},
): { rate: number; taxable: boolean | null; source: "list" | "item" } {
  if (listPrice && listPrice.unitPrice > 0) {
    return { rate: round2(listPrice.unitPrice), taxable: listPrice.taxable, source: "list" };
  }
  const taxable = options.taxable ?? null;
  return {
    rate: lineRateFromItem(
      item.sell_price, item.sell_price_basis, taxable ?? true,
      options.gstRate ?? GST_RATE_FALLBACK,
    ),
    taxable,
    source: "item",
  };
}

/* ---------------------------------------------------------- the row's hint */

/**
 * The line under an item code on the price screen.
 *
 * Three different things to say, and telling them apart is the whole of it —
 * the first draft said "No price set" under a row that plainly had a price in
 * its box, because it only asked whether there was a *fallback*, and on the
 * usual list there never is one. Found by looking at the gallery rather than by
 * reading the code, which is §10b's argument for the gallery in one line.
 *
 * - **A customer's screen** shows the usual price, whether or not they override
 *   it. That is what makes a blank field read as "charge them the usual price"
 *   rather than as an omission, and it is the number somebody setting an
 *   override is deciding against.
 * - **A row with no price on either list** says so, and says what it bills at
 *   instead: `liveItemRate` falls back to the item's own selling price, so a
 *   blank row is not "this bills at nothing" and claiming it would be wrong.
 *   Where the item has no selling price either, the bare sentence is the honest
 *   one — that job comes back unpriced, which is what the pricer reports.
 * - **A priced row** says nothing but the unit the rate is per, because `$0.22`
 *   and `$0.22` read identically whether one is per towel and the other per box
 *   of a hundred (§25).
 */
export function priceRowHint(row: ItemPriceRow): string | null {
  if (row.fallback) {
    return `Usual price ${money(row.fallback.unitPrice)}`
      + (row.fallback.bagPrice ? ` \u00b7 ${money(row.fallback.bagPrice)} a bag` : "");
  }
  if (row.price) {
    const unit = row.item.selling_unit?.trim();
    return unit ? `Priced per ${unit}` : null;
  }
  const own = Number(row.item.sell_price ?? 0);
  if (!Number.isFinite(own) || own <= 0) return "No price set";
  return `No price set \u2014 currently bills at the item\u2019s `
    + sellPriceLabel(money(own), row.item.selling_unit);
}

/* -------------------------------------------- filling the list from MYOB --- */

/**
 * The list price an item's own selling price becomes.
 *
 * **This is a conversion, not a copy, and getting it wrong moves money.**
 * `items.sell_price` is MYOB's list price and carries a *basis*: 111 of this
 * laundry's 119 priced items state theirs GST-**exclusive**. A
 * `laundry_prices.unit_price` is what the customer pays, GST included — the same
 * convention `priceFromList` writes a charge under and `recalculate_invoice`
 * totals a line under (0043). So an exclusive price has to be grossed up on the
 * way in, or every rate on the list lands short by exactly the GST.
 *
 * Checked against the one piece of real evidence rather than reasoned about:
 * `T40` is $0.40 exclusive and the charge frozen on `LJ00012` is **$0.44**. The
 * same number this returns.
 *
 * Three pass straight through, each a decision `lineRateFromItem` already makes:
 * a price already stated GST-inclusive, a line carrying no GST (`FRE`/`N-T`), and
 * a basis nobody has stated — never guessed at, because inventing an answer here
 * silently re-rates the laundry.
 *
 * Returns null for an item with no selling price. **Not zero**: 23 of the
 * laundry's sellable items have no price in MYOB either, and a zero would bill
 * them silently at nothing where a missing row is reported as unpriced.
 */
export function seedPriceFromItem(
  item: Pick<PricedItem, "sell_price" | "sell_price_basis"> & { tax_code?: string | null },
  gstRate: number = GST_RATE_FALLBACK,
): { unitPrice: number; taxable: boolean } | null {
  const listed = Number(item.sell_price ?? 0);
  if (!Number.isFinite(listed) || listed <= 0) return null;
  // The app treats a charge as taxable unless something says otherwise, so an
  // item with no tax code takes that default — the same direction
  // `chargePatchForItem` takes.
  const taxable = taxableFromTaxCode(item.tax_code) ?? true;
  const unitPrice = lineRateFromItem(listed, item.sell_price_basis, taxable, gstRate);
  return unitPrice > 0 ? { unitPrice, taxable } : null;
}
