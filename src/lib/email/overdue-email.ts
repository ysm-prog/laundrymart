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

import {
  emailShell, mutedParagraph, paragraph, summary, withTextCredit,
} from "@/lib/email/layout";
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

  const html = emailShell({
    audience: "customer",
    brandName: data.tenantName,
    eyebrow: `Invoice ${data.invoiceNumber}`,
    // A chase is read in the inbox list more often than it is opened, so the
    // preview carries the two facts that decide whether to open it.
    preview: `${amount} outstanding, due ${due}.`,
    body: [
      paragraph(`Hello ${data.customerName}, ${lead}`),
      summary([
        { label: "Amount outstanding", value: amount },
        { label: "Due", value: `${due} (${data.daysOverdue} days ago)` },
      ]),
      mutedParagraph(
        "If it is already on its way, thank you — please ignore this. If you need the "
        + "invoice sent again, or something about it does not look right, just reply to "
        + "this email and we will sort it out.",
      ),
    ].join("\n"),
    footNote: data.tenantName,
  });

  return { subject, html, text: withTextCredit("customer", text) };
}
