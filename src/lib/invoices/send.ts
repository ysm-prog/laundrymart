import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { describeDbError } from "@/lib/actions";
import { loadInvoiceForPdf } from "@/lib/pdf/invoice-data";
import { invoiceFileName, renderInvoicePdf } from "@/lib/pdf/render";
import { buildInvoiceEmail } from "@/lib/email/invoice-email";
import { sendEmail } from "@/lib/email/send";
import { logOrderActivity } from "@/lib/orders/activity";
import { settledStatus } from "@/lib/domain/payment-gate";

/**
 * Emailing one invoice, with the PDF attached — the single implementation.
 *
 * Shared by the single Send button and the bulk Send Selected, for the same
 * reason `lib/orders/complete.ts` is shared: two implementations of "put this
 * in front of a customer" eventually differ, and the customer is who finds out.
 *
 * **Generating never sends, and sending is what moves the jobs on.** An invoice
 * arrives here as a draft or an issued document; only when the email actually
 * leaves does every job on it move to `invoice_sent`. That ordering is the
 * whole of phase 5 — a job must never read as "sent" because somebody pressed
 * generate.
 *
 * Two rules the customer's inbox depends on, unchanged from `emailInvoice`:
 * a draft is never sent, because draft lines can still change; and the address
 * it actually went to is stamped on the invoice rather than inferred later from
 * a customer record that can move.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type SendResult =
  | { ok: true; invoiceNumber: string; recipient: string }
  | { ok: false; invoiceNumber: string | null; error: string };

export async function sendInvoice(
  supabase: Client,
  session: Session,
  invoiceId: string,
  overrideRecipient?: string | null,
): Promise<SendResult> {
  const data = await loadInvoiceForPdf(invoiceId, session.tenantId);
  if (!data) return { ok: false, invoiceNumber: null, error: "that invoice could not be found" };

  const invoiceNumber = data.invoice.invoice_number;

  if (data.invoice.status === "draft") {
    return {
      ok: false, invoiceNumber,
      error: "issue it before emailing — a draft can still change",
    };
  }
  if (data.invoice.status === "void") {
    return { ok: false, invoiceNumber, error: "this invoice is void and cannot be sent" };
  }

  const recipient = overrideRecipient?.trim() || data.customer.billing_email;
  if (!recipient) return { ok: false, invoiceNumber, error: "this customer has no billing email" };

  const pdf = await renderInvoicePdf(data);
  const { subject, html, text } = buildInvoiceEmail(data);

  const result = await sendEmail({
    to: recipient,
    subject,
    html,
    text,
    attachments: [{ filename: invoiceFileName(invoiceNumber), content: pdf }],
  });

  if (!result.ok) {
    // Recorded even on failure: "we tried and it bounced" is exactly what
    // somebody needs when a customer says they never received it.
    await recordAudit(session, {
      entity: "invoice", entityId: invoiceId, action: "send_failed",
      summary: `${recipient}: ${result.error}`,
    });
    return { ok: false, invoiceNumber, error: result.error };
  }

  const { error } = await supabase
    .from("invoices")
    .update({ emailed_at: new Date().toISOString(), emailed_to: recipient })
    .eq("id", invoiceId).eq("tenant_id", session.tenantId);
  if (error) return { ok: false, invoiceNumber, error: describeDbError(error) };

  await recordAudit(session, {
    entity: "invoice", entityId: invoiceId, action: "send",
    summary: `sent to ${recipient}`,
    metadata: { providerId: result.id },
  });

  await advanceJobsToSent(supabase, session, invoiceId, invoiceNumber);

  return { ok: true, invoiceNumber, recipient };
}

/**
 * Move every job on this invoice to `invoice_sent`.
 *
 * Filtered to `invoice_generated` so a job already marked paid is never dragged
 * backwards — the billing guard would refuse that anyway, and refusing here
 * means one job's state cannot take the whole statement, and the other jobs on
 * the invoice, down with it.
 *
 * A failure here does not fail the send: the email has gone, and reporting a
 * failure would invite somebody to send it a second time. The mismatch is
 * visible on the job page and is corrected by re-sending or by hand — which is
 * a far better outcome than a customer receiving two copies.
 */
async function advanceJobsToSent(
  supabase: Client, session: Session, invoiceId: string, invoiceNumber: string,
): Promise<void> {
  const { data: sources } = await supabase
    .from("invoice_source_jobs")
    .select("order_id")
    .eq("invoice_id", invoiceId)
    .returns<Array<{ order_id: string }>>();

  const jobIds = (sources ?? []).map((row) => row.order_id);
  if (jobIds.length === 0) return;

  const { error } = await supabase
    .from("laundry_orders")
    .update({ billing_status: "invoice_sent" })
    .in("id", jobIds)
    .eq("tenant_id", session.tenantId)
    .eq("billing_status", "invoice_generated");
  if (error) return;

  for (const jobId of jobIds) {
    await logOrderActivity(supabase, session, jobId, {
      activity_type: "status_changed",
      previous: { billing_status: "invoice_generated" },
      next: { billing_status: "invoice_sent", invoice: invoiceNumber },
    });
  }
}

/**
 * Mark every job on an invoice as paid, once the invoice itself is.
 *
 * Called from `recordPayment` when a payment settles the balance. Same
 * defensive filter as above: only jobs actually sitting on an invoice state
 * move, so a job somebody has already reconciled by hand is left alone.
 */
export async function markInvoiceJobsPaid(
  supabase: Client, session: Session, invoiceId: string,
): Promise<void> {
  const { data: sources } = await supabase
    .from("invoice_source_jobs")
    .select("order_id")
    .eq("invoice_id", invoiceId)
    .returns<Array<{ order_id: string }>>();

  const jobIds = (sources ?? []).map((row) => row.order_id);
  if (jobIds.length === 0) return;

  await supabase
    .from("laundry_orders")
    .update({ billing_status: "paid" })
    .in("id", jobIds)
    .eq("tenant_id", session.tenantId)
    .in("billing_status", ["invoice_generated", "invoice_sent"]);
}

/**
 * Release every job on an invoice back to `approved`, when the invoice is voided.
 *
 * Voiding is how a wrong invoice is undone, and the work still has to be
 * billable afterwards — which is precisely why `uq_invoice_source_jobs_once` is
 * enforced on the link rows rather than on the job. Deleting the link rows is
 * what frees the jobs for a later generation run.
 *
 * The jobs go back to `approved`, not to `awaiting_review`: their charges were
 * signed off and are still frozen, and it was the invoice that was wrong. If
 * the *price* was wrong, the reviewer sends the job back explicitly.
 */
export type ReleaseOutcome =
  | { ok: true; released: number }
  | { ok: false; error: string; released: number };

export async function releaseVoidedInvoiceJobs(
  supabase: Client, session: Session, invoiceId: string,
): Promise<ReleaseOutcome> {
  const { data: sources, error: readError } = await supabase
    .from("invoice_source_jobs")
    .select("order_id")
    .eq("invoice_id", invoiceId)
    .returns<Array<{ order_id: string }>>();
  if (readError) return { ok: false, error: describeDbError(readError), released: 0 };

  const jobIds = (sources ?? []).map((row) => row.order_id);
  if (jobIds.length === 0) return { ok: true, released: 0 };

  // **Order matters, and the guard is what makes it matter.** 0017 permits
  // `invoice_generated → approved` only when no `invoice_source_jobs` row
  // references the job — so the links must come out first, and if this delete
  // fails the status update below is refused by the trigger rather than
  // quietly freeing work that is still on an outstanding invoice.
  const { error: unlinkError } = await supabase
    .from("invoice_source_jobs")
    .delete()
    .eq("invoice_id", invoiceId)
    .eq("tenant_id", session.tenantId);
  if (unlinkError) return { ok: false, error: describeDbError(unlinkError), released: 0 };

  const { data: moved, error: moveError } = await supabase
    .from("laundry_orders")
    .update({ billing_status: "approved" })
    .in("id", jobIds)
    .eq("tenant_id", session.tenantId)
    .in("billing_status", ["invoice_generated", "invoice_sent"])
    .select("id");
  if (moveError) return { ok: false, error: describeDbError(moveError), released: 0 };

  // A job that did not move is stranded in a state the void did not undo (a
  // `paid` job is the case the 12 October test found). Said, never hidden: the
  // toast used to claim every job was back in the queue regardless.
  const released = moved?.length ?? 0;
  if (released < jobIds.length) {
    return {
      ok: false, released,
      error: `${jobIds.length - released} of ${jobIds.length} jobs on it could not be put back in the billing queue — check their billing status.`,
    };
  }
  return { ok: true, released };
}

/**
 * Re-derive an issued invoice's status from its paid and credited figures, and
 * carry the jobs on it with it: settled → their jobs are paid; no longer settled
 * (a reversed payment) → their jobs go back to `invoice_sent` (0052's one way
 * back off `paid`). Shared by payments, credit notes and reversals so the three
 * cannot disagree about when an invoice is paid.
 */
export async function resettleInvoice(
  supabase: Client, session: Session, invoiceId: string,
): Promise<{ status: string; paid: boolean } | null> {
  const { data: row } = await supabase
    .from("invoices").select("status, total, amount_paid, amount_credited")
    .eq("id", invoiceId).eq("tenant_id", session.tenantId)
    .maybeSingle<{ status: string; total: number; amount_paid: number; amount_credited: number }>();
  if (!row) return null;

  const next = settledStatus({
    status: row.status, total: Number(row.total),
    amountPaid: Number(row.amount_paid), amountCredited: Number(row.amount_credited ?? 0),
  });
  if (next.status !== row.status) {
    await supabase.from("invoices")
      .update({ status: next.status, paid_at: next.paid ? new Date().toISOString() : null })
      .eq("id", invoiceId).eq("tenant_id", session.tenantId);
  }
  if (next.paid) {
    await markInvoiceJobsPaid(supabase, session, invoiceId);
  } else if (row.status === "paid") {
    const { data: sources } = await supabase
      .from("invoice_source_jobs").select("order_id").eq("invoice_id", invoiceId)
      .returns<Array<{ order_id: string }>>();
    const jobIds = (sources ?? []).map((s) => s.order_id);
    if (jobIds.length > 0) {
      await supabase.from("laundry_orders").update({ billing_status: "invoice_sent" })
        .in("id", jobIds).eq("tenant_id", session.tenantId).eq("billing_status", "paid");
    }
  }
  return next;
}
