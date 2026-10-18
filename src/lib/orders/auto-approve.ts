import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import {
  autoApproveDecision, cleanPricingVerdict, parseAutomation, type PricedLine,
} from "@/lib/domain/automation";
import { logOrderActivity } from "@/lib/orders/activity";
import { approveAndPlaceJob } from "@/lib/orders/approve";
import { issueOneInvoice } from "@/lib/invoices/issue";
import { sendInvoice } from "@/lib/invoices/send";

/**
 * "Delivered means billed" (Darshan's BA review, brief 2.3, design rule 5).
 *
 * 1.3 made a finished job price itself. This is the next step: when every line
 * came from the customer's rate card or the laundry price list — nothing
 * priced by hand, nothing at $0.00, nothing from the item's own selling price —
 * and both switches are on (the laundry's `autoApproveCleanJobs` and the
 * customer's own `auto_approve`), the job is approved and its charges join the
 * customer's draft without anybody opening the billing queue.
 *
 * **Through the existing approve routine.** `approveAndPlaceJob` freezes the
 * charges (`freeze_job_charges`, then `guard_job_charge_snapshot` holds them),
 * moves the billing status under `guard_laundry_order_billing`, and places them
 * on the running draft (`open-draft.ts`) — the same calls the Approve button
 * makes, so an automatic approval cannot mean anything a manual one does not.
 * The timeline says "Auto-approved" so nobody mistakes it for a person's
 * decision.
 *
 * Anything else stays in Awaiting review, and the job's timeline says why.
 *
 * **On the service-role client, tenant named on every read**, for the reason
 * `autoPriceCompletedJob` gives: the round or driver finishing the job can read
 * no price and approve nothing. The decision is the laundry's, made in advance
 * in Settings › Automation; the person at the door only finished the work.
 *
 * Per-job customers can also have their draft **issued** (and so pushed to
 * Xero) on approval, behind `autoIssuePerJob` — **off by default**, because
 * issuing is the step that makes a tax invoice. Emailing it is a further,
 * separate switch, also off. Issuing still goes through `issueOneInvoice`, so
 * brief 1.1's gate refuses it while the laundry's invoice details are missing.
 *
 * Never throws and never fails the delivery that called it.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type AutoApproveOutcome =
  | { state: "approved"; invoiceNumber: string | null; issued: boolean; emailed: boolean }
  | { state: "held"; why: string }
  | { state: "skipped" };

export async function autoApproveIfClean(
  admin: Client, session: Session, orderId: string,
): Promise<AutoApproveOutcome> {
  try {
    const { data: job } = await admin
      .from("laundry_orders")
      .select("id, order_number, customer_id, billing_status")
      .eq("tenant_id", session.tenantId).eq("id", orderId)
      .maybeSingle<{ id: string; order_number: string; customer_id: string; billing_status: string }>();
    if (!job || job.billing_status !== "awaiting_review") return { state: "skipped" };

    const [{ data: tenant }, { data: customer }, { data: lines }] = await Promise.all([
      admin.from("tenants").select("settings").eq("id", session.tenantId)
        .maybeSingle<{ settings: unknown }>(),
      admin.from("customers").select("auto_approve, billing_method")
        .eq("tenant_id", session.tenantId).eq("id", job.customer_id)
        .maybeSingle<{ auto_approve: boolean | null; billing_method: string | null }>(),
      admin.from("job_charge_snapshots")
        .select("pricing_model, source_agreement_id, unit_price, amount")
        .eq("tenant_id", session.tenantId).eq("order_id", job.id)
        .returns<PricedLine[]>(),
    ]);

    const settings = parseAutomation(tenant?.settings);
    const decision = autoApproveDecision({
      settings,
      // A customer row read before 0056 carries no column: absent reads as the default, on.
      customerAutoApprove: customer?.auto_approve !== false,
      verdict: cleanPricingVerdict(lines ?? [], 0),
    });
    if (!decision.approve) {
      if (settings.autoApproveCleanJobs) {
        await logOrderActivity(admin, session, job.id, {
          activity_type: "updated",
          next: { billing: "awaiting_review", automatic: true },
          note: `Left for a person to approve: ${decision.why}.`,
        });
      }
      return { state: "held", why: decision.why };
    }

    const approved = await approveAndPlaceJob(admin, session, job.id);
    if (!approved.ok) return { state: "held", why: approved.error };

    const placed = approved.placement.kind === "placed" ? approved.placement : null;
    await logOrderActivity(admin, session, job.id, {
      activity_type: "status_changed",
      previous: { billing_status: "awaiting_review" },
      next: { billing_status: "approved", automatic: true, invoice: placed?.invoiceNumber ?? null },
      note: placed
        ? `Auto-approved: every line came from a rate card or the price list. On draft ${placed.invoiceNumber}.`
        : "Auto-approved: every line came from a rate card or the price list.",
    });

    let issued = false;
    let emailed = false;
    if (placed && settings.autoIssuePerJob && customer?.billing_method === "invoice_per_job") {
      const issue = await issueOneInvoice(admin, session, placed.invoiceId);
      issued = issue.ok;
      if (issue.ok && settings.emailOnIssue) {
        emailed = (await sendInvoice(admin, session, placed.invoiceId)).ok;
      }
    }

    return { state: "approved", invoiceNumber: placed?.invoiceNumber ?? null, issued, emailed };
  } catch (cause) {
    console.error("automatic approval threw", { orderId, cause });
    return { state: "skipped" };
  }
}

/** Appended to the completion toast, for a role that may read money. */
export function autoApproveSentence(outcome: AutoApproveOutcome): string {
  if (outcome.state !== "approved") return "";
  const where = outcome.invoiceNumber ? ` and is on draft ${outcome.invoiceNumber}` : "";
  const issued = outcome.issued ? `, which was issued${outcome.emailed ? " and emailed" : ""}` : "";
  return ` Every line came from your rates, so it was approved automatically${where}${issued}.`;
}
