import { describe, expect, it } from "vitest";
import { billableQuantity, jobChargeSubtotal, priceJob, type RateLine } from "@/lib/domain/job-pricing";
import type { OrderItemInput } from "@/lib/domain/laundry-orders";

/**
 * The pricer, tested against the payloads it really sees: laundry rows in the
 * shape `JobForm` builds them, and rate lines in the shape 0003 + 0017 store
 * them.
 *
 * The cases that matter most are the ones where doing nothing looks like doing
 * something: laundry the rate card cannot price must be *reported*, never
 * quietly billed at zero, because a zero line reads as a decision somebody took.
 */

const AGREEMENT = "a1b2c3d4-1111-4a2b-8c3d-000000000001";

function rate(overrides: Partial<RateLine> = {}): RateLine {
  return {
    id: "line-1",
    agreement_id: AGREEMENT,
    item_id: null,
    laundry_item_type: "towels",
    charge_type: "wash_only",
    pricing_model: "per_item",
    unit_price: 2.5,
    percentage: null,
    included_quantity: 0,
    taxable: true,
    ...overrides,
  };
}

function item(overrides: Partial<OrderItemInput> = {}): OrderItemInput {
  return {
    item_type: "towels",
    quantity_type: "exact",
    exact_quantity: 10,
    ...overrides,
  };
}

describe("billableQuantity", () => {
  it("bills what was counted on an exact row", () => {
    expect(billableQuantity(item({ exact_quantity: 24 }))).toBe(24);
  });

  it("prefers the estimate over the bag count on a bulk lot", () => {
    expect(billableQuantity(item({
      quantity_type: "bulk_lot", exact_quantity: null, bag_count: 3, estimated_quantity: 40,
    }))).toBe(40);
  });

  it("falls back to the bag count when there is no estimate", () => {
    expect(billableQuantity(item({
      quantity_type: "bulk_lot", exact_quantity: null, bag_count: 3,
    }))).toBe(3);
  });

  it("refuses to guess at a bulk lot that carries only a note", () => {
    // 0014 lets a bulk lot be measured by a note alone. That is enough to
    // record the laundry and not enough to price it, so the answer is null and
    // the row goes to a person.
    expect(billableQuantity(item({
      quantity_type: "bulk_lot", exact_quantity: null, notes: "two green sacks",
    }))).toBeNull();
  });

  it("refuses a zero or missing count", () => {
    expect(billableQuantity(item({ exact_quantity: null }))).toBeNull();
    expect(billableQuantity(item({ exact_quantity: 0 }))).toBeNull();
  });
});

describe("priceJob", () => {
  it("prices counted laundry from the matching rate line", () => {
    const { lines, unpriced } = priceJob({ items: [item({ exact_quantity: 10 })], rateLines: [rate()] });
    expect(unpriced).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      quantity: 10, unit_price: 2.5, amount: 25, taxable: true, charge_type: "wash_only",
    });
  });

  it("records where every number came from", () => {
    // The audit question is "why was it this much?", and the snapshot has to
    // answer it without the rate card still existing.
    const { lines } = priceJob({ items: [item()], rateLines: [rate({ id: "line-9" })] });
    expect(lines[0]).toMatchObject({
      source_agreement_id: AGREEMENT,
      source_agreement_line_id: "line-9",
      source_laundry_item_type: "towels",
      pricing_model: "per_item",
    });
  });

  it("reports laundry the rate card says nothing about", () => {
    const { lines, unpriced } = priceJob({
      items: [item({ item_type: "uniforms", exact_quantity: 4 })],
      rateLines: [rate()],
    });
    expect(lines).toEqual([]);
    expect(unpriced).toEqual([
      { itemType: "uniforms", label: "Uniforms", description: "4 × Uniforms" },
    ]);
  });

  it("reports rather than prices when the row has no countable quantity", () => {
    const { lines, unpriced } = priceJob({
      items: [item({ quantity_type: "bulk_lot", exact_quantity: null, notes: "one sack" })],
      rateLines: [rate()],
    });
    expect(lines).toEqual([]);
    expect(unpriced).toHaveLength(1);
  });

  it("reports a rate line that exists but carries no price", () => {
    const { lines, unpriced } = priceJob({ items: [item()], rateLines: [rate({ unit_price: 0 })] });
    expect(lines).toEqual([]);
    expect(unpriced).toHaveLength(1);
  });

  it("applies the line's included allowance to the job", () => {
    const { lines } = priceJob({
      items: [item({ exact_quantity: 25 })],
      rateLines: [rate({ included_quantity: 10 })],
    });
    expect(lines[0]).toMatchObject({ quantity: 15, amount: 37.5 });
    expect(lines[0]?.description).toContain("10 included");
  });

  it("writes a zero line, not a gap, when the allowance covers everything", () => {
    // The rate card has an answer and the answer is nothing to pay. Sending
    // that to the reviewer as "unpriced" would ask them to decide something
    // that was already decided in the contract.
    const { lines, unpriced } = priceJob({
      items: [item({ exact_quantity: 6 })],
      rateLines: [rate({ included_quantity: 10 })],
    });
    expect(unpriced).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: 0, unit_price: 0, quantity: 6 });
  });

  it("prices several kinds of laundry on one job, and numbers the lines", () => {
    const { lines } = priceJob({
      items: [item({ exact_quantity: 10 }), item({ item_type: "sheets", exact_quantity: 4 })],
      rateLines: [rate(), rate({ id: "line-2", laundry_item_type: "sheets", unit_price: 5 })],
    });
    expect(lines.map((l) => l.sequence)).toEqual([1, 2]);
    expect(jobChargeSubtotal(lines)).toBe(45);
  });

  it("ignores rate lines that price linen rental rather than counter laundry", () => {
    // A line with no `laundry_item_type` prices the laundry's own stock on a
    // monthly rental. It has no business on a bag of towels.
    const { lines, unpriced } = priceJob({
      items: [item()],
      rateLines: [rate({ laundry_item_type: null, item_id: "item-1", pricing_model: "monthly" })],
    });
    expect(lines).toEqual([]);
    expect(unpriced).toHaveLength(1);
  });

  it("takes the first rate line when a card carries two for the same laundry", () => {
    const { lines } = priceJob({
      items: [item({ exact_quantity: 10 })],
      rateLines: [rate({ id: "first", unit_price: 2 }), rate({ id: "second", unit_price: 9 })],
    });
    expect(lines[0]).toMatchObject({ source_agreement_line_id: "first", amount: 20 });
  });

  it("adds the fuel levy on the job subtotal", () => {
    const { lines } = priceJob({
      items: [item({ exact_quantity: 10 })],
      rateLines: [rate()],
      rateCard: { id: AGREEMENT, fuel_levy_pct: 10 },
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ charge_type: "fuel_levy", amount: 2.5, taxable: true });
  });

  it("charges no levy when nothing could be priced", () => {
    const { lines } = priceJob({
      items: [item({ item_type: "uniforms" })],
      rateLines: [rate()],
      rateCard: { id: AGREEMENT, fuel_levy_pct: 10 },
    });
    expect(lines).toEqual([]);
  });

  it("never applies the contract minimum to a single job", () => {
    // A minimum charge is a promise about a period. Applied per job it would
    // bill a customer with fifteen jobs fifteen minimums, so the pricer does
    // not know about it at all — the recurring engine still applies it to the
    // period, which is the only unit it means anything on.
    const { lines } = priceJob({
      items: [item({ exact_quantity: 1 })],
      rateLines: [rate({ unit_price: 1 })],
      rateCard: { id: AGREEMENT, fuel_levy_pct: 0 },
    });
    expect(lines).toHaveLength(1);
    expect(jobChargeSubtotal(lines)).toBe(1);
    expect(lines.some((l) => l.charge_type === "minimum_service_fee")).toBe(false);
  });

  it("prices an empty job as nothing at all", () => {
    expect(priceJob({ items: [], rateLines: [rate()] })).toEqual({ lines: [], unpriced: [] });
  });

  it("prices nothing when the customer has no rate card", () => {
    const { lines, unpriced } = priceJob({ items: [item()], rateLines: [] });
    expect(lines).toEqual([]);
    expect(unpriced).toHaveLength(1);
  });

  it("names an `other` row by what the counter typed", () => {
    const { unpriced } = priceJob({
      items: [item({ item_type: "other", custom_description: "Chef whites", exact_quantity: 2 })],
      rateLines: [rate()],
    });
    expect(unpriced[0]?.label).toBe("Chef whites");
  });
});
