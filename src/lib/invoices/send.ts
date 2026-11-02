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
import { buildInvoiceSms, displayMobile, normaliseMobile } from "@/lib/domain/sms";
import { formatMoney } from "@/lib/domain/pricing";
import { auDate } from "@/lib/pdf/line-display";
import { sendSms } from "@/lib/sms/send";
import { invoiceLink } from "@/lib/invoices/link";
import { requestOrigin } from "@/lib/auth/request-origin";

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
 * The first number on a customer's record that a text can reach: their own phone,
 * then their contacts', primary first. Most of these are landlines, which is why
 * each is tested rather than the first one taken.
 */
export async function loadCustomerMobile(
  supabase: Client, tenantId: string, customerId: string,
): Promise<string | null> {
  const [{ data: customer }, { data: contacts }] = await Promise.all([
    supabase.from("customers").select("phone")
      .eq("tenant_id", tenantId).eq("id", customerId)
      .maybeSingle<{ phone: string | null }>(),
    supabase.from("customer_contacts").select("phone")
      .eq("tenant_id", tenantId).eq("customer_id", customerId).is("deleted_at", null)
      .order("is_primary", { ascending: false })
      .returns<Array<{ phone: string | null }>>(),
  ]);
  for (const candidate of [customer?.phone, ...(contacts ?? []).map((row) => row.phone)]) {
    const mobile = normaliseMobile(candidate);
    if (mobile) return mobile;
  }
  return null;
}

/**
 * Text a customer the link to one invoice. The twin of `sendInvoice`, and held to
 * the same rules: a draft or a void is never sent, the number it went to is stamped
 * on the invoice, a failed attempt is recorded, and sending is what moves the jobs on.
 */
export async function sendInvoiceSms(
  supabase: Client,
  session: Session,
  invoiceId: string,
  overrideMobile?: string | null,
): Promise<SendResult> {
  const data = await loadInvoiceForPdf(invoiceId, session.tenantId);
  if (!data) return { ok: false, invoiceNumber: null, error: "that invoice could not be found" };

  const invoiceNumber = data.invoice.invoice_number;
  if (data.invoice.status === "draft") {
    return { ok: false, invoiceNumber, error: "issue it before sending — a draft can still change" };
  }
  if (data.invoice.status === "void") {
    return { ok: false, invoiceNumber, error: "this invoice is void and cannot be sent" };
  }

  const typed = overrideMobile?.trim();
  const { data: owner } = await supabase
    .from("invoices").select("customer_id")
    .eq("tenant_id", session.tenantId).eq("id", invoiceId)
    .maybeSingle<{ customer_id: string }>();
  const mobile = typed
    ? normaliseMobile(typed)
    : owner ? await loadCustomerMobile(supabase, session.tenantId, owner.customer_id) : null;
  if (!mobile) {
    return {
      ok: false, invoiceNumber,
      error: typed ? "that is not an Australian mobile number" : "this customer has no mobile number on file",
    };
  }

  const body = buildInvoiceSms({
    business: data.tenant.name,
    invoiceNumber,
    amount: formatMoney(Number(data.invoice.balance ?? 0), data.invoice.currency || "AUD"),
    due: data.invoice.due_date ? auDate(data.invoice.due_date) : null,
    link: invoiceLink(await requestOrigin(), invoiceId),
  });

  const result = await sendSms({ to: mobile, body });
  const shown = displayMobile(mobile);

  if (!result.ok) {
    await recordAudit(session, {
      entity: "invoice", entityId: invoiceId, action: "send_failed",
      summary: `text to ${shown}: ${result.error}`,
    });
    return { ok: false, invoiceNumber, error: result.error };
  }

  // A stamp that fails does not fail the send, for `advanceJobsToSent`'s reason:
  // the text has gone, and reporting a failure would invite a second one. The
  // audit row below still says where it went.
  const { error } = await supabase
    .from("invoices")
    .update({ sms_sent_at: new Date().toISOString(), sms_sent_to: mobile })
    .eq("id", invoiceId).eq("tenant_id", session.tenantId);
  if (error) console.error("invoice text stamp failed", { invoiceId, error: error.message });

  await recordAudit(session, {
    entity: "invoice", entityId: invoiceId, action: "send",
    summary: `texted to ${shown}`,
    metadata: { providerId: result.id },
  });

  await advanceJobsToSent(supabase, session, invoiceId, invoiceNumber);

  return { ok: true, invoiceNumber, recipient: shown };
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
  | { ok: true; released: number; excluded: number }
  | { ok: false; error: string; released: number; excluded: number };

/**
 * What to do with the work on a voided invoice (brief 1.6). `rebill: true` is
 * what voiding has always done — the jobs go back to `approved`, to be billed
 * again. `rebill: false` takes them out of billing altogether: `not_billable`,
 * with the void's reason on the record. Getting there passes through
 * `approved` deliberately — 0017's guard has no edge from an invoiced state to
 * `not_billable`, and both steps it does have are the ones a person would take.
 */
export type ReleaseChoice = { rebill: boolean; reason?: string | null };

export async function releaseVoidedInvoiceJobs(
  supabase: Client, session: Session, invoiceId: string,
  choice: ReleaseChoice = { rebill: true },
): Promise<ReleaseOutcome> {
  const { data: sources, error: readError } = await supabase
    .from("invoice_source_jobs")
    .select("order_id")
    .eq("invoice_id", invoiceId)
    .eq("tenant_id", session.tenantId)
    .returns<Array<{ order_id: string }>>();
  if (readError) return { ok: false, error: describeDbError(readError), released: 0, excluded: 0 };

  const jobIds = (sources ?? []).map((row) => row.order_id);
  if (jobIds.length === 0) return { ok: true, released: 0, excluded: 0 };

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
  if (unlinkError) return { ok: false, error: describeDbError(unlinkError), released: 0, excluded: 0 };

  const { data: moved, error: moveError } = await supabase
    .from("laundry_orders")
    .update({ billing_status: "approved" })
    .in("id", jobIds)
    .eq("tenant_id", session.tenantId)
    .in("billing_status", ["invoice_generated", "invoice_sent"])
    .select("id");
  if (moveError) return { ok: false, error: describeDbError(moveError), released: 0, excluded: 0 };

  // A job that did not move is stranded in a state the void did not undo (a
  // `paid` job is the case the 12 October test found). Said, never hidden: the
  // toast used to claim every job was back in the queue regardless.
  const movedIds = (moved ?? []).map((row: { id: string }) => row.id);
  const released = movedIds.length;
  if (released < jobIds.length) {
    return {
      ok: false, released, excluded: 0,
      error: `${jobIds.length - released} of ${jobIds.length} jobs on it could not be put back in the billing queue — check their billing status.`,
    };
  }

  if (choice.rebill) return { ok: true, released, excluded: 0 };

  // "Don't bill it again." Their frozen charges stay as the record of what was
  // once priced; the job just leaves billing, with the reason on it.
  const reason = choice.reason?.trim() || "Invoice voided — not to be billed again";
  const { data: excluded, error: excludeError } = await supabase
    .from("laundry_orders")
    .update({ billing_status: "not_billable", billing_exclusion_reason: reason, billing_hold_reason: null })
    .in("id", movedIds)
    .eq("tenant_id", session.tenantId)
    .eq("billing_status", "approved")
    .select("id");
  if (excludeError) {
    return {
      ok: false, released, excluded: 0,
      error: `the jobs went back to the billing queue but could not be marked not billable: ${describeDbError(excludeError)}`,
    };
  }
  const excludedCount = excluded?.length ?? 0;
  for (const id of movedIds) {
    await logOrderActivity(supabase, session, id, {
      activity_type: "status_changed",
      previous: { billing_status: "invoice_generated" },
      next: { billing_status: "not_billable" },
      note: `Its invoice was voided and it is not to be billed again: ${reason}`,
    });
  }
  return { ok: true, released: 0, excluded: excludedCount };
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
