import { describe, expect, it } from "vitest";
import { buildVoidPayload, voidGate } from "@/lib/xero/void-payload";

/**
 * The void gate, tested against the four states an invoice can be in when
 * somebody voids it here.
 *
 * The distinction the whole module exists to make is **skip vs failure**. Three
 * of these are ordinary and must stay quiet; one is a refusal the operator has
 * to act on, and reporting it as anything less would leave their books showing
 * money they have written off.
 */
describe("voidGate", () => {
  it("skips an invoice that never reached Xero", () => {
    // Much the commonest case — a draft voided before it was ever issued.
    const gate = voidGate({ xeroInvoiceId: null, payments: [] });
    expect(gate.send).toBe(false);
    expect(gate.send === false && gate.skipped).toBe(true);
  });

  it("skips one that is already void in Xero", () => {
    // Xero treats VOIDED as terminal: a second void is a validation error, not
    // a no-op, so this cannot be left to the request to discover.
    const gate = voidGate({
      xeroInvoiceId: "xero-1", xeroStatus: "VOIDED", payments: [],
    });
    expect(gate.send).toBe(false);
    expect(gate.send === false && gate.skipped).toBe(true);
  });

  it("is case-insensitive about the status Xero reports", () => {
    const gate = voidGate({
      xeroInvoiceId: "xero-1", xeroStatus: "voided", payments: [],
    });
    expect(gate.send).toBe(false);
  });

  it("REFUSES — not skips — an invoice with a payment posted to Xero", () => {
    // The case that will actually happen. Xero will not void an invoice with
    // payments applied, and it is right not to: that protects a reconciled bank
    // line. This is a failure precisely because the operator must do something
    // about it, and the message has to name what.
    const gate = voidGate({
      xeroInvoiceId: "xero-1",
      xeroStatus: "AUTHORISED",
      payments: [{ xero_payment_id: "pay-1" }],
    });
    expect(gate.send).toBe(false);
    expect(gate.send === false && gate.skipped).toBe(false);
    expect(gate.send === false && gate.reason).toContain("credit note");
    expect(gate.send === false && gate.reason).toContain("1 payment");
  });

  it("ignores a payment that never reached Xero", () => {
    // A payment recorded here but not posted does not stop Xero voiding, so
    // blocking on it would refuse a void that would in fact have succeeded.
    const gate = voidGate({
      xeroInvoiceId: "xero-1",
      xeroStatus: "AUTHORISED",
      payments: [{ xero_payment_id: null }],
    });
    expect(gate.send).toBe(true);
  });

  it("counts only the posted payments in the message", () => {
    const gate = voidGate({
      xeroInvoiceId: "xero-1",
      payments: [
        { xero_payment_id: "pay-1" },
        { xero_payment_id: null },
        { xero_payment_id: "pay-2" },
      ],
    });
    expect(gate.send === false && gate.reason).toContain("2 payment");
  });

  it("sends an authorised invoice with nothing paid against it", () => {
    const gate = voidGate({
      xeroInvoiceId: "xero-1", xeroStatus: "AUTHORISED", payments: [],
    });
    expect(gate.send).toBe(true);
  });

  it("sends when Xero's status was never recorded", () => {
    // `xero_status` is only written by the void path, so an invoice pushed
    // before this existed carries null. Treating that as "already void" would
    // silently skip every one of them.
    const gate = voidGate({ xeroInvoiceId: "xero-1", payments: [] });
    expect(gate.send).toBe(true);
  });
});

describe("buildVoidPayload", () => {
  it("sends the id and the status and nothing else", () => {
    // Anything more — a line item, a contact — reads to Xero as an edit, which
    // it refuses on a voided document.
    expect(buildVoidPayload("xero-1")).toEqual({
      InvoiceID: "xero-1", Status: "VOIDED",
    });
    expect(Object.keys(buildVoidPayload("xero-1"))).toHaveLength(2);
  });
});
