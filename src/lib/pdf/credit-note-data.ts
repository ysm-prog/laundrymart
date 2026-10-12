/** One RLS-bound read of everything a credit-note PDF needs. Server-only. */

import { createClient } from "@/lib/supabase/server";
import { parseInvoiceProfile, type InvoiceProfile } from "@/lib/domain/invoice-profile";

export type CreditNotePdfData = {
  tenant: { name: string; abn: string | null; profile: InvoiceProfile };
  customer: { business_name: string; customer_number: string; abn: string | null; address: string[] };
  note: {
    credit_note_number: string; status: string; issue_date: string; reason: string | null;
    subtotal: number; tax_amount: number; total: number; invoice_number: string;
  };
  lines: Array<{ description: string; quantity: number; unit_price: number; amount: number; taxable: boolean }>;
};

export async function loadCreditNoteForPdf(id: string, tenantId: string): Promise<CreditNotePdfData | null> {
  const supabase = await createClient();
  const { data: note } = await supabase
    .from("credit_notes")
    .select("credit_note_number, status, issue_date, reason, subtotal, tax_amount, total, " +
            "invoices(invoice_number), customers(business_name, customer_number, abn, " +
            "billing_address_line1, billing_address_line2, billing_suburb, billing_state, billing_postcode)")
    .eq("id", id).eq("tenant_id", tenantId)
    .maybeSingle<{
      credit_note_number: string; status: string; issue_date: string; reason: string | null;
      subtotal: number; tax_amount: number; total: number;
      invoices: { invoice_number: string } | null;
      customers: {
        business_name: string; customer_number: string; abn: string | null;
        billing_address_line1: string | null; billing_address_line2: string | null;
        billing_suburb: string | null; billing_state: string | null; billing_postcode: string | null;
      } | null;
    }>();
  if (!note) return null;

  const [{ data: lines }, { data: tenant }] = await Promise.all([
    supabase.from("credit_note_lines")
      .select("description, quantity, unit_price, amount, taxable")
      .eq("credit_note_id", id).eq("tenant_id", tenantId)
      .returns<CreditNotePdfData["lines"]>(),
    supabase.from("tenants").select("name, abn, settings").eq("id", tenantId)
      .maybeSingle<{ name: string; abn: string | null; settings: unknown }>(),
  ]);
  const c = note.customers;
  return {
    tenant: { name: tenant?.name ?? "Laundry", abn: tenant?.abn ?? null,
              profile: parseInvoiceProfile(tenant?.settings) },
    customer: {
      business_name: c?.business_name ?? "Unknown customer",
      customer_number: c?.customer_number ?? "",
      abn: c?.abn ?? null,
      address: [c?.billing_address_line1, c?.billing_address_line2,
        [c?.billing_suburb, c?.billing_state, c?.billing_postcode].filter(Boolean).join(" ")]
        .filter((part): part is string => Boolean(part && part.trim())),
    },
    note: { ...note, invoice_number: note.invoices?.invoice_number ?? "" },
    lines: lines ?? [],
  };
}

