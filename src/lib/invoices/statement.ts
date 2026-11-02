import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { parseInvoiceProfile } from "@/lib/domain/invoice-profile";
import { arTrustedFrom } from "@/lib/domain/receivables";
import {
  OPEN_INVOICE_STATUSES, buildStatement, statementHasContent,
  type Statement, type StatementInvoice,
} from "@/lib/domain/statement";
import { businessToday } from "@/lib/domain/timezone";
import { buildStatementEmail } from "@/lib/email/statement-email";
import { sendEmail } from "@/lib/email/send";
import { loadContactName } from "@/lib/pdf/invoice-data";
import { loadTenantLogo } from "@/lib/pdf/logo";
import { renderStatementPdf, statementFileName } from "@/lib/pdf/render";
import type { StatementPdfData } from "@/lib/pdf/statement-document";

/**
 * Reading and sending a customer's statement.
 *
 * Every read names the tenant, because a platform admin's session reads every
 * laundry (§3). Sending writes nothing but the audit row: a statement is a view of
 * the invoices, not a document with a number of its own, and the audit log is the
 * record of who was sent what.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

const INVOICE_COLUMNS =
  "id, customer_id, invoice_number, invoice_type, status, issue_date, due_date, " +
  "purchase_order_number, total, amount_paid, amount_credited, balance, source";

type InvoiceRow = StatementInvoice & { customer_id: string };

async function trustedFromFor(supabase: Client, tenantId: string) {
  const { data } = await supabase
    .from("tenants").select("name, abn, settings").eq("id", tenantId)
    .maybeSingle<{ name: string; abn: string | null; settings: unknown }>();
  return { tenant: data, trustedFrom: arTrustedFrom(data?.settings) };
}

export async function loadStatement(
  supabase: Client, tenantId: string, customerId: string, asAt = businessToday(),
): Promise<StatementPdfData | null> {
  const [{ data: customer }, { data: invoices }, { tenant, trustedFrom }, contactName] = await Promise.all([
    supabase
      .from("customers")
      .select("id, business_name, customer_number, abn, billing_email, phone, " +
              "billing_address_line1, billing_address_line2, billing_suburb, billing_state, billing_postcode")
      .eq("tenant_id", tenantId).eq("id", customerId)
      .maybeSingle<{
        id: string; business_name: string; customer_number: string; abn: string | null;
        billing_email: string | null; phone: string | null; billing_address_line1: string | null;
        billing_address_line2: string | null; billing_suburb: string | null;
        billing_state: string | null; billing_postcode: string | null;
      }>(),
    supabase
      .from("invoices").select(INVOICE_COLUMNS)
      .eq("tenant_id", tenantId).eq("customer_id", customerId)
      .in("status", [...OPEN_INVOICE_STATUSES]).is("deleted_at", null)
      .returns<InvoiceRow[]>(),
    trustedFromFor(supabase, tenantId),
    loadContactName(supabase, tenantId, customerId),
  ]);
  if (!customer) return null;

  const profile = parseInvoiceProfile(tenant?.settings);
  return {
    tenant: {
      name: tenant?.name ?? "Laundry",
      abn: tenant?.abn ?? null,
      profile,
      logo: await loadTenantLogo(supabase, tenantId, profile.logoPath),
    },
    customer: {
      id: customer.id,
      business_name: customer.business_name,
      customer_number: customer.customer_number,
      abn: customer.abn,
      billing_email: customer.billing_email,
      phone: customer.phone,
      contact_name: contactName,
      address: [
        customer.billing_address_line1,
        customer.billing_address_line2,
        [customer.billing_suburb, customer.billing_state, customer.billing_postcode].filter(Boolean).join(" "),
      ].filter((part): part is string => Boolean(part && part.trim())),
    },
    statement: buildStatement(invoices ?? [], { asAt, trustedFrom }),
  };
}

export type StatementSummary = {
  customerId: string;
  name: string;
  customerNumber: string;
  billingEmail: string | null;
  statement: Statement;
};

/** PostgREST's page size: the open list here is six hundred rows and can grow past it. */
const PAGE = 1000;

/** Every customer with something open, for the bulk screen. */
export async function loadStatementList(
  supabase: Client, tenantId: string, asAt = businessToday(),
): Promise<StatementSummary[]> {
  const { trustedFrom } = await trustedFromFor(supabase, tenantId);

  type Row = InvoiceRow & {
    customers: { business_name: string; customer_number: string; billing_email: string | null } | null;
  };
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await supabase
      .from("invoices")
      .select(`${INVOICE_COLUMNS}, customers(business_name, customer_number, billing_email)`)
      .eq("tenant_id", tenantId)
      .in("status", [...OPEN_INVOICE_STATUSES]).is("deleted_at", null)
      .order("id")
      .range(from, from + PAGE - 1)
      .returns<Row[]>();
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  const byCustomer = new Map<string, Row[]>();
  for (const row of rows) byCustomer.set(row.customer_id, [...(byCustomer.get(row.customer_id) ?? []), row]);

  return [...byCustomer.entries()]
    .map(([customerId, invoices]) => ({
      customerId,
      name: invoices[0]?.customers?.business_name ?? "Unknown customer",
      customerNumber: invoices[0]?.customers?.customer_number ?? "",
      billingEmail: invoices[0]?.customers?.billing_email ?? null,
      statement: buildStatement(invoices, { asAt, trustedFrom }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type StatementSendResult =
  | { ok: true; customer: string; recipient: string }
  | { ok: false; customer: string | null; error: string };

export async function sendStatement(
  supabase: Client, session: Session, customerId: string, overrideRecipient?: string | null,
): Promise<StatementSendResult> {
  const data = await loadStatement(supabase, session.tenantId, customerId);
  if (!data) return { ok: false, customer: null, error: "that customer could not be found" };

  const customer = data.customer.business_name;
  if (!statementHasContent(data.statement)) {
    return { ok: false, customer, error: "there is nothing outstanding to put on a statement" };
  }
  const recipient = overrideRecipient?.trim() || data.customer.billing_email;
  if (!recipient) return { ok: false, customer, error: "this customer has no billing email" };

  const pdf = await renderStatementPdf(data);
  const { subject, html, text } = buildStatementEmail(data);
  const result = await sendEmail({
    to: recipient, subject, html, text,
    attachments: [{
      filename: statementFileName(data.customer.customer_number, data.statement.asAt), content: pdf,
    }],
  });

  if (!result.ok) {
    await recordAudit(session, {
      entity: "customer", entityId: customerId, action: "send_failed",
      summary: `statement to ${recipient}: ${result.error}`,
    });
    return { ok: false, customer, error: result.error };
  }

  await recordAudit(session, {
    entity: "customer", entityId: customerId, action: "send",
    summary: `statement sent to ${recipient}`,
    metadata: {
      providerId: result.id, total: data.statement.total, invoices: data.statement.rows.length,
      excluded: data.statement.excluded.count,
    },
  });
  return { ok: true, customer, recipient };
}
