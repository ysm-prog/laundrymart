import { describe, expect, it } from "vitest";
import {
  autoPriceSentence, itemSellPriceList, needsPrice, priceJob, pricingSourceLabel,
} from "../job-pricing";
import type { OrderItemInput } from "../laundry-orders";

function item(overrides: Partial<OrderItemInput> = {}): OrderItemInput {
  return { item_type: "towels", quantity_type: "exact", exact_quantity: 10, ...overrides };
}

describe("the item's own selling price is the last tier (brief 1.3)", () => {
  const sell = itemSellPriceList([
    { id: "item-t40", sell_price: 0.4, sell_price_basis: "exclusive", tax_code: "GST" },
    { id: "item-gtw", sell_price: 0.38, sell_price_basis: "inclusive", tax_code: "GST" },
    { id: "item-dis", sell_price: 13, sell_price_basis: "exclusive", tax_code: "N-T" },
    { id: "item-free", sell_price: 0, sell_price_basis: null, tax_code: null },
  ], 0.1);

  it("grosses an exclusive price up, the way every item price becomes money", () => {
    expect(sell.get("item-t40")).toMatchObject({ unitPrice: 0.44, taxable: true, source: "item" });
    expect(sell.get("item-gtw")?.unitPrice).toBe(0.38);
    expect(sell.get("item-dis")).toMatchObject({ unitPrice: 13, taxable: false });
  });

  it("treats a zero price as no price, never a free line", () => {
    expect(sell.has("item-free")).toBe(false);
  });

  it("prices a job from it only where the card and the list are silent", () => {
    const fromItem = priceJob({
      items: [item({ item_id: "item-t40", exact_quantity: 100 })],
      rateLines: [], itemSellPrices: sell,
    });
    expect(fromItem.lines).toHaveLength(1);
    expect(fromItem.lines[0]).toMatchObject({ unit_price: 0.44, amount: 44, pricing_model: "item_price" });
    expect(fromItem.unpriced).toHaveLength(0);

    const fromList = priceJob({
      items: [item({ item_id: "item-t40", exact_quantity: 100 })],
      rateLines: [], itemSellPrices: sell,
      itemPriceList: new Map([["item-t40", { unitPrice: 0.5, bagPrice: null, taxable: true, source: "default" as const }]]),
    });
    expect(fromList.lines[0]).toMatchObject({ unit_price: 0.5, pricing_model: "per_item" });
  });

  it("still reports a bag count with no bag price — a selling price is per piece", () => {
    const result = priceJob({
      items: [item({ item_id: "item-t40", quantity_type: "bulk_lot", exact_quantity: null, bag_count: 4 })],
      rateLines: [], itemSellPrices: sell,
    });
    expect(result.lines).toHaveLength(0);
    expect(result.unpriced[0]!.reason).toBe("no_bag_rate");
  });

  it("names the tier that answered", () => {
    expect(pricingSourceLabel([{ source_agreement_id: null, pricing_model: "item_price" }], null))
      .toBe("the item's selling price");
    expect(pricingSourceLabel([
      { source_agreement_id: null, pricing_model: "per_item" },
      { source_agreement_id: null, pricing_model: "item_price" },
    ], null)).toBe("the laundry price list and the item's selling price");
    expect(pricingSourceLabel([{ source_agreement_id: null, pricing_model: "per_item" }], null))
      .toBe("the laundry price list");
  });
});

describe("a job that still needs a price (brief 1.3)", () => {
  it("needs one when anything is unpriced, or nothing priced at all", () => {
    expect(needsPrice({ lines: [1], unpriced: [] })).toBe(false);
    expect(needsPrice({ lines: [1], unpriced: [1] })).toBe(true);
    expect(needsPrice({ lines: [], unpriced: [] })).toBe(true);
  });

  it("tells the counter what the automatic pricing did", () => {
    expect(autoPriceSentence({ state: "priced", orderNumber: "LJ1", lines: 2, subtotal: 25.08, source: "the laundry price list" }))
      .toMatch(/Priced automatically at \$25\.08 from the laundry price list/);
    expect(autoPriceSentence({ state: "needs_price", orderNumber: "LJ1", lines: 1, unpriced: 1, note: "" }))
      .toMatch(/Needs a price/);
    expect(autoPriceSentence({ state: "skipped" })).toBe("");
  });
});
