/**
 * What choosing an item does to a charge line.
 *
 * **An account code is never a question the job charges screen asks.** MYOB's
 * model, and the client's instruction: you pick the Item and the Category comes
 * with it. So the code travels from `items.income_account_id` and no ledger
 * account picker is drawn on a charge line — the invoice composer is where one
 * is chosen by hand, on the rare line that is in neither list.
 *
 * This module held a `codingOffer` rule until 2026-08-26, deciding what an
 * item-or-code control could honestly promise. It went with the control.
 */

import { taxableFromTaxCode } from "./accounts";

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
