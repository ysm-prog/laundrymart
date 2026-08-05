/**
 * The invoice email itself (spec §7.14, §18).
 *
 * A pure function: data in, subject and body out, no provider and no network.
 * That keeps it unit-testable, and it keeps the thing most likely to be wrong —
 * the wording and the escaping — out of the code path that needs an API key to
 * exercise.
 *
 * Hand-written HTML rather than a component library. It is one transactional
 * template, and mail clients want table-free, inline-styled markup anyway; a
 * renderer would add a dependency to produce roughly this.
 */

import { formatMoney } from "@/lib/domain/pricing";
import type { InvoicePdfData } from "@/lib/pdf/invoice-data";

/** Customer and tenant names are user input and go straight into markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
  ].filter((paragraph) => paragraph !== "").join("\n");

  const row = (label: string, value: string) => `
      <tr>
        <td style="padding:4px 0;color:#6b7280;">${escapeHtml(label)}</td>
        <td style="padding:4px 0;text-align:right;font-weight:600;">${escapeHtml(value)}</td>
      </tr>`;

  const html = `<!doctype html>
<html lang="en-AU">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px;">
      <h1 style="margin:0 0 4px;font-size:18px;">${escapeHtml(tenant.name)}</h1>
      <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">
        Invoice ${escapeHtml(invoice.invoice_number)}
      </p>

      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
        Hello ${escapeHtml(customer.business_name)}, your invoice ${escapeHtml(period.trim())}
        is attached as a PDF.
      </p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
        ${row("Total", total)}
        ${outstanding ? row("Amount due", balance) + row("Due date", due) : ""}
        ${invoice.purchase_order_number ? row("Your PO", invoice.purchase_order_number) : ""}
      </table>

      ${outstanding
        ? ""
        : `<p style="margin:0 0 12px;font-size:14px;color:#047857;">
             This invoice is paid in full — no action needed.
           </p>`}

      <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
        Reply to this email if anything looks wrong and we will sort it out.
      </p>

      <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">
        ${escapeHtml(tenant.name)}${tenant.abn ? ` · ABN ${escapeHtml(tenant.abn)}` : ""}
      </p>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}
