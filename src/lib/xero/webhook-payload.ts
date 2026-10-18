import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Xero webhooks: the parts that need no network and no database, so they can
 * be tested on their own.
 *
 * Xero signs every delivery with HMAC-SHA256 of the **raw** body, keyed with
 * the app's webhook key, base64 in `x-xero-signature`. The check must run on
 * the body exactly as it arrived — re-serialising the JSON changes the bytes
 * and the signature stops matching. Xero's "intent to receive" test sends one
 * correctly and one incorrectly signed payload and expects 200 and 401.
 */
export function xeroSignatureValid(rawBody: string, signature: string | null, key: string): boolean {
  if (!signature || !key) return false;
  const expected = Buffer.from(createHmac("sha256", key).update(rawBody, "utf8").digest("base64"), "utf8");
  const given = Buffer.from(signature, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type XeroWebhookEvent = {
  resourceId: string;
  tenantId: string;
  eventCategory: "INVOICE";
  eventType: string;
};

/**
 * The invoice events in a delivery, once each. Everything else Xero can send
 * (contacts, credit notes, subscriptions) is dropped here: a paid invoice is
 * the only thing this app acts on, and Xero reports a payment as an UPDATE to
 * the invoice it was applied to.
 */
export function invoiceEvents(rawBody: string): XeroWebhookEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const events = (parsed as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return [];

  const seen = new Set<string>();
  const out: XeroWebhookEvent[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const { resourceId, tenantId, eventCategory, eventType } = event as Record<string, unknown>;
    if (eventCategory !== "INVOICE" || typeof resourceId !== "string" || typeof tenantId !== "string") continue;
    const key = `${tenantId}:${resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      resourceId,
      tenantId,
      eventCategory: "INVOICE",
      eventType: typeof eventType === "string" ? eventType : "",
    });
  }
  return out;
}

/** Xero's JSON dates look like `/Date(1760745600000+0000)/`; the app stores a plain date. */
export function xeroDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const plain = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value);
  if (plain) return plain[1] ?? null;
  const match = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export type XeroPaymentOnInvoice = {
  paymentId: string;
  amount: number;
  paidOn: string;
  reference: string | null;
};

/** The payments Xero lists on an invoice, keeping only the ones that can be recorded. */
export function paymentsOnInvoice(invoice: unknown): XeroPaymentOnInvoice[] {
  const list = (invoice as { Payments?: unknown } | null | undefined)?.Payments;
  if (!Array.isArray(list)) return [];

  const out: XeroPaymentOnInvoice[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const paymentId = typeof row.PaymentID === "string" ? row.PaymentID : null;
    const amount = Number(row.Amount);
    const paidOn = xeroDate(row.Date);
    if (!paymentId || !Number.isFinite(amount) || amount <= 0 || !paidOn) continue;
    const reference = typeof row.Reference === "string" && row.Reference.trim() ? row.Reference.trim() : null;
    out.push({ paymentId, amount: Math.round(amount * 100) / 100, paidOn, reference });
  }
  return out;
}
