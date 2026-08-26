import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { describeDbError } from "@/lib/actions";
import { pushInvoiceToXero } from "@/lib/xero/push";
import { addDays } from "@/lib/domain/dates";
import { businessToday } from "@/lib/domain/timezone";

/**
 * Issuing one invoice — the single implementation.
 *
 * Extracted for the reason `lib/invoices/send.ts` and `lib/orders/complete.ts`
 * were: the register's single Issue button and Issue Selected must do the same
 * thing, and "the same thing" here includes the Xero push and its
 * never-block-the-money contract (§20). Two copies of that ordering is two
 * chances to get it the wrong way round.
 *
 * The order is load-bearing and unchanged from the single action:
 *
 *   1. `recalculate_invoice`, so the totals about to be frozen into a document
 *      are the totals its lines actually add up to;
 *   2. `draft → issued`, filtered on `status = 'draft'` — an invoice somebody
 *      else issued a moment ago must not be re-stamped with a later time;
 *   3. Xero, **after** the invoice is issued and never as a precondition. A
 *      refusal leaves it issued with `xero_push_error` set and a Retry beside
 *      it. The money record is this database's; Xero is a copy of it.
 *
 * **An invoice is dated the day it is issued.** Step 2 re-stamps `issue_date`
 * and re-derives `due_date` from it, which is a change from the behaviour that
 * shipped before the running draft: generation wrote both and issuing left them
 * alone. That was survivable while a draft lived for minutes. A draft is now
 * *designed* to sit open for a month — opened on the 3rd with 14-day terms, it
 * would otherwise reach the customer on the 31st already a fortnight overdue.
 * Which period the invoice covers is not lost by this: `period_start` and
 * `period_end` carry it, and they are what the invoice prints.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type IssueResult =
  | { ok: true; xero: "pushed" | "skipped" | "failed"; reason?: string }
  | { ok: false; error: string };

export async function issueOneInvoice(
  supabase: Client, session: Session, invoiceId: string,
): Promise<IssueResult> {
  await supabase.rpc("recalculate_invoice", { p_invoice: invoiceId });

  // Read the terms back rather than trusting a caller: the due date has to be
  // derived from what this invoice actually promises, and a form field is not
  // evidence of it.
  const { data: terms } = await supabase
    .from("invoices")
    .select("payment_terms_days")
    .eq("id", invoiceId).eq("tenant_id", session.tenantId)
    .maybeSingle<{ payment_terms_days: number | null }>();

  const issuedOn = businessToday();
  const { data, error } = await supabase
    .from("invoices")
    .update({
      status: "issued",
      issued_at: new Date().toISOString(),
      issue_date: issuedOn,
      due_date: addDays(issuedOn, Number(terms?.payment_terms_days ?? 14)),
    })
    .eq("id", invoiceId).eq("tenant_id", session.tenantId).eq("status", "draft")
    .select("id");
  if (error) return { ok: false, error: describeDbError(error) };

  // `update` matching nothing is not an error to PostgREST, and in bulk it is
  // the outcome that most needs naming: an invoice that was already issued,
  // already void, or belongs to another laundry silently counts as a success
  // otherwise, and the operator reads "issued 40" over a batch of 37.
  if (!data || data.length === 0) {
    return { ok: false, error: "it is no longer a draft" };
  }

  await recordAudit(session, {
    entity: "invoice", entityId: invoiceId, action: "status_change", summary: "issued",
  });

  const push = await pushInvoiceToXero(supabase, invoiceId, session.tenantId);
  if (push.ok) return { ok: true, xero: "pushed" };
  if (push.skipped) return { ok: true, xero: "skipped" };
  return { ok: true, xero: "failed", reason: push.reason };
}
