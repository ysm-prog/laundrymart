import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invoiceEvents, paymentsOnInvoice, xeroDate, xeroSignatureValid } from "@/lib/xero/webhook-payload";

const key = "test-webhook-key-123";
const sign = (body: string) => createHmac("sha256", key).update(body, "utf8").digest("base64");

describe("xeroSignatureValid", () => {
  const body = '{"events":[],"firstEventSequence":0,"lastEventSequence":0,"entropy":"ABC"}';

  it("accepts Xero's signature over the exact raw body", () => {
    expect(xeroSignatureValid(body, sign(body), key)).toBe(true);
  });

  it("rejects a wrong or missing signature", () => {
    expect(xeroSignatureValid(body, "not-a-signature", key)).toBe(false);
    expect(xeroSignatureValid(body, null, key)).toBe(false);
  });

  it("rejects the same JSON once re-serialised", () => {
    const reserialised = JSON.stringify(JSON.parse(body), null, 1);
    expect(xeroSignatureValid(reserialised, sign(body), key)).toBe(false);
  });

  it("rejects everything when no key is configured", () => {
    expect(xeroSignatureValid(body, sign(body), "")).toBe(false);
  });
});

describe("invoiceEvents", () => {
  it("keeps invoice events once each and drops the rest", () => {
    const raw = JSON.stringify({
      events: [
        { resourceId: "inv-1", tenantId: "org-1", eventCategory: "INVOICE", eventType: "UPDATE" },
        { resourceId: "inv-1", tenantId: "org-1", eventCategory: "INVOICE", eventType: "UPDATE" },
        { resourceId: "c-1", tenantId: "org-1", eventCategory: "CONTACT", eventType: "UPDATE" },
      ],
    });
    expect(invoiceEvents(raw)).toEqual([
      { resourceId: "inv-1", tenantId: "org-1", eventCategory: "INVOICE", eventType: "UPDATE" },
    ]);
  });

  it("treats the intent-to-receive test and junk as no events", () => {
    expect(invoiceEvents('{"events":[]}')).toEqual([]);
    expect(invoiceEvents("not json")).toEqual([]);
    expect(invoiceEvents("null")).toEqual([]);
  });
});

describe("xeroDate", () => {
  it("reads Xero's /Date()/ format and plain ISO dates", () => {
    expect(xeroDate("/Date(1760745600000+0000)/")).toBe("2025-10-18");
    expect(xeroDate("2026-10-18T00:00:00")).toBe("2026-10-18");
  });

  it("returns null for anything else", () => {
    expect(xeroDate(undefined)).toBeNull();
    expect(xeroDate("soon")).toBeNull();
  });
});

describe("paymentsOnInvoice", () => {
  it("keeps the payments that can be recorded", () => {
    expect(
      paymentsOnInvoice({
        Payments: [
          { PaymentID: "p-1", Amount: 46.2, Date: "/Date(1760745600000+0000)/", Reference: " EFT " },
          { PaymentID: "p-2", Amount: 0, Date: "/Date(1760745600000+0000)/" },
          { Amount: 10, Date: "/Date(1760745600000+0000)/" },
        ],
      }),
    ).toEqual([{ paymentId: "p-1", amount: 46.2, paidOn: "2025-10-18", reference: "EFT" }]);
  });

  it("returns nothing for an invoice without payments", () => {
    expect(paymentsOnInvoice({})).toEqual([]);
    expect(paymentsOnInvoice(undefined)).toEqual([]);
  });
});
