import { describe, expect, it } from "vitest";
import { parseWizardLines } from "../wizard-lines";

/**
 * Step 3 of the contract wizard, as it actually posts.
 *
 * The fixtures are copied from `AgreementWizard.linesPayload`, not written to
 * suit the schema — the whole point of this file is that the two agree. The
 * same arrangement on the job form disagreed for its entire shipped life, and
 * nothing could catch it because the schema sat inside a `"use server"` module.
 */

/** Exactly what step 3 serialises for one priced item row. */
const RENTAL_LINE = {
  item_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  charge_type: "rental",
  pricing_model: "per_item",
  unit_price: 2.4,
  standard_quantity: 100,
  included_quantity: 0,
  taxable: true,
};

/** The per-kg fork: step 3 switches the charge type with the pricing model. */
const PER_KG_LINE = {
  ...RENTAL_LINE,
  charge_type: "weight_charge",
  pricing_model: "per_kg",
  unit_price: 3.15,
  included_quantity: 25,
};

describe("parseWizardLines", () => {
  it("reads the rows step 3 builds", () => {
    const lines = parseWizardLines(JSON.stringify([RENTAL_LINE, PER_KG_LINE]));
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines?.[0]).toMatchObject({ charge_type: "rental", unit_price: 2.4 });
    expect(lines?.[1]).toMatchObject({ charge_type: "weight_charge", included_quantity: 25 });
  });

  it("reads the zeroes step 3 produces from an untouched Advanced pricing block", () => {
    // `Number(line.includedQuantity) || 0` — a blank advanced field posts 0,
    // never "" and never null.
    const lines = parseWizardLines(JSON.stringify([
      { ...RENTAL_LINE, unit_price: 0, standard_quantity: 0, included_quantity: 0 },
    ]));
    expect(lines).toHaveLength(1);
  });

  it("takes an absent or empty field as a contract with no priced lines", () => {
    expect(parseWizardLines(null)).toEqual([]);
    expect(parseWizardLines("")).toEqual([]);
    expect(parseWizardLines("[]")).toEqual([]);
  });

  it("refuses a payload it cannot read rather than saving a contract without its prices", () => {
    expect(parseWizardLines("{not json")).toBeNull();
    expect(parseWizardLines(JSON.stringify([{ ...RENTAL_LINE, unit_price: "2.40" }]))).toBeNull();
    expect(parseWizardLines(JSON.stringify([{ ...RENTAL_LINE, charge_type: "invented" }]))).toBeNull();
  });

  /**
   * `item_id` is `optionalUuid`, which now reads a JSON `null` as absent. Step 3
   * filters rows with no item before serialising, so this should not arise —
   * but it is the one field on this payload that could plausibly start arriving
   * as `null`, and that is the exact shape that broke the job form.
   */
  it("survives a null item_id instead of failing the whole array", () => {
    const lines = parseWizardLines(JSON.stringify([{ ...RENTAL_LINE, item_id: null }]));
    expect(lines).toHaveLength(1);
    expect(lines?.[0]?.item_id).toBeUndefined();
  });

  it("refuses more lines than one contract can hold", () => {
    expect(parseWizardLines(JSON.stringify(Array.from({ length: 51 }, () => RENTAL_LINE)))).toBeNull();
  });
});
