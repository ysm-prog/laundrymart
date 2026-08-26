"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { done, fail, firstIssue, requiredDate, toObject } from "@/lib/actions";
import { recordAudit } from "@/lib/audit";
import { businessToday } from "@/lib/domain/timezone";
import { generateInvoicesForJobs } from "@/lib/invoices/from-jobs";
import { customerPeriodDetail } from "@/lib/invoices/period";

/**
 * Raising one invoice for one customer's billing period.
 *
 * The whole point of the screen in front of this: the customer had ten jobs in
 * August and receives **one** invoice covering all of them, with the items
 * rolled up and the per-job breakdown underneath.
 *
 * The jobs are re-read here rather than posted from the browser. A form that
 * carried its own job ids would let a stale page bill work that has since been
 * invoiced, cancelled or unapproved — and the period is the thing the person
 * actually chose, so the period is what gets sent. The database refuses a
 * double-bill regardless (`uq_invoice_source_jobs_once`), but a refusal is a
 * worse answer than never asking.
 */

const schema = z.object({
  customer_id: z.uuid(),
  period_start: requiredDate,
  period_end: requiredDate,
});

export async function generateCustomerPeriodInvoice(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = schema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/billing", firstIssue(parsed.error));

  const { customer_id: customerId, period_start: start, period_end: end } = parsed.data;
  if (start > end) return fail("/billing", "The period start must be on or before the period end.");

  const back = `/billing/${customerId}?from=${start}&to=${end}`;
  const supabase = await createClient();

  const detail = await customerPeriodDetail(supabase, session.tenantId, customerId, { start, end });
  if (!detail) {
    return fail("/billing", "That customer is not in this laundry. Switch laundry in the account menu.");
  }

  if (detail.billableJobIds.length === 0) {
    // Naming *why* there is nothing rather than saying "nothing to invoice",
    // which reads as "it is all billed" when in fact it is all unreviewed.
    const reason = detail.awaitingReview > 0
      ? `${detail.awaitingReview} job(s) in this period still need pricing and approving.`
      : detail.invoicedCount > 0
        ? "Every job in this period is already on an invoice."
        : "There are no completed jobs in this period.";
    return fail(back, `Nothing to invoice for ${detail.businessName}. ${reason}`, {
      href: "/invoices/awaiting", label: "Awaiting invoice",
    });
  }

  const result = await generateInvoicesForJobs(
    supabase, session, detail.billableJobIds,
    // Not `respectManual`: choosing this customer and pressing the button *is*
    // the explicit decision a `manual` billing method is asking for.
    { issueDate: businessToday(), period: { start, end } },
  );

  if (result.created.length === 0) {
    const why = result.skipped[0]?.reason ?? "no charges on the approved jobs";
    return fail(back, `No invoice was raised for ${detail.businessName} — ${why}.`);
  }

  const invoice = result.created[0]!;
  await recordAudit(session, {
    action: "generate",
    entity: "invoices",
    entityId: invoice.invoiceId,
    summary: `${invoice.invoiceNumber} for ${detail.businessName}, ${start} to ${end}`,
    metadata: {
      customer_id: customerId, period_start: start, period_end: end,
      jobs: invoice.jobIds.length, total: invoice.total,
    },
  });

  revalidatePath("/billing");
  revalidatePath("/invoices");

  const skipped = result.skipped.length > 0 ? ` ${result.skipped.length} job(s) were skipped.` : "";
  // **Raised or added to** — since the running draft landed, the second is the
  // common answer here: the month's approvals have usually opened the customer's
  // invoice for this window already, and this button puts whatever is left onto
  // it. Reporting "raised" either way would tell somebody a new document exists
  // when it does not.
  const verb = invoice.opened ? "raised for" : "updated for";
  return done(
    back,
    `${invoice.invoiceNumber} ${verb} ${detail.businessName} — `
    + `${invoice.jobIds.length} job(s) added, ${new Intl.NumberFormat("en-AU", {
      style: "currency", currency: "AUD",
    }).format(invoice.total)} on it now.${skipped}`,
    { href: `/invoices/${invoice.invoiceId}`, label: "Open the invoice" },
  );
}
