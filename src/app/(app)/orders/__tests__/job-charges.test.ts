import { describe, expect, it } from "vitest";
import { parseJobCharges } from "../job-charges";
import { priceJob, type RateLine } from "@/lib/domain/job-pricing";

/**
 * Tests written against the payload `JobChargesEditor` actually builds.
 *
 * The single most important case here is the `null` one. The editor composes
 * rows in the browser and posts them with `JSON.stringify`, which drops
 * `undefined` keys — so an unanswered field arrives as `null`, and
 * `z.string().optional()` refuses `null`. That exact mismatch made every job in
 * this app unsaveable for the whole life of the Jobs module, behind a green
 * `verify`, because the contract lived in a `"use server"` file no test could
 * reach. These tests exist so it cannot happen twice.
 */

const SOURCED = {
  description: "Towels — 10",
  charge_type: "wash_only",
  quantity: 10,
  unit_price: 2.5,
  taxable: true,
  source_agreement_id: "a1b2c3d4-1111-4a2b-8c3d-000000000001",
  source_agreement_line_id: "b1b2c3d4-2222-4a2b-8c3d-000000000002",
  source_item_id: null,
  source_laundry_item_type: "towels",
  pricing_model: "per_item",
};

describe("parseJobCharges", () => {
  it("reads the payload the editor builds", () => {
    const result = parseJobCharges(JSON.stringify([SOURCED]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      sequence: 1, description: "Towels — 10", quantity: 10, unit_price: 2.5, amount: 25,
      source_laundry_item_type: "towels",
    });
  });

  it("accepts `null` for every optional field", () => {
    // The shape a hand-added line really has: no rate card behind it, so every
    // provenance field is null rather than missing.
    const manual = {
      description: "Chef whites, agreed by phone",
      charge_type: "other",
      quantity: 2,
      unit_price: 12,
      taxable: true,
      source_agreement_id: null,
      source_agreement_line_id: null,
      source_item_id: null,
      source_laundry_item_type: null,
      pricing_model: null,
    };
    const result = parseJobCharges(JSON.stringify([manual]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0]).toMatchObject({
      amount: 24, source_agreement_id: null, pricing_model: null,
    });
  });

  it("does not let one null field take the whole list down", () => {
    // The failure mode from the job form, reproduced at the list level: a good
    // row and a row with nulls must both survive.
    const result = parseJobCharges(JSON.stringify([
      SOURCED,
      { ...SOURCED, description: "Sheets — 4", source_laundry_item_type: null, pricing_model: null },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toHaveLength(2);
  });

  it("computes the amount on the server and ignores whatever the browser sent", () => {
    const result = parseJobCharges(JSON.stringify([
      { ...SOURCED, quantity: 3, unit_price: 4, amount: 999999 },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0]?.amount).toBe(12);
  });

  it("accepts numbers that arrive as strings from a number input", () => {
    const result = parseJobCharges(JSON.stringify([
      { ...SOURCED, quantity: "6", unit_price: "1.50" },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0]).toMatchObject({ quantity: 6, unit_price: 1.5, amount: 9 });
  });

  it("numbers the lines by their position, so a reordered list stays ordered", () => {
    const result = parseJobCharges(JSON.stringify([SOURCED, SOURCED, SOURCED]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((l) => l.sequence)).toEqual([1, 2, 3]);
  });

  it("treats an empty field as an empty list, not an error", () => {
    expect(parseJobCharges("")).toEqual({ ok: true, lines: [] });
    expect(parseJobCharges(null)).toEqual({ ok: true, lines: [] });
  });

  it("says a broken payload is broken rather than posing as an empty one", () => {
    const result = parseJobCharges("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatch(/could not be read/i);
  });

  it("names the row that failed", () => {
    const result = parseJobCharges(JSON.stringify([SOURCED, { ...SOURCED, description: "x" }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatch(/^Charge 2:/);
  });

  it("refuses a negative rate", () => {
    const result = parseJobCharges(JSON.stringify([{ ...SOURCED, unit_price: -5 }]));
    expect(result.ok).toBe(false);
  });

  it("falls back to `other` on a charge type the snapshot would refuse", () => {
    // The check constraint on `job_charge_snapshots.charge_type` lists a fixed
    // set. An unknown string becoming `other` keeps a job priceable instead of
    // failing the save on one field nobody looks at.
    const result = parseJobCharges(JSON.stringify([{ ...SOURCED, charge_type: "invented" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0]?.charge_type).toBe("other");
  });

  it("round-trips what the pricer produces", () => {
    // The two halves of this feature meet here: `priceJob` fills the editor, the
    // editor posts it back, and this parses it. If those three ever disagree the
    // symptom is a reviewer's edit being silently dropped, so it is pinned.
    const rate: RateLine = {
      id: "b1b2c3d4-2222-4a2b-8c3d-000000000002",
      agreement_id: "a1b2c3d4-1111-4a2b-8c3d-000000000001",
      item_id: null, laundry_item_type: "towels", charge_type: "wash_only",
      pricing_model: "per_item", unit_price: 2.5, percentage: null,
      included_quantity: 0, taxable: true,
    };
    const { lines } = priceJob({
      items: [{ item_type: "towels", quantity_type: "exact", exact_quantity: 10 }],
      rateLines: [rate],
      rateCard: { id: rate.agreement_id, fuel_levy_pct: 10 },
    });

    const result = parseJobCharges(JSON.stringify(lines));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]?.amount).toBe(25);
    expect(result.lines[1]).toMatchObject({ charge_type: "fuel_levy", amount: 2.5 });
  });
});
