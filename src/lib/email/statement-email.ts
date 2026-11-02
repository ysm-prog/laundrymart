/**
 * The statement email. Pure, like `invoice-email.ts`: data in, subject and body
 * out, so the wording and the escaping can be tested without a provider.
 */

import { formatMoney } from "@/lib/domain/pricing";
import { longDate } from "@/lib/pdf/line-display";
import type { StatementPdfData } from "@/lib/pdf/statement-document";
import {
  emailShell, mutedParagraph, paragraph, summary, withTextCredit,
} from "@/lib/email/layout";

export function buildStatementEmail(data: StatementPdfData) {
  const { tenant, customer, statement } = data;
  const total = formatMoney(statement.total, "AUD");
  const overdue = formatMoney(statement.overdue, "AUD");
  const asAt = longDate(statement.asAt);
  const isOverdue = statement.overdue > 0;

  const subject = `${tenant.name} — statement at ${asAt} (${total})`;
  const closing = "Reply to this email if anything looks wrong and we will sort it out.";

  const text = [
    `Hello ${customer.business_name},`,
    "",
    `Please find attached your statement from ${tenant.name} as at ${asAt}.`,
    "",
    `Amount due: ${total}`,
    isOverdue ? `Overdue: ${overdue}` : "",
    "",
    closing,
    "",
    tenant.name,
    tenant.abn ? `ABN ${tenant.abn}` : "",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");

  const html = emailShell({
    audience: "customer",
    brandName: tenant.name,
    eyebrow: `Statement at ${asAt}`,
    preview: `${total} due. The PDF is attached.`,
    body: [
      paragraph(`Hello ${customer.business_name}, your statement as at ${asAt} is attached as a PDF.`),
      summary([
        { label: "Amount due", value: total },
        ...(isOverdue ? [{ label: "Overdue", value: overdue }] : []),
      ]),
      mutedParagraph(closing),
    ].join("\n"),
    footNote: tenant.abn ? `${tenant.name} · ABN ${tenant.abn}` : tenant.name,
  });

  return { subject, html, text: withTextCredit("customer", text) };
}
