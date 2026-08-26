import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { businessToday } from "@/lib/domain/timezone";
import { describePeriod } from "@/lib/domain/billing-period";
import { type Placement } from "@/lib/domain/placement";
import { approveJob } from "@/lib/orders/job-billing";
import { generateInvoicesForJobs, type GeneratedInvoice } from "@/lib/invoices/from-jobs";

/**
 * Approving a job's charges, and putting them on the customer's invoice.
 *
 * **The step the owner's flow has and the app did not.** Approval used to freeze
 * the charges and stop: the job moved to `approved`, sat in the *Awaiting
 * invoice* queue, and waited for somebody to come back on a different screen,
 * tick it and press Generate. Setting the charge *is* what puts it on the
 * customer's invoice — so the two happen together, and the sentence the reviewer
 * reads back names the invoice it landed on.
 *
 *     approve ──► freeze the charges ──► place them on the customer's
 *                 (job-billing.ts)       open draft for the period
 *                                        (from-jobs.ts → open-draft.ts)
 *
 * What approval never does is *create an invoice*. It puts money on a draft; the
 * draft becomes an invoice when somebody issues it, on the drafts board, and
 * nowhere else.
 *
 * Two rules, and the second is the one worth defending:
 *
 * - **Every approval places, whatever the customer's billing method.** There is
 *   no longer any way to turn a job into an invoice directly, so a job that
 *   landed on no draft would sit in the queue with nowhere to go. `manual` used
 *   to be held back here; what that setting buys now is
 *   `sweptByMonthEndRun` — the scheduled run leaves such a customer alone, and
 *   the person pressing Approve is the person `manual` was asking for.
 * - **A failed placement never un-approves the job.** Approval is the freeze and
 *   it either happened or it did not. If the draft cannot be opened, the job
 *   stays `approved`, sits in the queue exactly as it did before this existed,
 *   and the operator is told in the same breath. Rolling back a decision
 *   somebody actually made because a downstream write failed is the worse
 *   outcome by a distance.
 *
 * Lives here rather than in the two actions that call it because those are the
 * single button and the bulk form, and this repo's standing rule is that twenty
 * must not take a different path from one.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type { Placement };

export type ApprovalOutcome =
  | { ok: true; orderNumber: string; subtotal: number; placement: Placement }
  | { ok: false; error: string };

/** How one generated/extended invoice reads back to the person who caused it. */
export function placementOf(entry: GeneratedInvoice): Placement {
  return {
    kind: "placed",
    invoiceId: entry.invoiceId,
    invoiceNumber: entry.invoiceNumber,
    opened: entry.opened,
    total: entry.total,
    period: entry.period ? describePeriod(entry.period) : null,
  };
}

/** Approve one job and place its charges. */
export async function approveAndPlaceJob(
  supabase: Client, session: Session, orderId: string,
): Promise<ApprovalOutcome> {
  const approved = await approveJob(supabase, session, orderId);
  if (!approved.ok) return approved;

  const placements = await placeApprovedJobs(supabase, session, [orderId]);
  return {
    ok: true,
    orderNumber: approved.orderNumber,
    subtotal: approved.subtotal,
    placement: placements.get(orderId) ?? { kind: "failed", reason: "nothing was invoiced" },
  };
}

/**
 * Place a set of freshly approved jobs, and say what happened to each.
 *
 * One call rather than one per job: the generator reads the jobs, their charges
 * and their customers in one query each, and groups by customer and period — so
 * four of one customer's jobs approved together join one draft in one pass
 * rather than four times over.
 */
export async function placeApprovedJobs(
  supabase: Client, session: Session, orderIds: readonly string[],
): Promise<Map<string, Placement>> {
  const byJob = new Map<string, Placement>();
  if (orderIds.length === 0) return byJob;

  const run = await generateInvoicesForJobs(supabase, session, orderIds, {
    issueDate: businessToday(),
    // Deliberately off. An approval *is* a person choosing to bill this work —
    // the decision `manual` asks for — and with the job→invoice door closed a
    // job held back here would have no route onto an invoice at all.
    respectManual: false,
  });

  for (const entry of run.created) {
    const placement = placementOf(entry);
    for (const jobId of entry.jobIds) byJob.set(jobId, placement);
  }

  // Every skip carries its own job id, so a reason is matched to the row it
  // belongs to rather than paired with it by position — with several customers
  // in one selection, position is exactly what cannot be relied on.
  const reasonByJob = new Map(run.skipped.map((entry) => [entry.orderId, entry.reason]));
  for (const id of orderIds) {
    if (byJob.has(id)) continue;
    byJob.set(id, { kind: "failed", reason: `${reasonByJob.get(id) ?? "nothing was invoiced"}.` });
  }

  return byJob;
}
