import { describe, expect, it } from "vitest";
import { consolidate, contractCharges, type BillableAgreement, type BillableLine } from "../invoicing";

/* A weekday-only January so visit counts are easy to reason about: Mondays in
   2026-01 fall on the 5th, 12th, 19th and 26th. */
const START = "2026-01-01";
const END = "2026-01-31";

function agreement(overrides: Partial<BillableAgreement> = {}): BillableAgreement {
  return {
    id: "agreement-1",
    customer_id: "customer-1",
    depot_id: "depot-1",
    location_id: "location-1",
    start_date: "2025-01-01",
    end_date: null,
    pickup_pattern: { type: "weekly", weekdays: [1] },
    minimum_charge: 0,
    holiday_rule: "skip",
    holiday_region: "NSW",
    weekend_surcharge_pct: 0,
    holiday_surcharge_pct: 0,
    fuel_levy_pct: 0,
    payment_terms_days: 14,
    purchase_order_number: null,
    emergency_service: false,
    ...overrides,
  };
}

function line(overrides: Partial<BillableLine> = {}): BillableLine {
  return {
    id: "line-1",
    agreement_id: "agreement-1",
    item_id: "item-1",
    charge_type: "rental",
    pricing_model: "per_item",
    unit_price: 2,
    percentage: null,
    standard_quantity: 10,
    included_quantity: 0,
    taxable: true,
    items: {
      name: "Bath Towel", sku: "BT-01",
      rental_price: 1, wash_only_price: 0.5, replacement_cost: 12,
    },
    ...overrides,
  };
}

const NO_WEIGHT = new Map<string, { billableKg: number; allowanceKg: number }>();

function charges(a: BillableAgreement, lines: BillableLine[], weight = NO_WEIGHT, collections = 0) {
  return contractCharges({
    agreement: a, lines, holidays: [],
    weightByLine: weight, weighedCollections: collections,
    start: START, end: END,
  });
}

const total = (lines: ReadonlyArray<{ amount: number }>) =>
  Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;

describe("contractCharges", () => {
  it("prices per-item lines by the number of visits in the period", () => {
    // Four Mondays × 10 towels × $2.
    expect(total(charges(agreement(), [line()]))).toBe(80);
  });

  it("bills the standard quantity net of the included allowance", () => {
    expect(total(charges(agreement(), [line({ standard_quantity: 10, included_quantity: 4 })])))
      .toBe(48); // 4 visits × 6 chargeable × $2
  });

  it("uses the weight it is handed rather than the service calendar", () => {
    // The whole point of per-kg: the run weighed it, the pattern did not predict it.
    const weight = new Map([["line-1", { billableKg: 120, allowanceKg: 30 }]]);
    const result = charges(
      agreement(),
      [line({ pricing_model: "per_kg", unit_price: 1.5 })],
      weight, 4,
    );
    expect(total(result)).toBe(180);
    expect(result[0]?.description).toContain("120 kg over 4 collection(s)");
    expect(result[0]?.description).toContain("30 kg included");
  });

  it("charges nothing for a per-kg line with no weight allocated to it", () => {
    // A second contract's per-kg line that the allocation gave nothing must not
    // fall back to a predicted quantity — that is how the same kilograms get
    // billed twice.
    expect(charges(agreement(), [line({ pricing_model: "per_kg", unit_price: 1.5 })])).toEqual([]);
  });

  it("tops up to the contract's own minimum charge", () => {
    const result = charges(agreement({ minimum_charge: 200 }), [line({ standard_quantity: 1 })]);
    expect(total(result)).toBe(200);
    expect(result.some((l) => l.chargeType === "minimum_service_fee")).toBe(true);
  });

  it("applies the contract's levy to that contract's services only", () => {
    // The consolidation guarantee: two contracts on one invoice must not share
    // a levy base. Priced separately, contract B's 10% never sees A's $80.
    const a = charges(agreement({ id: "a", fuel_levy_pct: 0 }), [line({ agreement_id: "a" })]);
    const b = charges(
      agreement({ id: "b", fuel_levy_pct: 10 }),
      [line({ id: "line-2", agreement_id: "b", standard_quantity: 5 })],
    );
    expect(total(a)).toBe(80);
    expect(total(b)).toBe(44); // 4 × 5 × $2 = 40, +10% = 44 — not 10% of 120
    expect(total([...a, ...b])).toBe(124);
  });

  it("returns nothing when a contract has no priced lines", () => {
    expect(charges(agreement(), [])).toEqual([]);
    expect(charges(agreement(), [line({ unit_price: 0, items: null })])).toEqual([]);
  });

  it("respects a contract that starts or ends inside the period", () => {
    // Mondays in January 2026 are the 5th, 12th, 19th and 26th.
    const late = charges(agreement({ start_date: "2026-01-13" }), [line()]);
    expect(total(late)).toBe(40); // the 19th and the 26th
    const ended = charges(agreement({ end_date: "2026-01-10" }), [line()]);
    expect(total(ended)).toBe(20); // the 5th only
  });

  it("reads no database", () => {
    // Guard against someone reaching for Supabase in here later: the function
    // is only testable in milliseconds because it takes plain data.
    expect(contractCharges.length).toBe(1);
  });
});

describe("consolidate", () => {
  it("keeps the value every contract agrees on", () => {
    expect(consolidate([14, 14, 14], 30)).toBe(14);
    expect(consolidate(["PO-1", "PO-1"], null)).toBe("PO-1");
  });

  it("falls back rather than picking a winner when they disagree", () => {
    // A customer whose two contracts have 7- and 30-day terms gets the terms on
    // their own record, not whichever contract happened to be first.
    expect(consolidate([7, 30], 21)).toBe(21);
    expect(consolidate(["PO-1", "PO-2"], null)).toBe(null);
  });

  it("falls back on an empty list", () => {
    expect(consolidate([] as number[], 14)).toBe(14);
  });
});
