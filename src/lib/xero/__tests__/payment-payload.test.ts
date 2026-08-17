import { describe, expect, it } from "vitest";
import {
  buildPaymentPayload, paymentGate, paymentReference,
} from "@/lib/xero/payment-payload";

const PAYMENT = {
  id: "11111111-1111-1111-1111-111111111111",
  amount: 250.5,
  paid_on: "2026-08-14",
  method: "bank_transfer",
  reference: null,
  xero_payment_id: null,
};

describe("paymentGate", () => {
  it("sends a payment that has everything it needs", () => {
    expect(paymentGate({
      payment: PAYMENT, xeroInvoiceId: "xero-inv-1", paymentAccountCode: "090",
    })).toEqual({ send: true });
  });

  it("treats an already-posted payment as done, not as work", () => {
    // What stops a bulk retry reposting money that is already in the books.
    const gate = paymentGate({
      payment: { ...PAYMENT, xero_payment_id: "xero-pay-1" },
      xeroInvoiceId: "xero-inv-1", paymentAccountCode: "090",
    });
    expect(gate.send).toBe(false);
    expect(gate).toMatchObject({ skipped: true });
  });

  it("skips rather than fails when the invoice never reached Xero", () => {
    // Nothing to pay against. The laundry has not done anything wrong, so this
    // must not put a red error on the payment.
    const gate = paymentGate({
      payment: PAYMENT, xeroInvoiceId: null, paymentAccountCode: "090",
    });
    expect(gate).toMatchObject({ send: false, skipped: true });
    expect(gate.send === false && gate.reason).toContain("invoice");
  });

  it("skips rather than fails when no bank account has been chosen", () => {
    // Xero will not take a payment without an account, and only the laundry
    // knows which one. Guessing would put money against the wrong account.
    const gate = paymentGate({
      payment: PAYMENT, xeroInvoiceId: "xero-inv-1", paymentAccountCode: null,
    });
    expect(gate).toMatchObject({ send: false, skipped: true });
    expect(gate.send === false && gate.reason).toContain("bank account");
  });

  it("does not send a zero or negative payment", () => {
    // A refund or correction in this schema; Xero wants a credit note for that,
    // and /Payments refuses it.
    for (const amount of [0, -50]) {
      expect(paymentGate({
        payment: { ...PAYMENT, amount },
        xeroInvoiceId: "xero-inv-1", paymentAccountCode: "090",
      })).toMatchObject({ send: false, skipped: true });
    }
  });

  it("reads an amount PostgREST returned as a string", () => {
    expect(paymentGate({
      payment: { ...PAYMENT, amount: "250.50" },
      xeroInvoiceId: "xero-inv-1", paymentAccountCode: "090",
    })).toEqual({ send: true });
  });
});

describe("paymentReference", () => {
  it("prefers what the customer actually put on the transfer", () => {
    // The thing somebody reconciling a bank statement is searching for.
    expect(paymentReference({ reference: "INV42 CAFEA", method: "bank_transfer" }))
      .toBe("INV42 CAFEA");
  });

  it("falls back to a readable method rather than a bare amount", () => {
    expect(paymentReference({ reference: null, method: "bank_transfer" }))
      .toBe("Laundry payment — bank transfer");
    expect(paymentReference({ reference: "   ", method: "cheque" }))
      .toBe("Laundry payment — cheque");
  });

  it("still says something when there is no method either", () => {
    expect(paymentReference({ reference: null, method: null })).toBe("Laundry payment");
  });
});

describe("buildPaymentPayload", () => {
  it("posts against the invoice and the chosen account", () => {
    const payload = buildPaymentPayload({
      payment: PAYMENT, xeroInvoiceId: "xero-inv-1", paymentAccountCode: "090",
    });
    expect(payload).toMatchObject({
      Invoice: { InvoiceID: "xero-inv-1" },
      Account: { Code: "090" },
      Date: "2026-08-14",
      Amount: 250.5,
    });
  });

  it("coerces a numeric-as-string amount", () => {
    expect(buildPaymentPayload({
      payment: { ...PAYMENT, amount: "99.95" },
      xeroInvoiceId: "x", paymentAccountCode: "090",
    }).Amount).toBe(99.95);
  });

  it("falls back to today only when the row has no paid_on", () => {
    const payload = buildPaymentPayload({
      payment: { ...PAYMENT, paid_on: null }, xeroInvoiceId: "x", paymentAccountCode: "090",
    });
    expect(payload.Date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
