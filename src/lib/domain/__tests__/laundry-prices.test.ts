import { describe, expect, it } from "vitest";
import {
  buildItemPriceRows, laundryPriceItemType, liveItemRate, priceRowHint, seedPriceFromItem,
  type ItemPriceRow, type PricedItem,
} from "../laundry-prices";
import type { LaundryPriceRow } from "../laundry-billing";
import { priceListFor } from "../laundry-billing";
import { chargePatchForItem } from "../coding";

const T22: PricedItem = {
  id: "i-t22", item_code: "T22", name: "Towels - Black",
  laundry_category: "towels", sell_price: 0.22, sell_price_basis: "exclusive",
};
const TW: PricedItem = {
  id: "i-tw", item_code: "TW", name: "Towels - Wash & Dry Only",
  laundry_category: "towels", sell_price: 0.2, sell_price_basis: "exclusive",
};
const FEE: PricedItem = {
  id: "i-fee", item_code: "DEL", name: "Delivery", laundry_category: null, sell_price: 0,
};

const row = (over: Partial<LaundryPriceRow>): LaundryPriceRow => ({
  customer_id: null, item_type: "towels", item_id: "i-t22",
  unit_price: 0.24, bag_price: null, taxable: true, ...over,
});

describe("laundryPriceItemType", () => {
  it("takes the item's own category rather than the caller's word for it", () => {
    expect(laundryPriceItemType(T22)).toBe("towels");
    expect(laundryPriceItemType({ laundry_category: "pillowcases" })).toBe("pillowcases");
  });

  it("files an item that is not laundry under `other` rather than refusing it", () => {
    // A delivery fee and a drum of detergent are sellable and are not laundry a
    // customer hands in. `item_type` is NOT NULL on the price row, so they need
    // an answer, and `other` is the honest one.
    expect(laundryPriceItemType(FEE)).toBe("other");
  });

  it("refuses a category the check constraint would refuse", () => {
    // Anything outside the nine would fail `chk_items_laundry_category` on the
    // way in, so a stray value must not become the price row's `item_type`.
    expect(laundryPriceItemType({ laundry_category: "beach_towels" })).toBe("other");
  });
});

describe("buildItemPriceRows", () => {
  it("puts the tenant's own price on the usual list, with no fallback beneath it", () => {
    const rows = buildItemPriceRows([T22, TW], [row({})], null);
    expect(rows[0]).toMatchObject({
      item: T22, price: { unitPrice: 0.24, bagPrice: null, taxable: true }, fallback: null,
    });
    expect(rows[1]).toMatchObject({ item: TW, price: null, fallback: null });
  });

  it("lets a customer's own price win, and shows the usual one under it", () => {
    const rows = buildItemPriceRows([T22], [
      row({}),
      row({ customer_id: "c1", unit_price: 0.2, bag_price: 12 }),
    ], "c1");
    expect(rows[0]?.price).toEqual({ unitPrice: 0.2, bagPrice: 12, taxable: true });
    expect(rows[0]?.fallback).toEqual({ unitPrice: 0.24, bagPrice: null, taxable: true });
  });

  it("renders an inherited price as a blank field over its fallback", () => {
    // The distinction the customer screen is built on: an override that was not
    // set must not render as one that was, or saving would turn every inherited
    // price into a stored copy that then stops following the usual list.
    const rows = buildItemPriceRows([T22], [row({})], "c1");
    expect(rows[0]?.price).toBeNull();
    expect(rows[0]?.fallback).toEqual({ unitPrice: 0.24, bagPrice: null, taxable: true });
  });

  it("keeps another customer's price out of this customer's list", () => {
    const rows = buildItemPriceRows([T22], [row({ customer_id: "c2", unit_price: 9 })], "c1");
    expect(rows[0]?.price).toBeNull();
    expect(rows[0]?.fallback).toBeNull();
  });

  it("ignores a category row, which is not a price for any one item", () => {
    // `laundry_prices` still holds pre-0032 rows keyed on the kind of laundry.
    // Letting one answer here would charge every black towel at the rate agreed
    // for towels in general — the same rule `priceListFor` applies in reverse.
    const rows = buildItemPriceRows([T22], [row({ item_id: null, unit_price: 5 })], null);
    expect(rows[0]?.price).toBeNull();
  });

  it("reads a numeric column that arrived as a string over PostgREST", () => {
    const rows = buildItemPriceRows([T22], [
      row({ unit_price: "0.24", bag_price: "12.00" }),
    ], null);
    expect(rows[0]?.price).toEqual({ unitPrice: 0.24, bagPrice: 12, taxable: true });
  });

  it("treats a zero bag price as no bag price", () => {
    // `priceFromList` bills by the bag only when there is a bag rate, so a
    // stored zero must not read as "bills at nothing per bag".
    const rows = buildItemPriceRows([T22], [row({ bag_price: 0 })], null);
    expect(rows[0]?.price?.bagPrice).toBeNull();
  });

  it("does not disagree with the tier the pricer reads", () => {
    // The screen and `priceListFor` resolve two different questions off one
    // table, and the one thing they must agree on is that a per-item row is not
    // a category price. Asserted together, because a change to either alone is
    // exactly how the screen comes to show a price the pricer will not charge.
    const rows: LaundryPriceRow[] = [row({}), row({ item_id: null, unit_price: 5 })];
    expect(buildItemPriceRows([T22], rows, null)[0]?.price?.unitPrice).toBe(0.24);
    expect(priceListFor("c1", rows).get("towels")?.unitPrice).toBe(5);
  });
});

describe("liveItemRate", () => {
  it("takes a listed rate verbatim, GST and all", () => {
    // A list rate is what the owner typed into a box labelled "what the customer
    // pays". Grossing it up would add 10% to a number they already decided — on
    // a charge that approval then freezes.
    expect(liveItemRate(T22, { unitPrice: 0.24, bagPrice: null, taxable: true }, { taxable: true }))
      .toEqual({ rate: 0.24, taxable: true, source: "list" });
  });

  it("grosses up the item's own price where the list is silent", () => {
    // 0043: a line amount is GST-inclusive, so an item stating its price
    // exclusive has to be converted or the line bills short by exactly the GST.
    expect(liveItemRate(T22, null, { taxable: true, gstRate: 0.1 }))
      .toEqual({ rate: 0.24, taxable: true, source: "item" });
  });

  it("prefers the list even when the item's own price is higher", () => {
    expect(liveItemRate({ sell_price: 5, sell_price_basis: "exclusive" },
      { unitPrice: 0.24, bagPrice: null, taxable: true }, { taxable: true }).rate).toBe(0.24);
  });

  it("carries the list's GST answer, so the two paths cannot disagree", () => {
    // Picking the item by hand and pressing "Price this job" must not produce
    // different GST for the same code: `priceFromList` writes `price.taxable`,
    // so where the list answered, so does this.
    expect(liveItemRate(T22, { unitPrice: 1, bagPrice: null, taxable: false }, { taxable: true }))
      .toMatchObject({ taxable: false, rate: 1 });
  });

  it("leaves the caller's GST answer alone where the list is silent", () => {
    expect(liveItemRate(T22, null, { taxable: null }).taxable).toBeNull();
  });

  it("treats a listed zero as no price rather than as free", () => {
    // 137 of this laundry's sellable items carry no price at all, so a zero has
    // to fall through — otherwise saving a blank row would bill at nothing.
    expect(liveItemRate(T22, { unitPrice: 0, bagPrice: 12, taxable: true }, { taxable: true }))
      .toMatchObject({ rate: 0.24, source: "item" });
  });

  it("does not gross up a listed rate on a GST-free line either", () => {
    expect(liveItemRate({ sell_price: 100, sell_price_basis: "exclusive" },
      { unitPrice: 90, bagPrice: null, taxable: false }, { taxable: true }).rate).toBe(90);
  });
});

describe("chargePatchForItem, with a price list behind it", () => {
  const listed = { unitPrice: 0.24, bagPrice: null, taxable: true };

  it("fills a charge from the list rather than from the item's selling price", () => {
    const patch = chargePatchForItem(
      { description: "" },
      { id: "i-t22", name: "Towels - Black", sell_price: 5, tax_code: "GST", list_price: listed },
    );
    expect(patch).toMatchObject({ unit_price: 0.24, taxable: true, description: "Towels - Black" });
  });

  it("still grosses up the item's price when nothing is listed", () => {
    const patch = chargePatchForItem(
      { description: "" },
      {
        id: "i-t22", name: "Towels - Black", sell_price: 0.4,
        sell_price_basis: "exclusive", tax_code: "GST",
      },
      { gstRate: 0.1 },
    );
    // The rate LJ00012 was actually frozen at on the live deployment, which is
    // what this path did before the list existed and must go on doing.
    expect(patch.unit_price).toBe(0.44);
  });

  it("still leaves a rate somebody typed alone", () => {
    const patch = chargePatchForItem(
      { description: "Bath towels — 40 collected 14 Aug", unit_price: 1.5 },
      { id: "i-t22", name: "Towels - Black", list_price: listed },
    );
    expect(patch.unit_price).toBeUndefined();
    expect(patch.description).toBeUndefined();
  });

  it("lets the list's GST answer beat the item's tax code", () => {
    // The item says GST and the owner has listed the rate as GST-free. The
    // owner's price list is the pricing answer, and `priceFromList` already
    // treats it that way — so the hand-picked path agrees rather than billing
    // the same code two ways.
    const patch = chargePatchForItem(
      { description: "" },
      {
        id: "i-t22", name: "Towels - Black", sell_price: 1, tax_code: "GST",
        list_price: { unitPrice: 0.9, bagPrice: null, taxable: false },
      },
    );
    expect(patch).toMatchObject({ taxable: false, unit_price: 0.9 });
  });
});

describe("priceRowHint", () => {
  const hint = (over: Partial<ItemPriceRow>) => priceRowHint({
    item: T22, price: null, fallback: null, ...over,
  });

  it("shows the usual price on a customer's screen, override or not", () => {
    const line = hint({ fallback: { unitPrice: 0.24, bagPrice: 12, taxable: true } });
    expect(line).toBe("Usual price $0.24 \u00b7 $12.00 a bag");
    // And still shows it when they *do* override, because that is the number
    // the person setting the override is deciding against.
    expect(hint({
      price: { unitPrice: 0.2, bagPrice: null, taxable: true },
      fallback: { unitPrice: 0.24, bagPrice: null, taxable: true },
    })).toBe("Usual price $0.24");
  });

  /*
   * The defect this rule was extracted for, found by looking at the gallery
   * rather than by reading the code.
   *
   * The first draft asked only whether there was a *fallback*, so on the usual
   * list — where there never is one — every row said "No price set", including
   * the rows with a price sitting in the box beside the sentence.
   */
  it("says nothing about a missing price on a row that has one", () => {
    expect(hint({ price: { unitPrice: 0.24, bagPrice: null, taxable: true } })).toBeNull();
  });

  it("names the unit a priced row is priced per", () => {
    expect(priceRowHint({
      item: { ...T22, selling_unit: "ctn" },
      price: { unitPrice: 22, bagPrice: null, taxable: true },
      fallback: null,
    })).toBe("Priced per ctn");
  });

  it("says what an unpriced row bills at instead, rather than implying nothing", () => {
    // `liveItemRate` falls through to the item's own selling price, so a blank
    // row does not bill at zero and saying it does would be wrong.
    expect(hint({})).toBe("No price set \u2014 currently bills at the item\u2019s $0.22");
  });

  it("says only that, where the item has no selling price either", () => {
    expect(hint({ item: FEE })).toBe("No price set");
  });
});

describe("seedPriceFromItem", () => {
  /*
   * The conversion the "Fill from my item prices" button performs, and the one
   * number in this file checked against a real frozen charge rather than
   * reasoned about: `T40` is $0.40 GST-exclusive on the live item master, and
   * the charge frozen on `LJ00012` is $0.44.
   */
  it("grosses up a GST-exclusive item price, because a list rate is what the customer pays", () => {
    expect(seedPriceFromItem(
      { sell_price: 0.4, sell_price_basis: "exclusive", tax_code: "GST" }, 0.1,
    )).toEqual({ unitPrice: 0.44, taxable: true });
  });

  it("leaves a GST-inclusive price exactly as it is", () => {
    expect(seedPriceFromItem(
      { sell_price: 0.38, sell_price_basis: "inclusive", tax_code: "GST" }, 0.1,
    )).toEqual({ unitPrice: 0.38, taxable: true });
  });

  it("does not gross up a line that carries no GST", () => {
    // `Dis` on the live master: $13.00, stated exclusive, tax code N-T. There is
    // no GST to add, and adding it would over-charge by 10%.
    expect(seedPriceFromItem(
      { sell_price: 13, sell_price_basis: "exclusive", tax_code: "N-T" }, 0.1,
    )).toEqual({ unitPrice: 13, taxable: false });
  });

  it("never guesses at a basis nobody stated", () => {
    expect(seedPriceFromItem(
      { sell_price: 5, sell_price_basis: null, tax_code: "GST" }, 0.1,
    )).toEqual({ unitPrice: 5, taxable: true });
  });

  it("treats an item with no tax code as taxable, like every other charge here", () => {
    expect(seedPriceFromItem({ sell_price: 1, sell_price_basis: "exclusive" }, 0.1))
      .toEqual({ unitPrice: 1.1, taxable: true });
  });

  it("refuses an unpriced item rather than seeding a zero", () => {
    // 23 of the laundry's sellable items carry no MYOB price. A zero row would
    // bill them silently at nothing; no row at all is reported as unpriced.
    expect(seedPriceFromItem({ sell_price: 0, sell_price_basis: "exclusive" })).toBeNull();
    expect(seedPriceFromItem({ sell_price: null, sell_price_basis: null })).toBeNull();
  });

  it("reads the laundry's own GST rate rather than assuming 10%", () => {
    expect(seedPriceFromItem(
      { sell_price: 100, sell_price_basis: "exclusive", tax_code: "GST" }, 0.15,
    )).toEqual({ unitPrice: 115, taxable: true });
  });

  it("agrees with what the pricer would charge for the same item", () => {
    // The seeded rate is taken verbatim by `liveItemRate`, and an unseeded item
    // falls through to the same gross-up — so filling the list must not change
    // what anything costs. Asserted together, because that is the property.
    const item = { sell_price: 0.4, sell_price_basis: "exclusive" };
    const seeded = seedPriceFromItem({ ...item, tax_code: "GST" }, 0.1)!;
    expect(liveItemRate(item, null, { taxable: true, gstRate: 0.1 }).rate)
      .toBe(liveItemRate(item, { ...seeded, bagPrice: null }, { taxable: true, gstRate: 0.1 }).rate);
  });
});
