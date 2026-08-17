import { describe, expect, it } from "vitest";
import {
  defaultPriceList, itemLabel, priceListFor, type LaundryPriceRow,
} from "../laundry-billing";

function priceRow(overrides: Partial<LaundryPriceRow> = {}): LaundryPriceRow {
  return {
    customer_id: null,
    item_type: "towels",
    unit_price: 2,
    bag_price: null,
    taxable: true,
    ...overrides,
  };
}

describe("priceListFor", () => {
  it("takes the customer's own price over the tenant default", () => {
    const prices = priceListFor("customer-1", [
      priceRow({ unit_price: 2 }),
      priceRow({ customer_id: "customer-1", unit_price: 1.5 }),
    ]);
    expect(prices.get("towels")).toMatchObject({ unitPrice: 1.5, source: "customer" });
  });

  it("falls back to the tenant default where the customer has no price", () => {
    const prices = priceListFor("customer-1", [
      priceRow({ item_type: "sheets", unit_price: 4 }),
      priceRow({ customer_id: "customer-1", item_type: "towels", unit_price: 1 }),
    ]);
    expect(prices.get("sheets")).toMatchObject({ unitPrice: 4, source: "default" });
    expect(prices.get("towels")).toMatchObject({ unitPrice: 1, source: "customer" });
  });

  it("never borrows another customer's price", () => {
    const prices = priceListFor("customer-1", [
      priceRow({ customer_id: "customer-2", unit_price: 9 }),
    ]);
    expect(prices.has("towels")).toBe(false);
  });

  it("leaves an unpriced kind of laundry absent rather than free", () => {
    const prices = priceListFor("customer-1", [priceRow({ item_type: "towels" })]);
    expect(prices.has("uniforms")).toBe(false);
  });

  it("reads numerics that arrive as strings, and ignores a zero bag price", () => {
    const prices = priceListFor("customer-1", [
      priceRow({ unit_price: "2.50", bag_price: "0" }),
    ]);
    expect(prices.get("towels")).toMatchObject({ unitPrice: 2.5, bagPrice: null });
  });
});

describe("itemLabel", () => {
  it("uses the counter's word for a known kind", () => {
    expect(itemLabel({ item_type: "bath_mats", custom_description: null })).toBe("Bath mats");
  });
  it("falls back to 'Other' when nothing was typed", () => {
    expect(itemLabel({ item_type: "other", custom_description: "  " })).toBe("Other");
  });
});

describe("defaultPriceList", () => {
  it("answers with the tenant list and never a customer's own price", () => {
    // The screen and the fallback must agree, so this is expressed through
    // `priceListFor` with an id no customer can hold rather than a second
    // filter that could drift from it.
    const prices = defaultPriceList([
      priceRow({ customer_id: null, item_type: "towels", unit_price: 2 }),
      priceRow({ customer_id: "customer-1", item_type: "towels", unit_price: 9 }),
    ]);
    expect(prices.get("towels")?.unitPrice).toBe(2);
    expect(prices.get("towels")?.source).toBe("default");
  });
});
