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
