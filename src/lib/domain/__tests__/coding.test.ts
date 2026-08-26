import { describe, expect, it } from "vitest";
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
