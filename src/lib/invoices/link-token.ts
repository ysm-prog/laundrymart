import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signed token in the link a text message carries. Pure: the secret is passed
 * in, so the signing rule can be tested with no environment.
 *
 * A text cannot carry an attachment, and the customer has no login, so the link is
 * the capability: whoever holds it can read that one invoice until it expires, and
 * nothing else. So it is signed rather than looked up (there is no table of links
 * to leak or to clean up), and it names one invoice and one expiry, both covered by
 * the signature.
 *
 * Short on purpose, because it goes in an SMS: the invoice id as 22 characters
 * instead of 36, the expiry as a day number, and a signature cut to 128 bits.
 */

const DAY_MS = 86_400_000;

/** Long enough to outlast 14-day terms and a reminder. */
export const LINK_LIFE_DAYS = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sign(secret: string, payload: string): string {
  // A context string, so this key can only ever mean "an invoice link", whatever
  // else is ever derived from the same secret.
  const key = createHmac("sha256", secret).update("invoice-link-v1").digest();
  return createHmac("sha256", key).update(payload).digest().subarray(0, 16).toString("base64url");
}

export function createInvoiceToken(invoiceId: string, secret: string, now = Date.now()): string {
  if (!UUID.test(invoiceId)) throw new Error("An invoice link needs an invoice id.");
  const id = Buffer.from(invoiceId.replace(/-/g, ""), "hex").toString("base64url");
  const expires = (Math.floor(now / DAY_MS) + LINK_LIFE_DAYS).toString(36);
  const payload = `${id}.${expires}`;
  return `${payload}.${sign(secret, payload)}`;
}

export type InvoiceTokenResult =
  | { ok: true; invoiceId: string }
  | { ok: false; reason: "invalid" | "expired" };

export function readInvoiceToken(token: string, secret: string, now = Date.now()): InvoiceTokenResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [id, expires, signature] = parts as [string, string, string];

  const expected = Buffer.from(sign(secret, `${id}.${expires}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "invalid" };
  }

  // The signature is checked first, so nothing below reads an unsigned value.
  if (Math.floor(now / DAY_MS) > parseInt(expires, 36)) return { ok: false, reason: "expired" };
  const hex = Buffer.from(id, "base64url").toString("hex");
  if (hex.length !== 32) return { ok: false, reason: "invalid" };
  return {
    ok: true,
    invoiceId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}
