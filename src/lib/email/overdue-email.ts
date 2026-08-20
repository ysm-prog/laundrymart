/**
 * The overdue-invoice reminder (roadmap C3).
 *
 * Pure, like the other two templates. The tone is the owner's decision, taken
 * 2026-08-05: **friendly** — it assumes the invoice was overlooked rather than
 * withheld, names no consequence and makes no threat. First chase at 7 days past
 * terms, repeating weekly to a maximum of three; after that the bell keeps
 * flagging it and a human picks up the phone.
 *
 * The reminder carries no PDF. The invoice itself was already emailed with one
 * attached, and re-attaching it on every chase turns a nudge into a re-issue —
 * so this points at the invoice by number and offers to send it again. It also
 * carries no payment link, because nothing in the schema holds one; inventing a
 * "Pay now" button that goes nowhere would be worse than the plain ask.
 */

import { escapeHtml } from "@/lib/email/invoice-email";
import { formatMoney } from "@/lib/domain/pricing";

export type OverdueEmailData = {
  tenantName: string;
  customerName: string;
  invoiceNumber: string;
  /** Outstanding balance in the invoice's own currency. */
  balance: number;
  currency: string;
  /** `YYYY-MM-DD`. */
  dueDate: string;
  daysOverdue: number;
  /** 1 for the first chase. Used only to soften or firm the opening line. */
  sequence: number;
};

export type OverdueEmail = { subject: string; html: string; text: string };

function auDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

/**
 * Even on the third pass the voice stays friendly — it just stops implying the
 * customer has not seen it yet, which would read as careless by then.
 */
function opening(sequence: number, invoiceNumber: string, due: string): string {
  if (sequence <= 1) {
    return `Invoice ${invoiceNumber} was due on ${due} and is still showing as unpaid on our side`
      + " — we know these things slip through, so this is just a nudge.";
  }
  return `We are still showing invoice ${invoiceNumber} as unpaid; it was due on ${due}.`;
}

export function buildOverdueEmail(data: OverdueEmailData): OverdueEmail {
  const amount = formatMoney(data.balance, data.currency || "AUD");
  const due = auDate(data.dueDate);
  const lead = opening(data.sequence, data.invoiceNumber, due);

  const subject = `${data.tenantName} — a reminder about invoice ${data.invoiceNumber} (${amount})`;

  const text = [
    `Hello ${data.customerName},`,
    "",
    lead,
    "",
    `Invoice: ${data.invoiceNumber}`,
    `Amount outstanding: ${amount}`,
    `Due: ${due} (${data.daysOverdue} days ago)`,
    "",
    "If it is already on its way, thank you — please ignore this.",
    "If you need the invoice sent again, or something about it does not look right,",
    "just reply to this email and we will sort it out.",
    "",
    data.tenantName,
  ].join("\n");

  const row = (label: string, value: string) => `
      <tr>
        <td style="padding:4px 0;color:#6b7280;">${escapeHtml(label)}</td>
        <td style="padding:4px 0;text-align:right;font-weight:600;">${escapeHtml(value)}</td>
      </tr>`;

  const html = `<!doctype html>
<html lang="en-AU">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px;">
      <h1 style="margin:0 0 4px;font-size:18px;">${escapeHtml(data.tenantName)}</h1>
      <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">
        Invoice ${escapeHtml(data.invoiceNumber)}
      </p>

      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
        Hello ${escapeHtml(data.customerName)}, ${escapeHtml(lead)}
      </p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
        ${row("Amount outstanding", amount)}
        ${row("Due", `${due} (${data.daysOverdue} days ago)`)}
      </table>

      <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
        If it is already on its way, thank you — please ignore this. If you need the
        invoice sent again, or something about it does not look right, just reply to
        this email and we will sort it out.
      </p>

      <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">${escapeHtml(data.tenantName)}</p>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}
