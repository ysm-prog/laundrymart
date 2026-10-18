import { after } from "next/server";
import { env } from "@/lib/env";
import { applyXeroInvoiceEvents } from "@/lib/xero/webhook";
import { invoiceEvents, xeroSignatureValid } from "@/lib/xero/webhook-payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Xero webhook delivery (Xero app "ATS Services" > Webhooks, Invoices event).
 *
 * Answers 401 to anything not signed with XERO_WEBHOOK_KEY and 200 otherwise,
 * with an empty body either way — exactly what Xero's "intent to receive"
 * check needs. The work happens after the response, since Xero gives up on a
 * delivery that takes more than five seconds.
 */
export async function POST(request: Request): Promise<Response> {
  const key = env.XERO_WEBHOOK_KEY;
  const raw = await request.text();
  if (!key || !xeroSignatureValid(raw, request.headers.get("x-xero-signature"), key)) {
    return new Response(null, { status: 401 });
  }
  const events = invoiceEvents(raw);
  if (events.length > 0) after(() => applyXeroInvoiceEvents(events));
  return new Response(null, { status: 200 });
}
