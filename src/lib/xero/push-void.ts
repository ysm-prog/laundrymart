import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { XERO_API } from "./config";
import { summariseXeroError } from "./errors";
import { getXeroTokens } from "./tokens";
import { buildVoidPayload, voidGate, type VoidablePayment } from "./void-payload";

/**
 * Void one invoice in Xero, after it has been voided here.
 *
 * Same contract as the other two pushes and for the same reason: **it never
 * throws and never blocks the void.** Voiding is how somebody undoes a wrong
 * invoice, and it also releases the jobs on it back into the billing queue
 * (0017). Making that depend on a third party being reachable would leave a
 * wrong invoice standing because Xero was down.
 *
 * The failure worth designing for is a *refusal*, not an outage: Xero will not
 * void an invoice with payments applied. `voidGate` catches that before the
 * request so the message can name the remedy — a credit note — rather than
 * relaying validation text.
 */

export type VoidPushOutcome =
  | { ok: true }
  | { ok: false; reason: string; skipped?: boolean };

export async function pushVoidToXero(
  supabase: SupabaseClient,
  invoiceId: string,
  tenantId: string,
): Promise<VoidPushOutcome> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, xero_invoice_id, xero_status")
    .eq("id", invoiceId).eq("tenant_id", tenantId)
    .maybeSingle<{ id: string; xero_invoice_id: string | null; xero_status: string | null }>();

  if (!invoice) {
    return { ok: false, reason: "That invoice could not be found.", skipped: true };
  }

  const { data: payments } = await supabase
    .from("payments")
    .select("xero_payment_id")
    .eq("invoice_id", invoiceId).eq("tenant_id", tenantId)
    .returns<VoidablePayment[]>();

  const gate = voidGate({
    xeroInvoiceId: invoice.xero_invoice_id,
    xeroStatus: invoice.xero_status,
    payments: payments ?? [],
  });
  if (!gate.send) {
    // A refusal a person must act on is written to the row so the register can
    // show it; a skip is not, on the same principle as the other two pushes.
    if (!gate.skipped) await record(supabase, invoiceId, tenantId, gate.reason);
    return { ok: false, reason: gate.reason, skipped: gate.skipped };
  }

  const tokens = await getXeroTokens(tenantId);
  if (!tokens) {
    return {
      ok: false, skipped: true,
      reason: "This laundry is not connected to Xero, so nothing was sent.",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${XERO_API}/Invoices/${invoice.xero_invoice_id}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Xero-tenant-id": tokens.xeroTenantId,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ Invoices: [buildVoidPayload(invoice.xero_invoice_id!)] }),
    });
  } catch (cause) {
    return await recordAndReturn(supabase, invoiceId, tenantId,
      `Xero could not be reached to void this invoice. `
      + `${cause instanceof Error ? cause.message : ""}`.trim());
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return await recordAndReturn(supabase, invoiceId, tenantId,
      `Xero refused to void the invoice (${response.status}). `
      + `${summariseXeroError(detail)}`.trim());
  }

  const body = await response.json().catch(() => null) as
    { Invoices?: { Status?: string }[] } | null;
  const status = body?.Invoices?.[0]?.Status;
  if ((status ?? "").toUpperCase() !== "VOIDED") {
    // Xero answered 200 and did not void it. Reporting the status it *did*
    // report is more useful than "something went wrong", and this must not be
    // recorded as a success or the books quietly disagree.
    return await recordAndReturn(supabase, invoiceId, tenantId,
      `Xero accepted the request but the invoice is ${status ?? "in an unknown state"} there, `
      + "not voided.");
  }

  await supabase.from("invoices")
    .update({
      xero_status: "VOIDED",
      xero_pushed_at: new Date().toISOString(),
      xero_push_error: null,
    })
    .eq("id", invoiceId).eq("tenant_id", tenantId);

  return { ok: true };
}

async function record(
  supabase: SupabaseClient, invoiceId: string, tenantId: string, reason: string,
): Promise<void> {
  await supabase.from("invoices")
    .update({ xero_push_error: reason })
    .eq("id", invoiceId).eq("tenant_id", tenantId);
}

async function recordAndReturn(
  supabase: SupabaseClient, invoiceId: string, tenantId: string, reason: string,
): Promise<VoidPushOutcome> {
  await record(supabase, invoiceId, tenantId, reason);
  return { ok: false, reason };
}
