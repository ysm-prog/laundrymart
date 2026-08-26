import { describe, expect, it } from "vitest";
import {
  includedTax, normaliseTaxCode, taxCodeCarriesGst, taxInclusiveTotals, toTaxInclusive,
} from "../gst";

/**
 * The client's own MYOB invoice is the specification, so it is asserted line for
 * line rather than paraphrased. If this block ever fails, the app has stopped
 * agreeing with the document the customer receives.
 */
describe("the client's MYOB invoice, reproduced", () => {
  const LINES = [
    { description: "Towels - Black", quantity: 100, unitPrice: 0.39, taxCode: "GST" },
    { description: "White Towels - Client's Own Towels", quantity: 1, unitPrice: 31.5, taxCode: "GST" },
    { description: "Temporary Fuel Surcharge", quantity: 1, unitPrice: 2.2, taxCode: "GST" },
  ].map((l) => ({ ...l, amount: Math.round(l.quantity * l.unitPrice * 100) / 100 }));

  it("gives each line the amount printed on it", () => {
    expect(LINES.map((l) => l.amount)).toEqual([39.0, 31.5, 2.2]);
  });

  it("totals exactly as the invoice does", () => {
    const t = taxInclusiveTotals(LINES);
    expect(t.subtotal).toBe(72.7);
    expect(t.taxAmount).toBe(6.61);   // 72.70 / 11, as printed
    expect(t.total).toBe(72.7);       // equal to the subtotal: tax is inside it
  });

  it("does not add the tax on top, which is what this app used to do", () => {
    // The old exclusive model produced 79.97 from the same three lines.
    expect(taxInclusiveTotals(LINES).total).not.toBe(79.97);
  });
});

describe("includedTax", () => {
  it("is the amount divided by eleven at 10%", () => {
    expect(includedTax(72.7)).toBe(6.61);
    expect(includedTax(110)).toBe(10);
    expect(includedTax(11)).toBe(1);
  });

  it("is zero for nothing, and for a zero rate", () => {
    expect(includedTax(0)).toBe(0);
    expect(includedTax(72.7, 0)).toBe(0);
  });

  it("rounds once on the summed taxable amount, not per line", () => {
    // Three lines of 0.05 each. Per-line rounding gives 0.00; summing first
    // gives 0.01, which is what the invoice must print to match its own lines.
    const lines = [0.05, 0.05, 0.05].map((amount) => ({ amount, taxCode: "GST" }));
    expect(taxInclusiveTotals(lines).taxAmount).toBe(0.01);
    expect(lines.reduce((s, l) => s + includedTax(l.amount), 0)).toBe(0);
  });
});

describe("tax codes", () => {
  it("carries GST only for GST", () => {
    expect(taxCodeCarriesGst("GST")).toBe(true);
    expect(taxCodeCarriesGst("FRE")).toBe(false);
    expect(taxCodeCarriesGst("N-T")).toBe(false);
  });

  it("reads MYOB's spellings, including the bare N in this register", () => {
    expect(normaliseTaxCode("N")).toBe("N-T");
    expect(normaliseTaxCode("n-t")).toBe("N-T");
    expect(normaliseTaxCode(" gst ")).toBe("GST");
  });

  it("keeps an unknown or missing code out of the tax rather than guessing GST", () => {
    // Over-collecting tax on a customer's invoice is the worse of the two errors,
    // and the code is on the line for somebody to correct.
    expect(normaliseTaxCode("WET")).toBeNull();
    expect(normaliseTaxCode(null)).toBeNull();
    expect(taxCodeCarriesGst(undefined)).toBe(false);
    expect(taxInclusiveTotals([{ amount: 100, taxCode: null }]).taxAmount).toBe(0);
  });
});

describe("freight", () => {
  it("adds to the subtotal and carries its own tax answer", () => {
    const lines = [{ amount: 72.7, taxCode: "GST" }];
    const withFreight = taxInclusiveTotals(lines, { freight: 11, freightTaxCode: "GST" });
    expect(withFreight.subtotal).toBe(83.7);
    expect(withFreight.taxAmount).toBe(7.61);   // 83.70 / 11
    expect(withFreight.total).toBe(83.7);
  });

  it("can be untaxed while the lines are taxed", () => {
    const t = taxInclusiveTotals([{ amount: 110, taxCode: "GST" }],
      { freight: 50, freightTaxCode: "N-T" });
    expect(t.subtotal).toBe(160);
    expect(t.taxAmount).toBe(10);   // the freight contributes none
  });

  it("is absent by default", () => {
    expect(taxInclusiveTotals([{ amount: 100, taxCode: "GST" }]).subtotal).toBe(100);
  });
});

describe("toTaxInclusive", () => {
  it("grosses a register price up, which is what the fuel surcharge proves", () => {
    // TFSC is $2.00 tax-exclusive in the item register and bills at $2.20.
    expect(toTaxInclusive(2)).toBe(2.2);
    expect(toTaxInclusive(0.37)).toBe(0.41);
  });
});

import { lineAmount } from "../pricing";

describe("lineAmount with a discount", () => {
  it("is units × price when there is no discount, as on all three of the client's lines", () => {
    expect(lineAmount(100, 0.39)).toBe(39);
    expect(lineAmount(1, 31.5)).toBe(31.5);
    expect(lineAmount(1, 2.2, 0)).toBe(2.2);
  });

  it("takes the percentage off the line", () => {
    expect(lineAmount(100, 1, 10)).toBe(90);
    expect(lineAmount(10, 2.5, 50)).toBe(12.5);
  });

  it("applies the discount before rounding, not after", () => {
    // 3 × 3.33 = 9.99, less 3.33% = 9.657…  → 9.66, not 9.99 - 0.33.
    expect(lineAmount(3, 3.33, 3.33)).toBe(9.66);
  });

  it("clamps rather than producing a negative amount from a typo", () => {
    expect(lineAmount(10, 1, 150)).toBe(0);
    expect(lineAmount(10, 1, -20)).toBe(10);
  });

  it("treats junk as no discount", () => {
    expect(lineAmount(10, 1, Number.NaN)).toBe(10);
  });
});
