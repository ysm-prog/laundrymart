import { describe, expect, it } from "vitest";
import {
  buildLaundryCharges, describeUnpriced, itemLabel, priceListFor,
  type BillableJob, type BillableJobItem, type LaundryPriceRow,
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

function item(overrides: Partial<BillableJobItem> = {}): BillableJobItem {
  return {
    item_type: "towels",
    custom_description: null,
    quantity_type: "exact",
    exact_quantity: 10,
    bag_count: null,
    estimated_quantity: null,
    ...overrides,
  };
}

function job(items: BillableJobItem[], overrides: Partial<BillableJob> = {}): BillableJob {
  return { id: "job-1", order_number: "LJ00001", items, ...overrides };
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

describe("buildLaundryCharges", () => {
  const prices = priceListFor("customer-1", [
    priceRow({ item_type: "towels", unit_price: 2, bag_price: 15 }),
    priceRow({ item_type: "sheets", unit_price: 4.5 }),
  ]);

  it("prices a counted item per piece and names the job", () => {
    const { lines, unpriced } = buildLaundryCharges({
      jobs: [job([item({ exact_quantity: 10 })])],
      prices,
    });
    expect(unpriced).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ orderId: "job-1" });
    expect(lines[0]?.line).toMatchObject({
      description: "Job LJ00001 — 10 × Towels",
      chargeType: "wash_only",
      quantity: 10,
      unitPrice: 2,
      amount: 20,
      taxable: true,
    });
  });

  it("lines up every item on every job", () => {
    const { lines } = buildLaundryCharges({
      jobs: [
        job([item({ exact_quantity: 10 }), item({ item_type: "sheets", exact_quantity: 4 })]),
        job([item({ exact_quantity: 1 })], { id: "job-2", order_number: "LJ00002" }),
      ],
      prices,
    });
    expect(lines.map((entry) => entry.line.amount)).toEqual([20, 18, 2]);
    expect(lines.map((entry) => entry.orderId)).toEqual(["job-1", "job-1", "job-2"]);
  });

  it("bills a bulk lot by the bag when a bag price is set", () => {
    const { lines } = buildLaundryCharges({
      jobs: [job([item({
        quantity_type: "bulk_lot", exact_quantity: null, bag_count: 3, estimated_quantity: 60,
      })])],
      prices,
    });
    expect(lines[0]?.line).toMatchObject({
      description: "Job LJ00001 — 3 bags of Towels", quantity: 3, unitPrice: 15, amount: 45,
    });
  });

  it("falls back to the estimated count when there is no bag price", () => {
    const { lines } = buildLaundryCharges({
      jobs: [job([item({
        item_type: "sheets", quantity_type: "bulk_lot",
        exact_quantity: null, bag_count: 2, estimated_quantity: 20,
      })])],
      prices,
    });
    expect(lines[0]?.line).toMatchObject({
      description: "Job LJ00001 — about 20 × Sheets (bulk lot)", quantity: 20, amount: 90,
    });
  });

  it("reports a bulk lot it cannot price instead of billing nothing quietly", () => {
    const { lines, unpriced } = buildLaundryCharges({
      jobs: [job([item({
        item_type: "sheets", quantity_type: "bulk_lot",
        exact_quantity: null, bag_count: 2, estimated_quantity: null,
      })])],
      prices,
    });
    expect(lines).toEqual([]);
    expect(unpriced).toEqual([{
      orderId: "job-1",
      orderNumber: "LJ00001",
      description: "Sheets",
      reason: "Sheets was taken in by the bag, and no bag price is set",
    }]);
  });

  it("reports a kind of laundry nobody has priced", () => {
    const { lines, unpriced } = buildLaundryCharges({
      jobs: [job([item({ item_type: "uniforms", exact_quantity: 5 })])],
      prices,
    });
    expect(lines).toEqual([]);
    expect(unpriced[0]?.reason).toBe("no price is set for Uniforms");
  });

  it("uses the typed description for an 'other' item", () => {
    const { unpriced } = buildLaundryCharges({
      jobs: [job([item({
        item_type: "other", custom_description: "Chef whites", exact_quantity: 2,
      })])],
      prices,
    });
    expect(unpriced[0]?.description).toBe("Chef whites");
  });

  it("carries the price's taxable flag onto the line", () => {
    const exempt = priceListFor("customer-1", [
      priceRow({ item_type: "towels", unit_price: 2, taxable: false }),
    ]);
    const { lines } = buildLaundryCharges({ jobs: [job([item()])], prices: exempt });
    expect(lines[0]?.line.taxable).toBe(false);
  });

  it("rounds money to cents", () => {
    const odd = priceListFor("customer-1", [priceRow({ item_type: "towels", unit_price: 0.335 })]);
    const { lines } = buildLaundryCharges({
      jobs: [job([item({ exact_quantity: 3 })])], prices: odd,
    });
    expect(lines[0]?.line.amount).toBe(1.01);
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

describe("describeUnpriced", () => {
  it("says nothing when nothing was left off", () => {
    expect(describeUnpriced([])).toBe("");
  });

  it("names the jobs so the operator does not have to hunt", () => {
    const sentence = describeUnpriced([
      { orderId: "1", orderNumber: "LJ00021", description: "Towels", reason: "no price is set for Towels" },
      { orderId: "2", orderNumber: "LJ00022", description: "Towels", reason: "no price is set for Towels" },
    ]);
    expect(sentence).toContain("LJ00021, LJ00022");
    expect(sentence).toContain("no price is set for Towels");
  });

  it("counts the jobs beyond the ones it names", () => {
    const many = ["A", "B", "C", "D"].map((suffix) => ({
      orderId: suffix, orderNumber: `LJ0000${suffix}`, description: "Towels", reason: "no price is set for Towels",
    }));
    expect(describeUnpriced(many)).toContain("+1 more job(s)");
  });
});
