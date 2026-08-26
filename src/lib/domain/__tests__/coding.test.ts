import { describe, expect, it } from "vitest";
import { codingOffer } from "../coding";

/**
 * Driven off the requirement — "never offer a route with nothing behind it" —
 * rather than off the implementation, so a label that starts promising a list
 * the laundry does not hold fails here rather than on somebody's screen.
 *
 * The two live shapes are asserted by name because they are what this exists
 * for: the demo laundry holds items and no chart, and the real one held a
 * chart and no items until its item master arrived.
 */
describe("codingOffer", () => {
  it("offers both when the laundry holds both", () => {
    const offer = codingOffer({ items: 254, accounts: 261 });
    expect(offer.offered).toBe(true);
    expect(offer.label).toBe("Add item or code");
    expect(offer.uncoded).toMatch(/^Not coded/);
  });

  it("never promises a code to a laundry with no chart of accounts", () => {
    // Harbour Commercial Laundry: 6 items, 0 accounts.
    const offer = codingOffer({ items: 6, accounts: 0 });
    expect(offer.offered).toBe(true);
    expect(offer.label).toBe("Add an item");
    expect(offer.label).not.toMatch(/code/i);
    expect(offer.uncoded).toMatch(/no chart of accounts/i);
  });

  it("never promises an item to a laundry with no item list", () => {
    // Adelaide Towel Service, before its item master arrived: 268 accounts, 0 items.
    const offer = codingOffer({ items: 0, accounts: 261 });
    expect(offer.offered).toBe(true);
    expect(offer.label).toBe("Add a code");
    expect(offer.label).not.toMatch(/item/i);
    expect(offer.uncoded).toMatch(/no items/i);
  });

  it("offers nothing at all when neither list exists", () => {
    const offer = codingOffer({ items: 0, accounts: 0 });
    expect(offer.offered).toBe(false);
    expect(offer.label).toBe("");
    expect(offer.uncoded).toMatch(/no item list and no chart/i);
  });

  it("says why rather than blaming the operator, wherever a list is missing", () => {
    // The sentence a laundry cannot act on from the charges screen must name the
    // missing list. Only the both-present case reports the bare consequence.
    for (const counts of [{ items: 6, accounts: 0 }, { items: 0, accounts: 3 }, { items: 0, accounts: 0 }]) {
      expect(codingOffer(counts).uncoded).not.toMatch(/^Not coded/);
    }
    expect(codingOffer({ items: 1, accounts: 1 }).uncoded).toMatch(/^Not coded/);
  });

  it("treats one of a list as a list", () => {
    expect(codingOffer({ items: 1, accounts: 1 }).label).toBe("Add item or code");
  });
});

import { chargePatchForItem } from "../coding";

const TW = {
  id: "item-tw",
  name: "Towels - Wash & Dry Only",
  sell_price: "0.00",     // Adelaide's real state: 252 of 254 carry no list price.
  tax_code: null,
  income_account_id: null,
};
const BLANK = { description: "", unit_price: 0, gl_account_id: null };

describe("chargePatchForItem", () => {
  it("names the item and fills a blank description", () => {
    const patch = chargePatchForItem(BLANK, TW);
    expect(patch.source_item_id).toBe("item-tw");
    expect(patch.description).toBe("Towels - Wash & Dry Only");
  });

  it("never overwrites a description somebody typed", () => {
    const patch = chargePatchForItem(
      { ...BLANK, description: "Bath towels — 40 collected 14 Aug" }, TW,
    );
    expect(patch.description).toBeUndefined();
  });

  it("never overwrites a rate somebody typed", () => {
    const patch = chargePatchForItem(
      { ...BLANK, unit_price: "0.22" }, { ...TW, sell_price: 9.99 },
    );
    expect(patch.unit_price).toBeUndefined();
  });

  it("treats a zero list price as no price, not as free", () => {
    // The ordinary Adelaide case. Leaving unit_price alone is what lets the
    // laundry price list answer instead.
    expect(chargePatchForItem(BLANK, TW).unit_price).toBeUndefined();
    expect(chargePatchForItem(BLANK, { ...TW, sell_price: 2 }).unit_price).toBe(2);
  });

  it("keeps an account chosen by hand, and takes the item's otherwise", () => {
    expect(chargePatchForItem({ ...BLANK, gl_account_id: "by-hand" },
      { ...TW, income_account_id: "from-item" }).gl_account_id).toBe("by-hand");
    expect(chargePatchForItem(BLANK,
      { ...TW, income_account_id: "from-item" }).gl_account_id).toBe("from-item");
  });

  it("takes GST from the item, then from its account, and otherwise says nothing", () => {
    expect(chargePatchForItem(BLANK, { ...TW, tax_code: "GST" }).taxable).toBe(true);
    expect(chargePatchForItem(BLANK, { ...TW, tax_code: "FRE" }).taxable).toBe(false);
    // Silent item, so the account answers.
    expect(chargePatchForItem(BLANK, TW, { accountTaxCode: "GST" }).taxable).toBe(true);
    // Neither says anything: leave the operator's own tick alone.
    expect(chargePatchForItem(BLANK, TW).taxable).toBeUndefined();
  });
});

describe("chargePatchForItem · what the typed text actually was", () => {
  const TYPED = { description: "Bath towels — 40 collected 14 Aug", unit_price: 0, gl_account_id: null };

  it("replaces the text when it was a search query, not a description", () => {
    // Typing `tw` in the description box and picking the match: keeping "tw"
    // as the charge description would be absurd.
    const patch = chargePatchForItem(
      { ...BLANK, description: "tw" }, TW, { descriptionIsQuery: true },
    );
    expect(patch.description).toBe("Towels - Wash & Dry Only");
  });

  it("still leaves a real description alone when the item is chosen elsewhere", () => {
    expect(chargePatchForItem(TYPED, TW).description).toBeUndefined();
  });

  it("fills a blank description either way", () => {
    expect(chargePatchForItem(BLANK, TW).description).toBe("Towels - Wash & Dry Only");
    expect(chargePatchForItem(BLANK, TW, { descriptionIsQuery: true }).description)
      .toBe("Towels - Wash & Dry Only");
  });
});
