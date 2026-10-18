/**
 * Everything an invoice PDF or email needs, in one RLS-bound read (spec §7.14).
 *
 * Shared by the PDF route and the email action so a customer can never be shown
 * one set of numbers and sent another. Uses the RLS-bound client, so an invoice
 * belonging to another tenant simply does not resolve.
 *
 * Server-only: reaches for the request's cookies.
 */

import { createClient } from "@/lib/supabase/server";
import type { ChargeType } from "@/lib/domain/pricing";
import { loadInvoiceBreakdown, type InvoiceBreakdown } from "@/lib/invoices/breakdown";
import { parseInvoiceProfile, type InvoiceProfile } from "@/lib/domain/invoice-profile";
import { loadTenantLogo, type PdfLogo } from "./logo";

export type InvoicePdfLine = {
  description: string;
  /**
   * The GL account this line is coded to, as it stood when the line was written.
   * Null on a free-text line, which prints as a blank rather than a dash: the
   * customer reading this invoice is not the person who needs the code.
   */
  account_code?: string | null;
  charge_type: ChargeType;
  quantity: number;
  unit_price: number;
  amount: number;
  taxable: boolean;
  /** `job`, `contract` or `manual` (0040) — decides whether the item's name prints (`pdfLineCells`). */
  origin?: string | null;
  /** `GST`, `FRE` or `N-T` (0043), printed in the Tax column. */
  tax_code?: string | null;
  /** The item this line names, if any — its code is the Item ID column (brief 1.10). */
  item_code?: string | null;
  item_name?: string | null;
};

export type InvoicePdfData = {
  tenant: {
    name: string; abn: string | null; gstRate: number; profile: InvoiceProfile;
    /** The laundry's logo, embedded at render time (0054). Null prints none. */
    logo?: PdfLogo | null;
  };
  customer: {
    business_name: string;
    customer_number: string;
    abn: string | null;
    billing_email: string | null;
    address: string[];
    /** The contact the invoice is addressed to, in italics above the business (MYOB's layout). */
    contact_name?: string | null;
  };
  invoice: {
    id: string;
    invoice_number: string;
    invoice_type: string;
    status: string;
    issue_date: string;
    due_date: string | null;
    period_start: string | null;
    period_end: string | null;
    purchase_order_number: string | null;
    payment_terms_days: number;
    subtotal: number;
    tax_amount: number;
    total: number;
    amount_paid: number;
    amount_credited: number;
    balance: number;
    currency: string;
    notes: string | null;
  };
  lines: InvoicePdfLine[];
  /**
   * The per-job detail behind a consolidated invoice, or empty.
   *
   * On the page the lines are rolled up per item, so a customer holding ten
   * jobs' worth of towels reads one line. This is the audit trail that has to
   * travel with it — otherwise the emailed PDF is the one copy of the invoice
   * that cannot answer "which day were those 1,450 towels?".
   */
  breakdown: InvoiceBreakdown;
};

export async function loadInvoiceForPdf(
  invoiceId: string,
  tenantId: string,
): Promise<InvoicePdfData | null> {
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, customer_id, invoice_number, invoice_type, status, issue_date, due_date, period_start, period_end, " +
            "purchase_order_number, payment_terms_days, subtotal, tax_amount, total, " +
            "amount_paid, amount_credited, balance, currency, notes, " +
            "customers(business_name, customer_number, abn, billing_email, " +
            "billing_address_line1, billing_address_line2, billing_suburb, billing_state, " +
            "billing_postcode)")
    .eq("id", invoiceId)
    .maybeSingle<InvoicePdfData["invoice"] & {
      customer_id: string;
      customers: {
        business_name: string; customer_number: string; abn: string | null;
        billing_email: string | null; billing_address_line1: string | null;
        billing_address_line2: string | null; billing_suburb: string | null;
        billing_state: string | null; billing_postcode: string | null;
      } | null;
    }>();

  if (!invoice) return null;

  const [{ data: lineRows }, { data: tenant }, contactName] = await Promise.all([
    supabase
      .from("invoice_lines")
      // The item is embedded for its code and name, which are the Item ID and
      // the Description the MYOB layout prints (brief 1.10). Unambiguous:
      // `invoice_lines` has exactly one FK to `items` (§20).
      .select("description, charge_type, quantity, unit_price, amount, taxable, account_code, " +
              "origin, tax_code, items(item_code, name)")
      .eq("invoice_id", invoiceId)
      .order("sequence")
      .returns<Array<Omit<InvoicePdfLine, "item_code" | "item_name"> & {
        items: { item_code: string | null; name: string | null }
          | Array<{ item_code: string | null; name: string | null }> | null;
      }>>(),
    supabase
      .from("tenants")
      .select("name, abn, gst_rate, settings")
      .eq("id", tenantId)
      .maybeSingle<{ name: string; abn: string | null; gst_rate: number; settings: unknown }>(),
    loadContactName(supabase, tenantId, invoice.customer_id),
  ]);

  const c = invoice.customers;
  const profile = parseInvoiceProfile(tenant?.settings);
  const lines: InvoicePdfLine[] = (lineRows ?? []).map(({ items, ...line }) => {
    const item = Array.isArray(items) ? items[0] ?? null : items;
    return { ...line, item_code: item?.item_code ?? null, item_name: item?.name ?? null };
  });

  return {
    tenant: {
      name: tenant?.name ?? "Laundry",
      abn: tenant?.abn ?? null,
      gstRate: Number(tenant?.gst_rate ?? 0.1),
      profile,
      logo: await loadTenantLogo(supabase, tenantId, profile.logoPath),
    },
    customer: {
      business_name: c?.business_name ?? "Unknown customer",
      customer_number: c?.customer_number ?? "",
      abn: c?.abn ?? null,
      billing_email: c?.billing_email ?? null,
      address: [
        c?.billing_address_line1,
        c?.billing_address_line2,
        [c?.billing_suburb, c?.billing_state, c?.billing_postcode].filter(Boolean).join(" "),
      ].filter((part): part is string => Boolean(part && part.trim())),
      contact_name: contactName,
    },
    invoice,
    lines,
    breakdown: await loadInvoiceBreakdown(supabase, tenantId, invoiceId),
  };
}

/**
 * The person an invoice is addressed to — the customer's primary contact, or
 * their first, or nobody. Read through `can_read_customers()` (0048); a role
 * that cannot read contacts simply prints no name, never an error.
 */
export async function loadContactName(
  supabase: Awaited<ReturnType<typeof createClient>>, tenantId: string, customerId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("customer_contacts")
    .select("name")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .returns<Array<{ name: string | null }>>();
  const name = data?.[0]?.name?.trim();
  return name ? name : null;
}
