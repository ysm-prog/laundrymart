"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, firstIssue, returnTo, toObject } from "@/lib/actions";
import { businessToday } from "@/lib/domain/timezone";
import { money } from "@/lib/format";
import { approveJob } from "@/lib/orders/job-billing";
import { generateInvoicesForJobs } from "@/lib/invoices/from-jobs";
import { sendInvoice } from "@/lib/invoices/send";

/**
 * Bulk billing: approve a selection, invoice a selection, send a selection.
 *
 * **Server-side operations, not a loop of individual server actions.** Each of
 * these is one request that reads its whole selection in one query and does the
 * set-based part in one statement. The alternative — the browser firing one
 * action per row — is what makes a fifty-row selection take fifty round trips,
 * fail halfway with no record of where, and leave the operator guessing.
 *
 * The other half of that is honesty about partial success. A selection of forty
 * where three cannot proceed reports **both** numbers and names the reasons; it
 * never reports forty and it never fails the whole batch over three. That is why
 * every one of these returns a summary rather than the first error it met.
 *
 * `invoices.bulk` gates all three, on top of the capability the single-record
 * version needs — the same operation, but a mistake is multiplied by the size of
 * the selection.
 */

const QUEUE = "/invoices/awaiting";
const REGISTER = "/invoices";

/**
 * The selected ids, from a checkbox group.
 *
 * Capped at 200. Not arbitrary: it is well past any real day's work, and it
 * bounds how long one request can run and how many invoice numbers a single
 * press can consume. A selection over the cap is refused with a sentence rather
 * than silently truncated — a bulk action that quietly does part of the job is
 * worse than one that declines.
 */
const MAX_SELECTION = 200;

function selectedIds(formData: FormData, field = "selected"): string[] | null {
  const raw = formData.getAll(field).filter((value): value is string => typeof value === "string");
  const parsed = z.array(z.string().uuid()).safeParse(raw);
  if (!parsed.success) return null;
  return [...new Set(parsed.data)];
}

/* ------------------------------------------------------- approve selected --- */

export async function approveSelectedJobs(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  await assertCapability("invoices.approve");

  const ids = selectedIds(formData);
  if (!ids) return fail(QUEUE, "That selection could not be read. Please try again.");
  if (ids.length === 0) return fail(QUEUE, "Select at least one job to approve.");
  if (ids.length > MAX_SELECTION) {
    return fail(QUEUE, `Select ${MAX_SELECTION} jobs or fewer at a time.`);
  }

  const supabase = await createClient();

  // Approval freezes each job's own charge lines and stamps its own approver, so
  // this is genuinely per job rather than one UPDATE — and it goes through the
  // very function the single-job button uses, so twenty cannot take a different
  // path from one.
  const approved: string[] = [];
  const refused: string[] = [];
  let total = 0;

  for (const id of ids) {
    const result = await approveJob(supabase, session, id);
    if (result.ok) {
      approved.push(result.orderNumber);
      total += result.subtotal;
    } else {
      refused.push(result.error);
    }
  }

  await recordAudit(session, {
    entity: "laundry_order", action: "status_change",
    summary: `bulk approve: ${approved.length} of ${ids.length}`,
    metadata: { approved: approved.length, refused: refused.length },
  });

  revalidatePath(QUEUE);
  revalidatePath(REGISTER);

  if (approved.length === 0) {
    return fail(QUEUE, refused[0] ?? "None of those jobs could be approved.");
  }
  const note = refused.length > 0
    ? ` ${refused.length} could not be approved — ${refused[0]}`
    : "";
  return done(QUEUE,
    `Approved ${approved.length} job(s), ${money(total)} before GST.${note}`);
}

/* ------------------------------------------------------ generate selected --- */

export async function generateSelectedInvoices(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  await assertCapability("invoices.write");

  const ids = selectedIds(formData);
  if (!ids) return fail(QUEUE, "That selection could not be read. Please try again.");
  if (ids.length === 0) return fail(QUEUE, "Select at least one approved job to invoice.");
  if (ids.length > MAX_SELECTION) {
    return fail(QUEUE, `Select ${MAX_SELECTION} jobs or fewer at a time.`);
  }

  const supabase = await createClient();
  const result = await generateInvoicesForJobs(supabase, session, ids, {
    issueDate: businessToday(),
    // A person picked these rows, which is exactly the decision `manual` asks
    // for — so a manual customer's jobs are honoured here, unlike in a
    // scheduled run.
    respectManual: false,
  });

  revalidatePath(QUEUE);
  revalidatePath(REGISTER);

  if (result.created.length === 0) {
    const first = result.skipped[0];
    return fail(QUEUE, first
      ? `Nothing was invoiced — ${first.orderNumber}: ${first.reason}.`
      : "Nothing was invoiced.");
  }

  const jobCount = result.created.reduce((sum, entry) => sum + entry.jobIds.length, 0);
  const consolidated = result.created.filter((entry) => entry.jobIds.length > 1).length;
  const shape = consolidated > 0
    ? ` (${consolidated} consolidated across several jobs)`
    : "";
  const skipped = result.skipped.length > 0
    ? ` ${result.skipped.length} job(s) skipped — ${result.skipped[0]?.reason}.`
    : "";

  // Said out loud: generating is not sending. The whole point of phase 5 is
  // that a customer has not been contacted at this moment.
  return done(REGISTER,
    `Generated ${result.created.length} draft invoice(s) from ${jobCount} job(s)${shape}. `
    + `Nothing has been sent yet.${skipped}`);
}

/* ---------------------------------------------------------- send selected --- */

export async function sendSelectedInvoices(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  await assertCapability("invoices.send");

  const back = returnTo(formData, REGISTER);
  const ids = selectedIds(formData);
  if (!ids) return fail(back, "That selection could not be read. Please try again.");
  if (ids.length === 0) return fail(back, "Select at least one invoice to send.");
  if (ids.length > MAX_SELECTION) {
    return fail(back, `Select ${MAX_SELECTION} invoices or fewer at a time.`);
  }

  const supabase = await createClient();

  // One email per invoice is unavoidable — each carries its own PDF to its own
  // address — but it is one *request*, and every outcome is collected rather
  // than the first failure aborting the rest. A bounce on invoice three must
  // not stop invoices four to forty going out.
  const sent: string[] = [];
  const failed: Array<{ number: string; reason: string }> = [];

  for (const id of ids) {
    const result = await sendInvoice(supabase, session, id);
    if (result.ok) sent.push(result.invoiceNumber);
    else failed.push({ number: result.invoiceNumber ?? "an invoice", reason: result.error });
  }

  await recordAudit(session, {
    entity: "invoice", action: "send",
    summary: `bulk send: ${sent.length} of ${ids.length}`,
    metadata: { sent: sent.length, failed: failed.length },
  });

  revalidatePath(REGISTER);

  if (sent.length === 0) {
    const first = failed[0];
    return fail(back, first ? `${first.number}: ${first.reason}` : "Nothing was sent.");
  }
  const note = failed.length > 0
    ? ` ${failed.length} could not be sent — ${failed[0]?.number}: ${failed[0]?.reason}`
    : "";
  return done(back, `Sent ${sent.length} invoice(s).${note}`);
}

/* --------------------------------------------- record a Xero reference ----- */

/**
 * Record what an invoice is called in Xero.
 *
 * **Typed in by a person, because there is no Xero integration in this
 * codebase.** The previous project checkpoint left Xero authentication and the
 * invoice-state mapping unresolved, and inventing an API contract here would
 * produce code that compiles, reads convincingly and has never spoken to Xero.
 * What this does instead is hold the reference so the two systems can be
 * reconciled, and say plainly on screen that it is doing only that.
 */
export async function recordXeroReference(formData: FormData): Promise<void> {
  const session = await assertCapability("billing.write");
  const parsed = z.object({
    id: z.string().uuid(),
    xero_invoice_id: z.string().trim().max(120).optional(),
    xero_invoice_number: z.string().trim().max(60).optional(),
    xero_status: z.string().trim().max(40).optional(),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(REGISTER, firstIssue(parsed.error));

  const back = returnTo(formData, `/invoices/${parsed.data.id}`);
  const supabase = await createClient();

  const { error } = await supabase
    .from("invoices")
    .update({
      xero_invoice_id: parsed.data.xero_invoice_id || null,
      xero_invoice_number: parsed.data.xero_invoice_number || null,
      xero_status: parsed.data.xero_status || null,
      xero_synced_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(back, describeDbError(error));

  await recordAudit(session, {
    entity: "invoice", entityId: parsed.data.id, action: "update",
    summary: `Xero reference recorded: ${parsed.data.xero_invoice_number ?? "—"}`,
  });

  revalidatePath(`/invoices/${parsed.data.id}`);
  revalidatePath(REGISTER);
  return done(back, "Xero reference recorded.");
}
