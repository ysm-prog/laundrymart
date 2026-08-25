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
};

export type InvoicePdfData = {
  tenant: { name: string; abn: string | null; gstRate: number };
  customer: {
    business_name: string;
    customer_number: string;
    abn: string | null;
    billing_email: string | null;
    address: string[];
  };
  invoice: {
    id: string;
    invoice_number: string;
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
    .select("id, invoice_number, status, issue_date, due_date, period_start, period_end, " +
            "purchase_order_number, payment_terms_days, subtotal, tax_amount, total, " +
            "amount_paid, balance, currency, notes, " +
            "customers(business_name, customer_number, abn, billing_email, " +
            "billing_address_line1, billing_address_line2, billing_suburb, billing_state, " +
            "billing_postcode)")
    .eq("id", invoiceId)
    .maybeSingle<InvoicePdfData["invoice"] & {
      customers: {
        business_name: string; customer_number: string; abn: string | null;
        billing_email: string | null; billing_address_line1: string | null;
        billing_address_line2: string | null; billing_suburb: string | null;
        billing_state: string | null; billing_postcode: string | null;
      } | null;
    }>();

  if (!invoice) return null;

  const [{ data: lines }, { data: tenant }] = await Promise.all([
    supabase
      .from("invoice_lines")
      .select("description, charge_type, quantity, unit_price, amount, taxable, account_code")
      .eq("invoice_id", invoiceId)
      .order("sequence")
      .returns<InvoicePdfLine[]>(),
    supabase
      .from("tenants")
      .select("name, abn, gst_rate")
      .eq("id", tenantId)
      .maybeSingle<{ name: string; abn: string | null; gst_rate: number }>(),
  ]);

  const c = invoice.customers;

  return {
    tenant: {
      name: tenant?.name ?? "Laundry",
      abn: tenant?.abn ?? null,
      gstRate: Number(tenant?.gst_rate ?? 0.1),
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
    },
    invoice,
    lines: lines ?? [],
    breakdown: await loadInvoiceBreakdown(supabase, tenantId, invoiceId),
  };
}
