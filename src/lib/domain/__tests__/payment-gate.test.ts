import { describe, expect, it } from "vitest";
import { paymentRefusal, settleHeaderOnly } from "../payment-gate";

const base = { status: "issued", invoiceType: "manual", balance: 100, amount: 40,
               paidOn: "2026-10-12", today: "2026-10-12" };

describe("paymentRefusal", () => {
  it("accepts a part payment on an issued invoice", () => {
    expect(paymentRefusal(base)).toBeNull();
  });
  it("accepts paying the exact balance on an overdue invoice", () => {
    expect(paymentRefusal({ ...base, status: "overdue", amount: 100 })).toBeNull();
  });
  it("refuses a draft, which must be issued first", () => {
    expect(paymentRefusal({ ...base, status: "draft" })).toMatch(/draft/i);
  });
  it("refuses a void invoice", () => {
    expect(paymentRefusal({ ...base, status: "void" })).toMatch(/void/i);
  });
  it("refuses a credit", () => {
    expect(paymentRefusal({ ...base, invoiceType: "credit", balance: -4.54 })).toMatch(/credit/i);
  });
  it("refuses an invoice already paid", () => {
    expect(paymentRefusal({ ...base, status: "paid", balance: 0 })).toMatch(/already paid/i);
  });
  it("refuses an overpayment and says what is owing", () => {
    expect(paymentRefusal({ ...base, amount: 100.02 })).toMatch(/\$100\.00/);
  });
  it("tolerates a sub-cent rounding difference", () => {
    expect(paymentRefusal({ ...base, amount: 100.004 })).toBeNull();
  });
  it("refuses a payment dated in the future", () => {
    expect(paymentRefusal({ ...base, paidOn: "2026-10-13" })).toMatch(/future/i);
  });
});

describe("settleHeaderOnly (imported MYOB header, no lines)", () => {
  it("adds to what MYOB had already recorded rather than replacing it", () => {
    // $500 invoice, $200 paid in MYOB, $100 now.
    expect(settleHeaderOnly(500, 200, 100)).toEqual({ amountPaid: 300, paid: false });
  });
  it("marks the invoice paid when the balance is cleared", () => {
    expect(settleHeaderOnly(500, 200, 300)).toEqual({ amountPaid: 500, paid: true });
  });
});
