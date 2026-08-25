import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { XERO_API } from "./config";
import { summariseXeroError } from "./errors";
import { getXeroTokens } from "./tokens";
import {
  buildInvoicePayload, canPushToXero,
  type PayloadCustomer, type PayloadInvoice, type PayloadLine,
} from "./invoice-payload";

/**
 * Send one issued invoice to Xero.
 *
 * **This never throws and never blocks issuing.** The money record is this
 * database's; Xero is a copy of it. A provider outage, an expired connection or
 * a rejected payload has to leave the invoice issued and the failure visible,
 * not roll back an invoice the customer has already been told about — so every
 * outcome comes back as a value and is written onto the invoice row for the
 * register to show and offer to retry.
 *
 * Modelled on `ysm-prog/ysm-hub`'s `lib/_xero-invoice.js`.
 */

export type PushOutcome =
  | { ok: true; xeroInvoiceId: string; contactId: string | null }
  | { ok: false; reason: string; skipped?: boolean };

type InvoiceRow = PayloadInvoice & {
  id: string;
  tenant_id: string;
  status: string;
  customer_id: string;
  xero_invoice_id: string | null;
};

/**
 * Push, then record the outcome on the invoice.
 *
 * `skipped` outcomes (no Xero configured, laundry not connected, a draft) are
 * *not* errors and are deliberately not written to `xero_push_error`: a laundry
 * that has never connected Xero should not have every invoice wearing a red
 * failure it cannot act on.
 */
export async function pushInvoiceToXero(
  supabase: SupabaseClient,
  invoiceId: string,
  tenantId: string,
): Promise<PushOutcome> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, tenant_id, status, customer_id, invoice_number, issue_date, due_date, " +
            "purchase_order_number, notes, xero_invoice_id")
    .eq("id", invoiceId).eq("tenant_id", tenantId)
    .maybeSingle<InvoiceRow>();

  if (!invoice) return { ok: false, reason: "That invoice could not be found.", skipped: true };
  if (!canPushToXero(invoice.status)) {
    return { ok: false, reason: `A ${invoice.status} invoice is not sent to Xero.`, skipped: true };
  }

  const tokens = await getXeroTokens(tenantId);
  if (!tokens) {
    return {
      ok: false, skipped: true,
      reason: "This laundry is not connected to Xero, so nothing was sent.",
    };
  }

  const [{ data: customer }, { data: lines }] = await Promise.all([
    supabase.from("customers")
      .select("business_name, trading_name, billing_email, xero_contact_id, xero_contact_name, " +
              "billing_address_line1, billing_address_line2, billing_suburb, billing_state, " +
              "billing_postcode")
      .eq("id", invoice.customer_id).eq("tenant_id", tenantId)
      .maybeSingle<PayloadCustomer>(),
    supabase.from("invoice_lines")
      .select("description, quantity, unit_price, taxable, account_code")
      .eq("invoice_id", invoice.id).eq("tenant_id", tenantId)
      .order("sequence")
      .returns<PayloadLine[]>(),
  ]);

  if (!customer) {
    return await record(supabase, invoice.id, tenantId,
      { ok: false, reason: "That invoice's customer could not be read." });
  }
  if (!lines || lines.length === 0) {
    return await record(supabase, invoice.id, tenantId,
      { ok: false, reason: "That invoice has no lines, so there is nothing to send." });
  }

  const payload = buildInvoicePayload({ invoice, lines, customer });
  // Re-pushing carries the Xero id, which turns the create into an update —
  // this is what stops a retry from producing a second invoice in the books.
  if (invoice.xero_invoice_id) payload.InvoiceID = invoice.xero_invoice_id;

  let response: Response;
  try {
    response = await fetch(`${XERO_API}/Invoices`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Xero-tenant-id": tokens.xeroTenantId,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ Invoices: [payload] }),
    });
  } catch (cause) {
    return await record(supabase, invoice.id, tenantId, {
      ok: false,
      reason: `Xero could not be reached. ${cause instanceof Error ? cause.message : ""}`.trim(),
    });
  }

  if (!response.ok) {
    // Xero puts the useful part in the body, not the status line: "Invoice #
    // must be unique", "Account code 200 is not a valid code". Surfacing it is
    // the difference between a fixable message and "400".
    const detail = await response.text().catch(() => "");
    return await record(supabase, invoice.id, tenantId, {
      ok: false,
      reason: `Xero refused the invoice (${response.status}). ${summariseXeroError(detail)}`.trim(),
    });
  }

  const body = await response.json().catch(() => null) as
    { Invoices?: { InvoiceID?: string; Contact?: { ContactID?: string } }[] } | null;
  const created = body?.Invoices?.[0];
  if (!created?.InvoiceID) {
    return await record(supabase, invoice.id, tenantId,
      { ok: false, reason: "Xero accepted the request but returned no invoice." });
  }

  // Remember the contact so the next invoice for this customer attaches to it
  // rather than creating a twin. Only when we did not already know it.
  const contactId = created.Contact?.ContactID ?? null;
  if (contactId && !customer.xero_contact_id) {
    await supabase.from("customers")
      .update({ xero_contact_id: contactId })
      .eq("id", invoice.customer_id).eq("tenant_id", tenantId);
  }

  return await record(supabase, invoice.id, tenantId,
    { ok: true, xeroInvoiceId: created.InvoiceID, contactId });
}


/** Write the outcome onto the invoice so the register can show it. */
async function record(
  supabase: SupabaseClient,
  invoiceId: string,
  tenantId: string,
  outcome: PushOutcome,
): Promise<PushOutcome> {
  await supabase.from("invoices").update(
    outcome.ok
      ? {
          xero_invoice_id: outcome.xeroInvoiceId,
          xero_pushed_at: new Date().toISOString(),
          xero_push_error: null,
        }
      : { xero_push_error: outcome.reason },
  ).eq("id", invoiceId).eq("tenant_id", tenantId);

  return outcome;
}
