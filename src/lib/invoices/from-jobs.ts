import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { describeDbError } from "@/lib/actions";
import { toZonedDate } from "@/lib/domain/timezone";
import { isBillingMethod, type BillingMethod } from "@/lib/domain/billing";
import {
  billingPeriodFor, sweptByMonthEndRun, type BillingPeriod,
} from "@/lib/domain/billing-period";
import { groupJobsForInvoicing } from "@/lib/domain/invoice-grouping";
import { findOrOpenDraft, rebuildJobLines, type DraftCustomer } from "@/lib/invoices/open-draft";
import { logOrderActivity } from "@/lib/orders/activity";
import { loadChargesForJobs } from "@/lib/orders/job-billing";

/**
 * Turning approved jobs into invoices.
 *
 * **The architectural decision this file exists to make good on:** a completed
 * job is a *billable source*, and whether August produces fifteen invoices or
 * one is decided here, at generation time, from `customers.billing_method`. Both
 * shapes write the same rows — an invoice, its lines, and one
 * `invoice_source_jobs` row per job — so switching a customer from per-job to
 * monthly is a column change and never a schema change.
 *
 *     Job 1 ┐
 *     Job 2 ├──────────────────────► the customer's OPEN DRAFT ──► issue
 *     Job 3 ┘                        for the period
 *
 *     Job ─────────────────────────► its own DRAFT ─────────────► issue
 *                                    (invoice_per_job)
 *
 * **A job never becomes an invoice. It joins a draft, and a draft becomes an
 * invoice when somebody issues it.** That is the whole rule, and both shapes
 * above obey it: what differs is how many jobs share a draft, not whether one
 * exists. Every draft here is opened by `lib/invoices/open-draft.ts` — this
 * module inserts no invoice of its own, which it used to do for any group with
 * no period (a per-job customer, a `manual` one), and which is what let pressing
 * Approve mint a whole invoice document straight off a job.
 *
 * **Since 0040 a consolidated group joins the customer's running draft** rather
 * than always inserting a new invoice. That single word — join, not insert — is
 * what makes "one invoice per customer per month" true: before it, a
 * consolidated customer got one invoice per *button press*, so approving a job
 * on the 3rd and another on the 11th produced two August invoices. Nothing was
 * billed twice (`uq_invoice_source_jobs_once` saw to that); the month was simply
 * split across two documents.
 *
 * **Generating never sends.** Nothing in this file emails anybody; the invoice
 * lands as a draft, and `invoice_sent` is reached only through the send action.
 * That separation is the whole of phase 5 and it is why the two live apart.
 *
 * **Consolidated invoices roll up per item.** Ten jobs' worth of towels become
 * one line carrying 1,450, not thirty lines each naming a job number — the rule
 * is `jobInvoiceLines`, which is pure and tested. The per-job detail is not lost:
 * `invoice_source_jobs` and the frozen `job_charge_snapshots` behind each job are
 * the breakdown, and the invoice screen renders it underneath.
 *
 * **Creating and appending go through the same line writer**, `rebuildJobLines`.
 * A first job and a twelfth are the same operation: re-derive every job line on
 * the invoice from every job it bills. Two writers here would mean adding a
 * twelfth job silently rewrote the first eleven lines in some other shape.
 *
 * The same job cannot be billed twice, and that is enforced in the database
 * rather than here: `uq_invoice_source_jobs_once` is a unique index on
 * (tenant, job). This module filters on `billing_status = 'approved'` as well,
 * so the ordinary path never reaches the constraint — but a second generation
 * run racing the first hits it and loses, which is the correct outcome.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type BillableJob = {
  id: string;
  order_number: string;
  customer_id: string;
  depot_id: string | null;
  completed_at: string | null;
  billing_status: string;
};

export type GeneratedInvoice = {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  jobIds: string[];
  total: number;
  /** False when the jobs joined a draft that already existed. */
  opened: boolean;
  period: BillingPeriod | null;
};

export type GenerationResult = {
  created: GeneratedInvoice[];
  /**
   * Jobs that could not be billed, each with the reason a person can act on.
   * The id travels beside the number so a caller reporting per job can match a
   * reason back to the row it belongs to rather than pairing them by position.
   */
  skipped: Array<{ orderId: string; orderNumber: string; reason: string }>;
};

type CustomerRow = DraftCustomer & { billing_method: string };

/**
 * Put a group of jobs onto a draft — the customer's running one where the group
 * has a period, a freshly opened one where it does not.
 *
 * The order of writes matters and is chosen so a failure never leaves a job
 * looking billed when it is not:
 *
 *   1. refuse early if the group's jobs carry no charges at all, so an empty
 *      draft is never opened;
 *   2. resolve the draft — join the running one, or open one;
 *   3. `invoice_source_jobs`, which is where the "billed once" constraint bites;
 *   4. the lines, re-derived from the **frozen snapshots** of every job the
 *      invoice now bills and never re-priced;
 *   5. `source_job_id` for the single-job case;
 *   6. last of all, the jobs move to `invoice_generated`.
 *
 * A job only leaves the queue once its money is actually on an invoice.
 */
async function placeGroupOnInvoice(
  supabase: Client,
  session: Session,
  group: { customerId: string; method: BillingMethod; period: BillingPeriod | null; jobs: BillableJob[] },
  chargeCountByJob: ReadonlyMap<string, number>,
  customer: CustomerRow,
  issueDate: string,
): Promise<{ ok: true; invoice: GeneratedInvoice } | { ok: false; error: string }> {
  const jobIds = group.jobs.map((job) => job.id);

  const chargeCount = jobIds.reduce((sum, id) => sum + (chargeCountByJob.get(id) ?? 0), 0);
  if (chargeCount === 0) {
    return { ok: false, error: "no charges on the approved job(s)" };
  }

  const singleJob = group.jobs.length === 1 && group.method === "invoice_per_job";

  // **One door.** Whether this is a running monthly draft, a fortnightly one or
  // a per-job customer's single document, it is opened by `open-draft.ts` and it
  // is opened as a `draft`. This branch used to insert an invoice here instead
  // whenever the group had no period, which is what let Approve mint a whole
  // invoice straight off a job.
  const draft = await findOrOpenDraft(
    supabase, session,
    // **Deliberately the customer's own depot for a periodic draft**, and the
    // job's for a period-less one. That is what each branch did before they were
    // merged, and the asymmetry is right: a draft carrying a month of work has no
    // one job to take a site from, so the first one's would be arbitrary — while
    // a document raised for a single job should say where that job was done.
    group.period
      ? customer
      : { ...customer, depot_id: group.jobs.find((job) => job.depot_id)?.depot_id ?? customer.depot_id },
    group.period, issueDate,
    // Only a per-job *customer* gets the per-job shape. A consolidated customer
    // whose job has no completion date also arrives here with no period, and
    // must not be turned into a per-job invoice by that accident.
    singleJob ? "per_job" : "consolidated",
  );
  if (!draft.ok) return { ok: false, error: draft.error };
  const { id: invoiceId, invoiceNumber, opened } = draft.draft;

  // Claim the jobs before writing anything else. This is the row the unique
  // index guards, so a concurrent run that got here first makes this fail —
  // and failing here means no lines and no status change happened.
  const { error: sourceError } = await supabase.from("invoice_source_jobs").insert(
    jobIds.map((orderId) => ({
      tenant_id: session.tenantId,
      created_by: session.userId,
      invoice_id: invoiceId,
      order_id: orderId,
    })),
  );
  if (sourceError) {
    // Only unwind an invoice this call brought into existence, and only while it
    // is still empty. Deleting a *running* draft because one job could not be
    // claimed would throw away every job already on it.
    if (opened) {
      const { count } = await supabase
        .from("invoice_source_jobs")
        .select("id", { count: "exact", head: true })
        .eq("invoice_id", invoiceId).eq("tenant_id", session.tenantId);
      if ((count ?? 0) === 0) {
        await supabase.from("invoices").delete()
          .eq("id", invoiceId).eq("tenant_id", session.tenantId);
      }
    }
    return {
      ok: false,
      error: sourceError.code === "23505"
        ? "already on another invoice"
        : describeDbError(sourceError),
    };
  }

  // One writer for the lines, whether this is the invoice's first job or its
  // twelfth. It re-consolidates across everything the invoice bills, so towels
  // from the new job are added to the towel line rather than written beneath it.
  const rebuilt = await rebuildJobLines(supabase, session, invoiceId);
  if (!rebuilt.ok) return { ok: false, error: rebuilt.error };

  if (singleJob) {
    const { error: pointerError } = await supabase
      .from("invoices")
      .update({ source_job_id: jobIds[0] })
      .eq("id", invoiceId).eq("tenant_id", session.tenantId);
    if (pointerError) return { ok: false, error: describeDbError(pointerError) };
  }

  const { error: statusError } = await supabase
    .from("laundry_orders")
    .update({ billing_status: "invoice_generated" })
    .in("id", jobIds)
    .eq("tenant_id", session.tenantId)
    .eq("billing_status", "approved");
  if (statusError) return { ok: false, error: describeDbError(statusError) };

  const { data: totals } = await supabase
    .from("invoices").select("total").eq("id", invoiceId).maybeSingle<{ total: number }>();

  for (const job of group.jobs) {
    await logOrderActivity(supabase, session, job.id, {
      activity_type: "status_changed",
      previous: { billing_status: "approved" },
      next: { billing_status: "invoice_generated", invoice: invoiceNumber },
    });
  }

  return {
    ok: true,
    invoice: {
      invoiceId,
      invoiceNumber,
      customerId: group.customerId,
      jobIds,
      total: Number(totals?.total ?? 0),
      opened,
      period: group.period,
    },
  };
}

/**
 * Generate — or extend — invoices for a set of approved jobs.
 *
 * The one entry point, used by the approval, the single-job action, the bulk
 * queue action, the per-customer period button and the month-end run — so a
 * selection of one, a selection of forty and a scheduled sweep cannot drift
 * apart in what they produce.
 *
 * Set-based where it can be: the jobs, their charges and the customers are each
 * read in one query rather than per job. The per-invoice write loop is genuinely
 * per-invoice, because each needs its own draft resolved and its own lines built.
 */
export async function generateInvoicesForJobs(
  supabase: Client,
  session: Session,
  orderIds: readonly string[],
  options: {
    issueDate: string;
    /**
     * Leave `manual` customers out — a scheduled-style sweep over everything,
     * where nobody has chosen these particular jobs. Off for anything a person
     * pressed, approval included: a job that landed on no draft would sit in the
     * queue with no way onto an invoice at all, since a job can no longer be
     * turned into one directly.
     */
    respectManual?: boolean;
    /**
     * The window every consolidated group is billed into, overriding each job's
     * own. Passed by the month-end run and by the per-customer period button —
     * the operator chose that window, so it is the window the draft is keyed on.
     * Omitted, each job finds its own period from its customer's billing method.
     */
    period?: BillingPeriod | null;
  },
): Promise<GenerationResult> {
  const result: GenerationResult = { created: [], skipped: [] };
  if (orderIds.length === 0) return result;

  const { data: jobs } = await supabase
    .from("laundry_orders")
    .select("id, order_number, customer_id, depot_id, completed_at, billing_status")
    .in("id", [...orderIds])
    .eq("tenant_id", session.tenantId)
    .returns<BillableJob[]>();

  const approved = (jobs ?? []).filter((job) => {
    if (job.billing_status === "approved") return true;
    result.skipped.push({
      orderId: job.id,
      orderNumber: job.order_number,
      reason: job.billing_status === "invoice_generated" || job.billing_status === "invoice_sent"
        ? "already invoiced"
        : "not approved yet",
    });
    return false;
  });
  if (approved.length === 0) return result;

  const customerIds = [...new Set(approved.map((job) => job.customer_id))];
  const [{ data: customers }, chargesByJob] = await Promise.all([
    supabase
      .from("customers")
      .select("id, billing_method, payment_terms_days, depot_id, purchase_order_number")
      .in("id", customerIds)
      .eq("tenant_id", session.tenantId)
      .returns<CustomerRow[]>(),
    loadChargesForJobs(supabase, approved.map((job) => job.id)),
  ]);

  const customerById = new Map((customers ?? []).map((row) => [row.id, row]));
  const methodByCustomer = new Map<string, BillingMethod>(
    (customers ?? []).map((row) => [
      row.id,
      isBillingMethod(row.billing_method) ? row.billing_method : "monthly_consolidated",
    ]),
  );
  const chargeCountByJob = new Map(
    [...chargesByJob].map(([jobId, charges]) => [jobId, charges.length]),
  );

  // A scheduled run leaves `manual` customers alone; a person who explicitly
  // approved or selected the jobs has already made the decision `manual` is
  // asking for, so their selection is honoured. That difference is all the
  // setting means now, and it is the caller who knows which case this is. The
  // rule itself is `sweptByMonthEndRun`, stated in `lib/domain/` so a unit test
  // can reach it.
  const eligible = options.respectManual
    ? approved.filter((job) => {
        if (sweptByMonthEndRun(methodByCustomer.get(job.customer_id))) return true;
        result.skipped.push({ orderId: job.id, orderNumber: job.order_number, reason: "billed manually" });
        return false;
      })
    : approved;

  /**
   * Which draft each job belongs on.
   *
   * A per-job customer never has a window — their job *is* the draft, opened
   * once and joined by nothing. Otherwise the caller's explicit window wins, and
   * failing that the job finds its own from its completion date — `manual`
   * included, which is what stops a manual customer collecting a fresh document
   * per press. **Resolved in the business timezone**: a job finished at 09:00
   * Adelaide on 1 September is a September job, and composing that boundary in
   * UTC would put it on August's invoice, silently.
   */
  const periodOf = (job: BillableJob, method: BillingMethod): BillingPeriod | null => {
    if (method === "invoice_per_job") return null;
    if (options.period) return options.period;
    return billingPeriodFor(method, job.completed_at ? toZonedDate(job.completed_at) : null);
  };

  for (const group of groupJobsForInvoicing(eligible, methodByCustomer, periodOf)) {
    const customer = customerById.get(group.customerId);
    if (!customer) {
      for (const job of group.jobs) {
        result.skipped.push({ orderId: job.id, orderNumber: job.order_number, reason: "customer not found" });
      }
      continue;
    }

    const placed = await placeGroupOnInvoice(
      supabase, session, group, chargeCountByJob, customer, options.issueDate,
    );
    if (!placed.ok) {
      for (const job of group.jobs) {
        result.skipped.push({ orderId: job.id, orderNumber: job.order_number, reason: placed.error });
      }
      continue;
    }
    result.created.push(placed.invoice);
  }

  if (result.created.length > 0) {
    const opened = result.created.filter((entry) => entry.opened).length;
    await recordAudit(session, {
      entity: "invoice", action: "generate",
      summary: `${result.created.length} invoice(s) from ${
        result.created.reduce((sum, entry) => sum + entry.jobIds.length, 0)} job(s)`
        + ` — ${opened} raised, ${result.created.length - opened} added to an open draft`,
      metadata: {
        invoices: result.created.map((entry) => entry.invoiceNumber),
        opened,
        skipped: result.skipped.length,
      },
    });
  }

  return result;
}
