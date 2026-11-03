import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { parseInvoiceProfile } from "@/lib/domain/invoice-profile";
import { arTrustedFrom } from "@/lib/domain/receivables";
import {
  OPEN_INVOICE_STATUSES, buildStatement, statementHasContent,
  type Statement, type StatementInvoice, type StatementOutcome,
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

/**
 * The caller's RLS-bound client, or the service-role one for the monthly run.
 * Every read here names the tenant and the archive, so either reads the same rows.
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

/** The statement date and whether invoices issued after it are left off (the default). */
export type StatementOptions = { asAt?: string; upToAsAt?: boolean };

export async function loadStatement(
  supabase: Client, tenantId: string, customerId: string, options: StatementOptions = {},
): Promise<StatementPdfData | null> {
  const asAt = options.asAt ?? businessToday();
  const [{ data: customer }, { data: invoices }, { tenant, trustedFrom }, contactName] = await Promise.all([
    supabase
      .from("customers")
      .select("id, business_name, customer_number, abn, billing_email, phone, " +
              "billing_address_line1, billing_address_line2, billing_suburb, billing_state, billing_postcode")
      .eq("tenant_id", tenantId).eq("id", customerId).is("archived_at", null)
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
      // RLS hides an archived invoice; the monthly run reads on the service-role
      // client, which RLS does not filter, so the archive is named here too.
      .is("archived_at", null)
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
    statement: buildStatement(invoices ?? [], { asAt, trustedFrom, upToAsAt: options.upToAsAt }),
  };
}

export type StatementSummary = {
  customerId: string;
  name: string;
  customerNumber: string;
  billingEmail: string | null;
  phone: string | null;
  contactName: string | null;
  remindersEnabled: boolean | null;
  statement: Statement;
};

/** PostgREST's page size: the open list here is six hundred rows and can grow past it. */
const PAGE = 1000;

/**
 * Each customer's first contact, the person a statement is addressed to, in one
 * read per hundred customers. Batched because supabase-js sends a filtered read as
 * a GET, and six hundred uuids in one `in()` is a URL a proxy may not carry.
 */
async function contactNames(
  supabase: Client, tenantId: string, customerIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < customerIds.length; i += 100) {
    const { data } = await supabase
      .from("customer_contacts")
      .select("customer_id, name")
      .eq("tenant_id", tenantId)
      .in("customer_id", customerIds.slice(i, i + 100))
      .is("deleted_at", null).is("archived_at", null)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .returns<Array<{ customer_id: string; name: string | null }>>();
    for (const row of data ?? []) {
      const name = row.name?.trim();
      if (name && !names.has(row.customer_id)) names.set(row.customer_id, name);
    }
  }
  return names;
}

/** Every customer with something open, for the bulk screen and the monthly run. */
export async function loadStatementList(
  supabase: Client, tenantId: string, options: StatementOptions = {},
): Promise<StatementSummary[]> {
  const asAt = options.asAt ?? businessToday();
  const { trustedFrom } = await trustedFromFor(supabase, tenantId);

  type Row = InvoiceRow & {
    customers: {
      business_name: string; customer_number: string; billing_email: string | null;
      phone: string | null; reminders_enabled: boolean | null;
    } | null;
  };
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await supabase
      .from("invoices")
      .select(`${INVOICE_COLUMNS}, customers(business_name, customer_number, billing_email, phone, reminders_enabled)`)
      .eq("tenant_id", tenantId)
      .in("status", [...OPEN_INVOICE_STATUSES]).is("deleted_at", null)
      // RLS hides an archived invoice; the monthly run reads on the service-role
      // client, which RLS does not filter, so the archive is named here too.
      .is("archived_at", null)
      .order("id")
      .range(from, from + PAGE - 1)
      .returns<Row[]>();
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  const byCustomer = new Map<string, Row[]>();
  for (const row of rows) byCustomer.set(row.customer_id, [...(byCustomer.get(row.customer_id) ?? []), row]);

  const summaries = [...byCustomer.entries()]
    .map(([customerId, invoices]) => ({
      customerId,
      name: invoices[0]?.customers?.business_name ?? "Unknown customer",
      customerNumber: invoices[0]?.customers?.customer_number ?? "",
      billingEmail: invoices[0]?.customers?.billing_email ?? null,
      phone: invoices[0]?.customers?.phone ?? null,
      contactName: null as string | null,
      remindersEnabled: invoices[0]?.customers?.reminders_enabled ?? null,
      statement: buildStatement(invoices, { asAt, trustedFrom, upToAsAt: options.upToAsAt }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Contacts only for customers who will be listed: the rest are never shown.
  const listed = summaries.filter((row) => statementHasContent(row.statement));
  const names = await contactNames(supabase, tenantId, listed.map((row) => row.customerId));
  for (const row of summaries) row.contactName = names.get(row.customerId) ?? null;
  return summaries;
}

/** One send's result, with the address it went to when it went. */
export type StatementSendResult = StatementOutcome & { recipient?: string; providerId?: string };

/**
 * Render and email one customer's statement, writing nothing. The caller audits:
 * a person's send goes through `recordAudit` with their session, and the monthly
 * run, which has no session, writes its own row with a null actor.
 */
export async function deliverStatement(
  supabase: Client, tenantId: string, customerId: string,
  options: StatementOptions & { recipient?: string | null } = {},
): Promise<StatementSendResult & { total?: number; invoices?: number; excluded?: number }> {
  const data = await loadStatement(supabase, tenantId, customerId, options);
  if (!data) return { kind: "failed", customer: "A customer", reason: "that customer could not be found" };

  const customer = data.customer.business_name;
  if (!statementHasContent(data.statement)) return { kind: "skipped", customer, reason: "nothing_owed" };
  const recipient = options.recipient?.trim() || data.customer.billing_email?.trim();
  if (!recipient) return { kind: "skipped", customer, reason: "no_email" };

  const pdf = await renderStatementPdf(data);
  const { subject, html, text } = buildStatementEmail(data);
  const result = await sendEmail({
    to: recipient, subject, html, text,
    attachments: [{
      filename: statementFileName(data.customer.customer_number, data.statement.asAt), content: pdf,
    }],
  });
  const facts = {
    recipient, total: data.statement.total, invoices: data.statement.rows.length,
    excluded: data.statement.excluded.count,
  };
  if (!result.ok) return { kind: "failed", customer, reason: result.error, ...facts };
  return { kind: "sent", customer, providerId: result.id, ...facts };
}

/** A person sends a statement: delivered, then audited under their name. */
export async function sendStatement(
  supabase: Client, session: Session, customerId: string,
  options: StatementOptions & { recipient?: string | null } = {},
): Promise<StatementSendResult> {
  const result = await deliverStatement(supabase, session.tenantId, customerId, options);
  // A skip sent nothing and is not an event worth a row; an attempt is, either way.
  if (result.kind === "failed" && result.recipient) {
    await recordAudit(session, {
      entity: "customer", entityId: customerId, action: "send_failed",
      summary: `statement to ${result.recipient}: ${result.reason}`,
    });
  }
  if (result.kind === "sent") {
    await recordAudit(session, {
      entity: "customer", entityId: customerId, action: "send",
      summary: `statement sent to ${result.recipient}`,
      metadata: {
        providerId: result.providerId, total: result.total, invoices: result.invoices,
        excluded: result.excluded, asAt: options.asAt ?? null,
      },
    });
  }
  return result;
}
