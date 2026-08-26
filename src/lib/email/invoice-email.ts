/**
 * The invoice email itself (spec §7.14, §18).
 *
 * A pure function: data in, subject and body out, no provider and no network.
 * That keeps it unit-testable, and it keeps the thing most likely to be wrong —
 * the wording and the escaping — out of the code path that needs an API key to
 * exercise.
 *
 * The chrome comes from `layout.ts` (YSM Hub's palette, the Core IT credit),
 * so this file holds the *wording and the money* and nothing about colour. It
 * used to carry its own `<!doctype html>` and its own greys, which is how four
 * templates ended up four different shades of not-the-brand.
 *
 * **Customer-facing**, so the credit goes on it.
 */

import { formatMoney } from "@/lib/domain/pricing";
import type { InvoicePdfData } from "@/lib/pdf/invoice-data";
import {
  emailShell, escapeHtml, notice, paragraph, mutedParagraph, summary, withTextCredit,
} from "@/lib/email/layout";

// `escapeHtml` moved to `layout.ts` — it is shell-level, not invoice-level, and
// three of the four templates were importing it *from here*, which made this
// file look like the owner of something it merely happened to define first.
export { escapeHtml };

function auDate(value: string | null): string {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

export type InvoiceEmail = { subject: string; html: string; text: string };

export function buildInvoiceEmail(data: InvoicePdfData): InvoiceEmail {
  const { tenant, customer, invoice } = data;
  const currency = invoice.currency || "AUD";
  const total = formatMoney(Number(invoice.total ?? 0), currency);
  const balance = formatMoney(Number(invoice.balance ?? 0), currency);
  const due = auDate(invoice.due_date);
  const outstanding = Number(invoice.balance ?? 0) > 0;

  const subject = `${tenant.name} — invoice ${invoice.invoice_number} (${total})`;

  const period = invoice.period_start
    ? `for the period ${auDate(invoice.period_start)} to ${auDate(invoice.period_end)} `
    : "";

  const text = [
    `Hello ${customer.business_name},`,
    "",
    `Please find attached invoice ${invoice.invoice_number} ${period}from ${tenant.name}.`,
    "",
    `Total: ${total}`,
    outstanding ? `Amount due: ${balance}` : "This invoice is paid in full — no action needed.",
    outstanding ? `Due date: ${due}` : "",
    invoice.purchase_order_number ? `Your PO: ${invoice.purchase_order_number}` : "",
    "",
    "Reply to this email if anything looks wrong and we will sort it out.",
    "",
    tenant.name,
    tenant.abn ? `ABN ${tenant.abn}` : "",
  ].filter((line) => line !== "").join("\n");

  const rows = [
    { label: "Total", value: total },
    ...(outstanding
      ? [{ label: "Amount due", value: balance }, { label: "Due date", value: due }]
      : []),
    ...(invoice.purchase_order_number
      ? [{ label: "Your PO", value: invoice.purchase_order_number }]
      : []),
  ];

  const html = emailShell({
    audience: "customer",
    brandName: tenant.name,
    eyebrow: `Invoice ${invoice.invoice_number}`,
    // What the inbox list shows beside the subject: the number is already in the
    // subject, so spend this on the thing the reader wants to know next.
    preview: outstanding
      ? `${balance} due ${due}. The PDF is attached.`
      : "Paid in full — no action needed. The PDF is attached.",
    body: [
      paragraph(
        `Hello ${customer.business_name}, your invoice ${period.trim()} is attached as a PDF.`
          .replace(/\s+/g, " "),
      ),
      summary(rows),
      outstanding ? "" : notice("ok", "This invoice is paid in full — no action needed."),
      mutedParagraph("Reply to this email if anything looks wrong and we will sort it out."),
    ].join("\n"),
    footNote: tenant.abn ? `${tenant.name} · ABN ${tenant.abn}` : tenant.name,
  });

  return { subject, html, text: withTextCredit("customer", text) };
}
