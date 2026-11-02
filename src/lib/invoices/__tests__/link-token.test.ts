import { describe, expect, it } from "vitest";
import { LINK_LIFE_DAYS, createInvoiceToken, readInvoiceToken } from "../link-token";

const SECRET = "a-long-enough-test-secret";
const ID = "a7dfd059-53dd-45b4-b170-383dd28a205a";
const NOW = Date.UTC(2026, 10, 2);
const DAY = 86_400_000;

describe("the invoice link token", () => {
  it("reads back the invoice it was made for", () => {
    expect(readInvoiceToken(createInvoiceToken(ID, SECRET, NOW), SECRET, NOW))
      .toEqual({ ok: true, invoiceId: ID });
  });

  it("is short enough to go in a text", () => {
    expect(createInvoiceToken(ID, SECRET, NOW).length).toBeLessThanOrEqual(52);
  });

  it("works to the last day and not after", () => {
    const token = createInvoiceToken(ID, SECRET, NOW);
    expect(readInvoiceToken(token, SECRET, NOW + LINK_LIFE_DAYS * DAY).ok).toBe(true);
    expect(readInvoiceToken(token, SECRET, NOW + (LINK_LIFE_DAYS + 1) * DAY))
      .toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a token signed with another secret", () => {
    expect(readInvoiceToken(createInvoiceToken(ID, "another-secret-entirely", NOW), SECRET, NOW))
      .toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses another invoice's id under this signature", () => {
    const [, expires, signature] = createInvoiceToken(ID, SECRET, NOW).split(".");
    const [otherId] = createInvoiceToken("b7dfd059-53dd-45b4-b170-383dd28a205a", SECRET, NOW).split(".");
    expect(readInvoiceToken(`${otherId}.${expires}.${signature}`, SECRET, NOW).ok).toBe(false);
  });

  it("refuses a pushed-out expiry", () => {
    const [id, , signature] = createInvoiceToken(ID, SECRET, NOW).split(".");
    expect(readInvoiceToken(`${id}.zzzz.${signature}`, SECRET, NOW).ok).toBe(false);
  });

  it("refuses anything that is not a token", () => {
    for (const junk of ["", "abc", "a.b", "a.b.c.d"]) {
      expect(readInvoiceToken(junk, SECRET, NOW)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("will not make a link for something that is not an id", () => {
    expect(() => createInvoiceToken("not-an-id", SECRET, NOW)).toThrow();
  });
});
