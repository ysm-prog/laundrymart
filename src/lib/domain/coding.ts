/**
 * What a charge can honestly be coded with, given what the laundry actually holds.
 *
 * Coding a line needs two lists — the item master and the chart of accounts — and
 * a laundry may hold one, both or neither. **A control must not offer a route with
 * nothing behind it.** §27 records that lesson from the invoice composer, where an
 * "An account code" button led only to a notice saying there is no chart: *a
 * greyed-out button with a sentence under it beats a dead end dressed as a choice.*
 * The job charges editor did not learn it, and said "Add item or code" to a laundry
 * holding no accounts — so pressing it produced an item picker and an apology.
 *
 * This is that rule, stated once and outside a component so it can be tested. Both
 * screens read the same two counts and reach the same words.
 *
 * **The absence sentence names the missing list rather than the consequence.**
 * "Not coded — this charge reaches the invoice with no account on it" is true and
 * useless where no chart exists: it reads as the operator's omission, when nothing
 * they can do on that screen would fix it.
 */

import { taxableFromTaxCode } from "./accounts";

export type CodingCounts = {
  /** Sellable items on file for this laundry. */
  items: number;
  /** Postable accounts on file for this laundry — headers already excluded. */
  accounts: number;
};

export type CodingOffer = {
  /**
   * False only when both lists are empty. There is then nothing to pick from at
   * all, so the control is not rendered — the sentence stands on its own.
   */
  offered: boolean;
  /** What the control may promise. Never names a list the laundry does not hold. */
  label: string;
  /**
   * What to say about a charge carrying no account: which list is missing where
   * one is, and the plain consequence where both are present and nobody has coded it.
   */
  uncoded: string;
};

const NO_CHART =
  "No chart of accounts on file, so nothing can be coded yet";
const NO_ITEMS =
  "No items on file yet — a charge is coded by its account code";
const NEITHER =
  "No item list and no chart of accounts yet, so nothing can be coded";
const NOT_CODED =
  "Not coded — this charge reaches the invoice with no account on it";

export function codingOffer({ items, accounts }: CodingCounts): CodingOffer {
  if (items > 0 && accounts > 0) {
    return { offered: true, label: "Add item or code", uncoded: NOT_CODED };
  }
  if (items > 0) {
    // The demo laundry's shape, and any laundry whose chart has not been
    // imported: an item can still be attached, and it is worth attaching —
    // it fills the description and the rate. It just cannot produce a code.
    return { offered: true, label: "Add an item", uncoded: NO_CHART };
  }
  if (accounts > 0) {
    // The real laundry's shape while its item master is still arriving: the
    // code is picked per line, which is what §27 says the composer defaults to.
    return { offered: true, label: "Add a code", uncoded: NO_ITEMS };
  }
  return { offered: false, label: "", uncoded: NEITHER };
}

/* ------------------------------------------------------------------ *
 * Choosing an item fills the rest of the charge.
 * ------------------------------------------------------------------ */

/**
 * What a charge line looks like at the moment somebody picks an item for it.
 * Only the three fields the choice may overwrite — the rest is untouched.
 */
export type ChargeSnapshot = {
  description: string;
  unit_price?: number | string | null;
  gl_account_id?: string | null;
};

/** The item as the pickers hold it. */
export type ItemChoice = {
  id: string;
  name: string;
  sell_price?: number | string | null;
  tax_code?: string | null;
  income_account_id?: string | null;
};

export type ChargePatch = {
  source_item_id: string;
  gl_account_id?: string | null;
  description?: string;
  unit_price?: number;
  taxable?: boolean;
};

/**
 * **Picking an item fills the rest of the line, and never overwrites a person.**
 *
 * The rule is the same wherever the item is chosen — the type-ahead in the
 * description box, or the item field under the row — so it lives here rather
 * than in the component that happened to need it first. Three refusals in it,
 * each one a way this could quietly get a charge wrong:
 *
 * - **A description somebody typed is left alone.** A charge often reads
 *   "Bath towels — 40 collected 14 Aug", which the item name would flatten.
 *   Only a blank one is filled.
 * - **A rate somebody typed is left alone**, and a zero list price never
 *   overwrites anything: 252 of Adelaide's 254 items carry no selling price,
 *   because they are things the laundry buys. What a customer pays comes from
 *   `laundry_prices`, so a 0 here means "no list price", not "free".
 * - **An account already on the charge wins.** Choosing a code by hand is a
 *   deliberate override, and picking an item must not undo it.
 *
 * **`descriptionIsQuery` is the one thing the rule cannot work out for itself**,
 * and getting it wrong is visible on screen. Typing `tw` into the description
 * box and picking the match must leave "Towels - Wash & Dry Only" — the `tw` was
 * a search, not a description, and keeping it would be absurd. Choosing the same
 * item from the row's item field, under a description already reading "Bath
 * towels — 40 collected 14 Aug", must leave that sentence alone. "Never
 * overwrite what somebody typed" and "a new pick should describe the new thing"
 * contradict each other unless the caller says which it is holding — the same
 * distinction §27 records the invoice composer needing.
 *
 * `accountTaxCode` is the tax code of the item's own income account, looked up
 * by the caller — the item's own code wins, and the account answers only where
 * the item is silent.
 */
export function chargePatchForItem(
  row: ChargeSnapshot,
  item: ItemChoice,
  options: { accountTaxCode?: string | null; descriptionIsQuery?: boolean } = {},
): ChargePatch {
  const price = Number(item.sell_price ?? 0);
  const taxable = taxableFromTaxCode(item.tax_code) ?? taxableFromTaxCode(options.accountTaxCode);
  const takesName = options.descriptionIsQuery || !row.description.trim();

  return {
    source_item_id: item.id,
    gl_account_id: row.gl_account_id ?? item.income_account_id ?? null,
    ...(takesName ? { description: item.name } : {}),
    ...(Number(row.unit_price ?? 0) === 0 && price > 0 ? { unit_price: price } : {}),
    ...(taxable === null ? {} : { taxable }),
  };
}
