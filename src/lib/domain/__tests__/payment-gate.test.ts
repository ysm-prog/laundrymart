import { describe, expect, it } from "vitest";
import {
  canTakePayment, issueRefusal, paymentRefusal, settleHeaderOnly,
} from "../payment-gate";

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

describe("canTakePayment — when the payment form is drawn at all", () => {
  it("draws it on an issued, part-paid or overdue invoice with something owing", () => {
    for (const status of ["issued", "part_paid", "overdue"]) {
      expect(canTakePayment({ invoice_type: "consolidated", status, balance: 72.7 })).toBe(true);
    }
  });

  it("never on a void, a draft, a paid invoice or a credit, whatever the balance says", () => {
    // The register pane drew it on any non-draft with a balance, so a voided
    // invoice offered a button that could only be refused.
    expect(canTakePayment({ invoice_type: "consolidated", status: "void", balance: 50 })).toBe(false);
    expect(canTakePayment({ invoice_type: "consolidated", status: "draft", balance: 50 })).toBe(false);
    expect(canTakePayment({ invoice_type: "consolidated", status: "paid", balance: 0 })).toBe(false);
    expect(canTakePayment({ invoice_type: "credit", status: "issued", balance: 20 })).toBe(false);
  });

  it("agrees with paymentRefusal for every status", () => {
    for (const status of ["draft", "issued", "part_paid", "paid", "overdue", "void"]) {
      const drawn = canTakePayment({ invoice_type: "consolidated", status, balance: 40 });
      const refused = paymentRefusal({
        status, invoiceType: "consolidated", balance: 40, amount: 10,
        paidOn: "2026-10-01", today: "2026-10-12",
      });
      expect(drawn).toBe(refused === null);
    }
  });
});

describe("issueRefusal — a draft goes out only with something on it", () => {
  it("issues a draft that carries lines", () => {
    expect(issueRefusal({ status: "draft", lineCount: 3 })).toBeNull();
  });

  it("refuses an emptied running draft rather than sending a $0.00 tax invoice", () => {
    expect(issueRefusal({ status: "draft", lineCount: 0 })).toMatch(/nothing on it/);
  });

  it("refuses anything that is no longer a draft", () => {
    expect(issueRefusal({ status: "issued", lineCount: 3 })).toBe("it is no longer a draft");
  });
});
