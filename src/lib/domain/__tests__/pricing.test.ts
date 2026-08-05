import { describe, expect, it } from "vitest";
import {
  buildReplacementCharges,
  buildServiceCharges,
  formatMoney,
  lineAmount,
  resolvePrice,
  round2,
  summariseInvoice,
} from "../pricing";

describe("resolvePrice", () => {
  it("prefers the agreement line above everything", () => {
    expect(resolvePrice({ agreementLinePrice: 1.1, itemPrice: 2, categoryPrice: 3, globalPrice: 4 }))
      .toEqual({ price: 1.1, source: "agreement_line" });
  });

  it("falls through the precedence chain", () => {
    expect(resolvePrice({ itemPrice: 2, categoryPrice: 3 })).toEqual({ price: 2, source: "item" });
    expect(resolvePrice({ categoryPrice: 3, globalPrice: 4 })).toEqual({ price: 3, source: "category" });
    expect(resolvePrice({ globalPrice: 4 })).toEqual({ price: 4, source: "global" });
    expect(resolvePrice({})).toEqual({ price: 0, source: "none" });
  });

  it("treats a zero price as a real price, not a missing one", () => {
    expect(resolvePrice({ agreementLinePrice: 0, itemPrice: 5 }))
      .toEqual({ price: 0, source: "agreement_line" });
  });

  it("ignores nulls and non-finite values", () => {
    expect(resolvePrice({ agreementLinePrice: null, itemPrice: Number.NaN, categoryPrice: 7 }))
      .toEqual({ price: 7, source: "category" });
  });
});

describe("money arithmetic", () => {
  it("rounds to cents without binary drift", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(lineAmount(3, 1.115)).toBe(3.35);
  });

  it("totals an invoice with GST on taxable lines only", () => {
    const totals = summariseInvoice(
      [{ amount: 100, taxable: true }, { amount: 50, taxable: false }],
      0.1,
    );
    expect(totals).toEqual({ subtotal: 150, taxAmount: 10, total: 160 });
  });
});

describe("buildServiceCharges", () => {
  const items = [
    { description: "Bath Towel rental", quantity: 100, unitPrice: 0.55 },
    { description: "Tea Towel rental", quantity: 40, unitPrice: 0.3 },
  ];

  it("prices the service lines", () => {
    const lines = buildServiceCharges({ items });
    expect(lines.map((l) => l.amount)).toEqual([55, 12]);
  });

  it("tops up to the minimum charge instead of replacing the detail", () => {
    const lines = buildServiceCharges({ items, minimumCharge: 100 });
    const topUp = lines.find((l) => l.chargeType === "minimum_service_fee");
    expect(topUp?.amount).toBe(33);
    expect(summariseInvoice(lines).subtotal).toBe(100);
  });

  it("does not top up when the service already clears the minimum", () => {
    const lines = buildServiceCharges({ items, minimumCharge: 50 });
    expect(lines.some((l) => l.chargeType === "minimum_service_fee")).toBe(false);
  });

  it("applies percentage charges to the same base so they never compound", () => {
    const lines = buildServiceCharges({
      items, fuelLevyPct: 5, weekendSurchargePct: 10, servicedOnWeekend: true,
    });
    const fuel = lines.find((l) => l.chargeType === "fuel_levy");
    const weekend = lines.find((l) => l.chargeType === "weekend_surcharge");
    expect(fuel?.amount).toBe(3.35);   // 5% of 67
    expect(weekend?.amount).toBe(6.7); // 10% of 67, not of 70.35
  });

  it("only charges surcharges when the trigger actually happened", () => {
    const lines = buildServiceCharges({ items, weekendSurchargePct: 10, holidaySurchargePct: 20 });
    expect(lines.some((l) => l.chargeType === "weekend_surcharge")).toBe(false);
    expect(lines.some((l) => l.chargeType === "holiday_surcharge")).toBe(false);
  });

  it("adds the emergency fee only for emergency services", () => {
    expect(buildServiceCharges({ items, emergencyFee: 45 })
      .some((l) => l.chargeType === "emergency_delivery")).toBe(false);
    expect(buildServiceCharges({ items, emergencyFee: 45, isEmergency: true })
      .find((l) => l.chargeType === "emergency_delivery")?.amount).toBe(45);
  });

  it("charges the minimum in full when nothing was serviced", () => {
    const lines = buildServiceCharges({ items: [], minimumCharge: 80 });
    expect(summariseInvoice(lines).subtotal).toBe(80);
  });
});

describe("buildReplacementCharges", () => {
  it("bills damaged and missing items at replacement cost", () => {
    const [line] = buildReplacementCharges([
      { itemId: "i1", itemName: "Bath Towel", damagedQuantity: 2, missingQuantity: 3, replacementCost: 12.5 },
    ]);
    expect(line).toMatchObject({ quantity: 5, amount: 62.5, chargeType: "replacement" });
  });

  it("ignores clean lines and items with no replacement cost", () => {
    expect(buildReplacementCharges([
      { itemId: "i1", itemName: "Bath Towel", damagedQuantity: 0, missingQuantity: 0, replacementCost: 12.5 },
      { itemId: "i2", itemName: "Apron", damagedQuantity: 1, missingQuantity: 0, replacementCost: 0 },
    ])).toEqual([]);
  });
});

describe("formatMoney", () => {
  it("formats AUD", () => {
    expect(formatMoney(1234.5).replace(/ /g, " ")).toContain("1,234.50");
  });
});
