import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { XERO_API } from "./config";
import { summariseXeroError } from "./errors";
import { getXeroTokens } from "./tokens";
import { createAdminClient } from "@/lib/supabase/admin";
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
/**
 * A line as it comes back, with the embedded item and its account.
 *
 * PostgREST returns a to-one embed as an object, but the generated types and
 * some versions hand back a single-element array — both are read here rather
 * than one being assumed, which is the shape `requireSession()` already handles
 * for `tenants(name)`.
 */
type Embedded<T> = T | T[] | null;
type LineRow = PayloadLine & {
  items?: Embedded<{
    xero_item_code: string | null;
    gl_accounts?: Embedded<{ xero_account_code: string | null }>;
  }>;
  /**
   * The account 0036 stamps on the line itself. Read **in preference to** the
   * one reached through the item, because it is set in both cases the invoice
   * composer produces: picking an item copies that item's income account here,
   * and picking a bare account code sets it with no item at all. A line coded
   * the second way has no `items` row to travel through, so resolving only
   * through the item would silently drop its code.
   */
  gl_accounts?: Embedded<{ xero_account_code: string | null }>;
};

const one = <T,>(value: Embedded<T> | undefined): T | null =>
  (Array.isArray(value) ? value[0] ?? null : value ?? null);

function toPayloadLine(row: LineRow): PayloadLine {
  const item = one(row.items);
  return {
    description: row.description,
    quantity: row.quantity,
    unit_price: row.unit_price,
    taxable: row.taxable,
    item_code: item?.xero_item_code ?? null,
    /*
     * **The Xero code, never the one printed on the invoice.** Two charts are in
     * play and they are not the same: `invoice_lines.account_code` is the MYOB
     * code the bookkeeper reads (`4-1100`), and `gl_accounts.xero_account_code`
     * is what that account is called in Xero. Sending the first would make Xero
     * refuse an invoice naming a code its own chart does not carry — so the MYOB
     * code stays on the screen and in the PDF, and only this one travels.
     *
     * The line's own account first, the item's second: the composer sets the
     * direct link for a line coded straight to an account, where there is no
     * item to reach through.
     */
    account_code: one(row.gl_accounts)?.xero_account_code
      ?? one(item?.gl_accounts)?.xero_account_code
      ?? null,
  };
}

/**
 * The laundry's default sales account, for every line no item codes.
 *
 * Through the **service-role** client and filtered by tenant by hand, because
 * `authenticated` may not read `xero_connections` at all (0026): the table
 * holds a refresh token, so the grants are revoked rather than merely policied.
 * The same route `push-payment.ts` takes for the bank account, and §2's rule
 * for the admin client applies — the tenant is named here.
 */
async function salesAccountCode(tenantId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("xero_connections").select("sales_account_code")
    .eq("tenant_id", tenantId)
    .maybeSingle<{ sales_account_code: string | null }>();
  return data?.sales_account_code ?? null;
}

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
    // The codes travel through the item: `invoice_lines.item_id → items →
    // gl_accounts`. Read at push time rather than snapshotted onto the line,
    // deliberately — a code is a *classification*, not money, so a laundry that
    // fills its codes in later, or corrects a wrong one and presses Retry,
    // should have the corrected code sent. What is frozen is the amount, which
    // `job_charge_snapshots` already holds.
    //
    // Both embeds are unambiguous — `invoice_lines` has one FK to `items` and
    // `items` one to `gl_accounts` — which matters here: this repo has shipped
    // an ambiguous embed that was compile-clean and dead in production (PGRST201).
    supabase.from("invoice_lines")
      .select("description, quantity, unit_price, taxable, " +
              "items(xero_item_code, gl_accounts(xero_account_code)), " +
              // 0036's direct link. Unambiguous: `invoice_lines` has exactly one
              // FK to `gl_accounts`, so this embed needs no constraint name.
              "gl_accounts(xero_account_code)")
      .eq("invoice_id", invoice.id).eq("tenant_id", tenantId)
      .order("sequence")
      .returns<LineRow[]>(),
  ]);

  if (!customer) {
    return await record(supabase, invoice.id, tenantId,
      { ok: false, reason: "That invoice's customer could not be read." });
  }
  if (!lines || lines.length === 0) {
    return await record(supabase, invoice.id, tenantId,
      { ok: false, reason: "That invoice has no lines, so there is nothing to send." });
  }

  const payload = buildInvoicePayload({
    invoice,
    lines: lines.map(toPayloadLine),
    customer,
    defaultAccountCode: await salesAccountCode(tenantId),
  });
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
