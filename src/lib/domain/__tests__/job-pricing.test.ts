import { describe, expect, it } from "vitest";
import {
  billableQuantity, jobChargeSubtotal, priceJob, pricingSourceLabel, type RateLine,
} from "@/lib/domain/job-pricing";
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

/**
 * The price list beneath the rate card (0018 under 0017).
 *
 * This tier exists because of a fact about the live deployment rather than a
 * design preference: 508 of 508 real customers hold no rate card. Without it
 * every job for every one of them prices to nothing and lands in `unpriced`,
 * which reads as the pricer being broken rather than as a rate card being
 * absent — and puts 508 negotiated agreements between the owner and their first
 * invoice.
 */
describe("priceJob — the price-list fallback", () => {
  const list = (
    entries: Record<string, { unitPrice: number; bagPrice?: number | null; taxable?: boolean }>,
  ) => new Map(Object.entries(entries).map(([type, value]) => [type, {
    unitPrice: value.unitPrice,
    bagPrice: value.bagPrice ?? null,
    taxable: value.taxable ?? true,
    source: "default" as const,
  }]));

  it("prices a customer with no rate card at all from the list", () => {
    const result = priceJob({
      items: [item({ item_type: "towels", exact_quantity: 10 })],
      rateLines: [],
      priceList: list({ towels: { unitPrice: 2 } }),
    });

    expect(result.unpriced).toHaveLength(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.amount).toBe(20);
    // Provenance is honest: this price came from the list, not an agreement.
    expect(result.lines[0]!.source_agreement_id).toBeNull();
    expect(result.lines[0]!.description).toContain("price list");
  });

  it("lets the rate card win outright where it has an answer", () => {
    const result = priceJob({
      items: [item({ item_type: "towels", exact_quantity: 10 })],
      rateLines: [rate({ unit_price: 2.5 })],
      priceList: list({ towels: { unitPrice: 99 } }),
      rateCard: { id: AGREEMENT, fuel_levy_pct: 0 },
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.amount).toBe(25);
    expect(result.lines[0]!.source_agreement_id).toBe(AGREEMENT);
  });

  it("falls back per kind of laundry, not per customer", () => {
    // The ordinary case: a card that covers towels and says nothing about
    // sheets. The card answers for towels and the list answers for sheets.
    const result = priceJob({
      items: [
        item({ item_type: "towels", exact_quantity: 10 }),
        item({ item_type: "sheets", exact_quantity: 4 }),
      ],
      rateLines: [rate({ laundry_item_type: "towels", unit_price: 2.5 })],
      priceList: list({ sheets: { unitPrice: 5 } }),
      rateCard: { id: AGREEMENT, fuel_levy_pct: 0 },
    });

    expect(result.unpriced).toHaveLength(0);
    expect(result.lines.map((line) => line.amount)).toEqual([25, 20]);
    expect(result.lines[0]!.source_agreement_line_id).not.toBeNull();
    expect(result.lines[1]!.source_agreement_line_id).toBeNull();
  });

  it("bills a bulk lot by the bag when a bag rate is set and bags were counted", () => {
    const result = priceJob({
      items: [item({
        item_type: "linen", quantity_type: "bulk_lot", exact_quantity: null,
        bag_count: 3, estimated_quantity: 40,
      })],
      rateLines: [],
      priceList: list({ linen: { unitPrice: 1, bagPrice: 12 } }),
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.amount).toBe(36);
    expect(result.lines[0]!.description).toContain("bags");
  });

  it("bills a bulk lot at the piece rate when no bag rate is set", () => {
    const result = priceJob({
      items: [item({
        item_type: "linen", quantity_type: "bulk_lot", exact_quantity: null,
        bag_count: 3, estimated_quantity: 40,
      })],
      rateLines: [],
      priceList: list({ linen: { unitPrice: 1 } }),
    });

    expect(result.lines[0]!.amount).toBe(40);
  });

  it("still reports laundry no tier can price", () => {
    // The safety property the whole module exists for, unchanged by the
    // fallback: a missing price is said out loud, never billed at nothing.
    const result = priceJob({
      items: [item({ item_type: "uniforms", exact_quantity: 6 })],
      rateLines: [],
      priceList: list({ towels: { unitPrice: 2 } }),
    });

    expect(result.lines).toHaveLength(0);
    expect(result.unpriced).toHaveLength(1);
    expect(result.unpriced[0]!.itemType).toBe("uniforms");
  });

  it("does not rescue a bulk lot with nothing measured on it", () => {
    // No bag count and no estimate: the gap is in what the counter recorded,
    // not in the pricing, so no tier can help and a price would be invented.
    const result = priceJob({
      items: [item({
        item_type: "linen", quantity_type: "bulk_lot", exact_quantity: null,
        bag_count: null, estimated_quantity: null,
      })],
      rateLines: [],
      priceList: list({ linen: { unitPrice: 1, bagPrice: 12 } }),
    });

    expect(result.lines).toHaveLength(0);
    expect(result.unpriced).toHaveLength(1);
  });

  it("ignores a zero price in the list rather than billing nothing", () => {
    const result = priceJob({
      items: [item({ item_type: "towels", exact_quantity: 10 })],
      rateLines: [],
      priceList: list({ towels: { unitPrice: 0 } }),
    });

    expect(result.lines).toHaveLength(0);
    expect(result.unpriced).toHaveLength(1);
  });

  it("prices exactly as before when no list is supplied", () => {
    // The branch's own behaviour is unchanged for every caller that does not
    // pass a list, which is what makes this tier additive.
    const result = priceJob({
      items: [item({ item_type: "sheets", exact_quantity: 4 })],
      rateLines: [rate({ laundry_item_type: "towels" })],
    });

    expect(result.lines).toHaveLength(0);
    expect(result.unpriced).toHaveLength(1);
  });
});

/**
 * Which tier answered, said back to the reviewer.
 *
 * The reason this is computed rather than assumed: both tiers can price parts of
 * the same job, and the action that used to name only the rate card was the same
 * action that refused to run without one.
 */
describe("pricingSourceLabel", () => {
  const CARD = { agreement_number: "AGR00007", version: 2 };
  const fromCard = { source_agreement_id: "agreement-1" };
  const fromList = { source_agreement_id: null };

  it("names the card when the card priced everything", () => {
    expect(pricingSourceLabel([fromCard, fromCard], CARD)).toBe("AGR00007 v2");
  });

  it("names the price list when there is no card at all", () => {
    expect(pricingSourceLabel([fromList], null)).toBe("the laundry price list");
  });

  it("names both when a card covered part of the job and the list the rest", () => {
    expect(pricingSourceLabel([fromCard, fromList], CARD))
      .toBe("AGR00007 v2 and the laundry price list");
  });

  it("names the list when a card exists but answered nothing", () => {
    expect(pricingSourceLabel([fromList, fromList], CARD)).toBe("the laundry price list");
  });

  it("does not claim a card priced an empty job", () => {
    expect(pricingSourceLabel([], CARD)).toBe("the laundry price list");
  });
});

describe("pricing a coded item (0032)", () => {
  const towelItem = {
    item_id: "item-tow001", item_type: "towels",
    quantity_type: "exact", exact_quantity: 100,
  };

  it("prefers a rate line for the exact item over one for its category", () => {
    const result = priceJob({
      items: [towelItem],
      rateLines: [
        // The category line first, so the result cannot come from ordering.
        rate({ id: "cat", laundry_item_type: "towels", unit_price: 1 }),
        rate({ id: "item", item_id: "item-tow001", laundry_item_type: null, unit_price: 2 }),
      ],
    });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.unit_price).toBe(2);
    expect(result.lines[0]!.source_agreement_line_id).toBe("item");
  });

  it("falls back to the category rate line when the card names no item", () => {
    const result = priceJob({
      items: [towelItem],
      rateLines: [rate({ id: "cat", laundry_item_type: "towels", unit_price: 1 })],
    });
    expect(result.lines[0]!.unit_price).toBe(1);
    expect(result.lines[0]!.source_agreement_line_id).toBe("cat");
  });

  it("prefers the item's own listed price over the category's", () => {
    const result = priceJob({
      items: [towelItem],
      rateLines: [],
      priceList: new Map([["towels", { unitPrice: 1, bagPrice: null, taxable: true, source: "default" as const }]]),
      itemPriceList: new Map([["item-tow001", { unitPrice: 3, bagPrice: null, taxable: true, source: "customer" as const }]]),
    });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.unit_price).toBe(3);
  });

  it("keeps the rate card ahead of the price list, however specific the list is", () => {
    // A negotiated agreement beats a default list, even when the list names the
    // exact item and the agreement names only its category.
    const result = priceJob({
      items: [towelItem],
      rateLines: [rate({ id: "cat", laundry_item_type: "towels", unit_price: 1 })],
      itemPriceList: new Map([["item-tow001", { unitPrice: 9, bagPrice: null, taxable: true, source: "default" as const }]]),
    });
    expect(result.lines[0]!.unit_price).toBe(1);
  });

  it("records which item was billed, whichever tier priced it", () => {
    const fromCard = priceJob({
      items: [towelItem],
      rateLines: [rate({ id: "cat", laundry_item_type: "towels", unit_price: 1 })],
    });
    expect(fromCard.lines[0]!.source_item_id).toBe("item-tow001");

    const fromList = priceJob({
      items: [towelItem],
      rateLines: [],
      itemPriceList: new Map([["item-tow001", { unitPrice: 3, bagPrice: null, taxable: true, source: "default" as const }]]),
    });
    expect(fromList.lines[0]!.source_item_id).toBe("item-tow001");
  });

  it("prices an uncoded item exactly as it did before", () => {
    // Every job written before the item master has no item_id, and must be
    // unaffected — this is the assertion that the change is additive.
    const result = priceJob({
      items: [{ item_type: "towels", quantity_type: "exact", exact_quantity: 100 }],
      rateLines: [rate({ id: "cat", laundry_item_type: "towels", unit_price: 1 })],
    });
    expect(result.lines[0]!.unit_price).toBe(1);
    expect(result.lines[0]!.source_item_id).toBeNull();
  });
});
