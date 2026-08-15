import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { describeDbError } from "@/lib/actions";
import { addDays } from "@/lib/domain/dates";
import { isBillingMethod, type BillingMethod } from "@/lib/domain/billing";
import { groupJobsForInvoicing } from "@/lib/domain/invoice-grouping";
import { logOrderActivity } from "@/lib/orders/activity";
import { loadChargesForJobs, type StoredCharge } from "@/lib/orders/job-billing";

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
 *     Job ─────────────────────────► Invoice        (invoice_per_job)
 *
 *     Job 1 ┐
 *     Job 2 ├──────────────────────► Invoice        (…_consolidated)
 *     Job 3 ┘
 *
 * **Generating never sends.** Nothing in this file emails anybody; the invoice
 * lands as a draft, and `invoice_sent` is reached only through the send action.
 * That separation is the whole of phase 5 and it is why the two live apart.
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
};

export type GenerationResult = {
  created: GeneratedInvoice[];
  /** Jobs that could not be billed, each with the reason a person can act on. */
  skipped: Array<{ orderNumber: string; reason: string }>;
};

/**
 * Write one invoice for a group of jobs.
 *
 * The order of writes matters and is chosen so a failure never leaves a job
 * looking billed when it is not:
 *
 *   1. the invoice header (no `source_job_id` yet — the guard in 0017 refuses
 *      one that does not yet have a matching source row);
 *   2. `invoice_source_jobs`, which is where the "billed once" constraint bites;
 *   3. the lines, copied from the **frozen snapshot** and never re-priced;
 *   4. `recalculate_invoice`, then `source_job_id` for the single-job case;
 *   5. last of all, the jobs move to `invoice_generated`.
 *
 * A job only leaves the queue once its money is actually on an invoice.
 */
async function writeInvoiceForGroup(
  supabase: Client,
  session: Session,
  group: { customerId: string; method: BillingMethod; jobs: BillableJob[] },
  chargesByJob: ReadonlyMap<string, StoredCharge[]>,
  customer: { payment_terms_days: number; depot_id: string | null; purchase_order_number: string | null },
  issueDate: string,
): Promise<{ ok: true; invoice: GeneratedInvoice } | { ok: false; error: string }> {
  const jobIds = group.jobs.map((job) => job.id);
  const lines = jobIds.flatMap((jobId) =>
    (chargesByJob.get(jobId) ?? []).map((charge) => ({ jobId, charge })),
  );

  if (lines.length === 0) {
    return { ok: false, error: "no charges on the approved job(s)" };
  }

  const { data: invoiceNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "invoice", p: "INV" });
  if (numberError) return { ok: false, error: describeDbError(numberError) };

  const terms = Number(customer.payment_terms_days ?? 14);
  const singleJob = group.jobs.length === 1 && group.method === "invoice_per_job";

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      customer_id: group.customerId,
      depot_id: group.jobs.find((job) => job.depot_id)?.depot_id ?? customer.depot_id,
      invoice_number: invoiceNumber as string,
      // The type says which shape produced it, which is what makes a register
      // readable when a customer holds both kinds.
      invoice_type: singleJob ? "per_job" : "consolidated",
      status: "draft",
      issue_date: issueDate,
      due_date: addDays(issueDate, terms),
      payment_terms_days: terms,
      purchase_order_number: customer.purchase_order_number,
    })
    .select("id, invoice_number")
    .single();
  if (error) return { ok: false, error: describeDbError(error) };

  // Claim the jobs before writing anything else. This is the row the unique
  // index guards, so a concurrent run that got here first makes this fail —
  // and failing here means no lines and no status change happened.
  const { error: sourceError } = await supabase.from("invoice_source_jobs").insert(
    jobIds.map((orderId) => ({
      tenant_id: session.tenantId,
      created_by: session.userId,
      invoice_id: invoice.id,
      order_id: orderId,
    })),
  );
  if (sourceError) {
    await supabase.from("invoices").delete().eq("id", invoice.id).eq("tenant_id", session.tenantId);
    return {
      ok: false,
      error: sourceError.code === "23505"
        ? "already on another invoice"
        : describeDbError(sourceError),
    };
  }

  const { error: lineError } = await supabase.from("invoice_lines").insert(
    lines.map((entry, index) => ({
      tenant_id: session.tenantId,
      created_by: session.userId,
      invoice_id: invoice.id,
      laundry_order_id: entry.jobId,
      item_id: entry.charge.source_item_id,
      agreement_id: entry.charge.source_agreement_id,
      // Prefixed with the job number on a consolidated invoice so a customer
      // reading fifteen jobs' worth of lines can tell which is which.
      description: singleJob
        ? entry.charge.description
        : `${group.jobs.find((job) => job.id === entry.jobId)?.order_number ?? ""} — ${entry.charge.description}`,
      charge_type: entry.charge.charge_type,
      quantity: entry.charge.quantity,
      unit_price: entry.charge.unit_price,
      amount: entry.charge.amount,
      taxable: entry.charge.taxable,
      sequence: index + 1,
    })),
  );
  if (lineError) return { ok: false, error: describeDbError(lineError) };

  const { error: totalError } = await supabase.rpc("recalculate_invoice", { p_invoice: invoice.id });
  if (totalError) return { ok: false, error: describeDbError(totalError) };

  if (singleJob) {
    const { error: pointerError } = await supabase
      .from("invoices")
      .update({ source_job_id: jobIds[0] })
      .eq("id", invoice.id).eq("tenant_id", session.tenantId);
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
    .from("invoices").select("total").eq("id", invoice.id).maybeSingle<{ total: number }>();

  for (const job of group.jobs) {
    await logOrderActivity(supabase, session, job.id, {
      activity_type: "status_changed",
      previous: { billing_status: "approved" },
      next: { billing_status: "invoice_generated", invoice: invoice.invoice_number },
    });
  }

  return {
    ok: true,
    invoice: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      customerId: group.customerId,
      jobIds,
      total: Number(totals?.total ?? 0),
    },
  };
}

/**
 * Generate invoices for a set of approved jobs.
 *
 * The one entry point, used by the single-job action, the bulk queue action and
 * the recurring run — so a selection of one, a selection of forty and a
 * scheduled sweep cannot drift apart in what they produce.
 *
 * Set-based where it can be: the jobs, their charges and the customers are each
 * read in one query rather than per job. The per-invoice write loop is genuinely
 * per-invoice, because each needs its own number from `next_number()`.
 */
export async function generateInvoicesForJobs(
  supabase: Client,
  session: Session,
  orderIds: readonly string[],
  options: { issueDate: string; respectManual?: boolean } ,
): Promise<GenerationResult> {
  const result: GenerationResult = { created: [], skipped: [] };
  if (orderIds.length === 0) return result;

  const { data: jobs } = await supabase
    .from("laundry_orders")
    .select("id, order_number, customer_id, depot_id, completed_at, billing_status")
    .in("id", [...orderIds])
    .returns<BillableJob[]>();

  const approved = (jobs ?? []).filter((job) => {
    if (job.billing_status === "approved") return true;
    result.skipped.push({
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
      .returns<Array<{
        id: string; billing_method: string; payment_terms_days: number;
        depot_id: string | null; purchase_order_number: string | null;
      }>>(),
    loadChargesForJobs(supabase, approved.map((job) => job.id)),
  ]);

  const customerById = new Map((customers ?? []).map((row) => [row.id, row]));
  const methodByCustomer = new Map<string, BillingMethod>(
    (customers ?? []).map((row) => [
      row.id,
      isBillingMethod(row.billing_method) ? row.billing_method : "monthly_consolidated",
    ]),
  );

  // A scheduled run leaves `manual` customers alone; a person who explicitly
  // selected the jobs has already made the decision `manual` is asking for, so
  // their selection is honoured. That difference is the entire meaning of the
  // setting, and it is the caller who knows which case this is.
  const eligible = options.respectManual
    ? approved.filter((job) => {
        if (methodByCustomer.get(job.customer_id) !== "manual") return true;
        result.skipped.push({ orderNumber: job.order_number, reason: "billed manually" });
        return false;
      })
    : approved;

  for (const group of groupJobsForInvoicing(eligible, methodByCustomer)) {
    const customer = customerById.get(group.customerId);
    if (!customer) {
      for (const job of group.jobs) {
        result.skipped.push({ orderNumber: job.order_number, reason: "customer not found" });
      }
      continue;
    }

    const written = await writeInvoiceForGroup(
      supabase, session, group, chargesByJob, customer, options.issueDate,
    );
    if (!written.ok) {
      for (const job of group.jobs) {
        result.skipped.push({ orderNumber: job.order_number, reason: written.error });
      }
      continue;
    }
    result.created.push(written.invoice);
  }

  if (result.created.length > 0) {
    await recordAudit(session, {
      entity: "invoice", action: "generate",
      summary: `${result.created.length} invoice(s) from ${
        result.created.reduce((sum, entry) => sum + entry.jobIds.length, 0)} job(s)`,
      metadata: {
        invoices: result.created.map((entry) => entry.invoiceNumber),
        skipped: result.skipped.length,
      },
    });
  }

  return result;
}
