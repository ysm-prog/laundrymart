import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { describeDbError } from "@/lib/actions";
import { pushInvoiceToXero } from "@/lib/xero/push";

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
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type IssueResult =
  | { ok: true; xero: "pushed" | "skipped" | "failed"; reason?: string }
  | { ok: false; error: string };

export async function issueOneInvoice(
  supabase: Client, session: Session, invoiceId: string,
): Promise<IssueResult> {
  await supabase.rpc("recalculate_invoice", { p_invoice: invoiceId });

  const { data, error } = await supabase
    .from("invoices")
    .update({ status: "issued", issued_at: new Date().toISOString() })
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
