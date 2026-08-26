import type { BillingMethod } from "@/lib/domain/billing";
import type { BillingPeriod } from "@/lib/domain/billing-period";

/**
 * Which invoices a set of approved jobs should become. No database in sight.
 *
 * **The architectural decision of phase 7, isolated.** A completed job is a
 * *billable source*, and whether August produces fifteen invoices or one is
 * answered here, from one column on the customer:
 *
 *     Job ─────────────────────────► Invoice        (invoice_per_job)
 *
 *     Job 1 ┐
 *     Job 2 ├──────────────────────► Invoice        (…_consolidated)
 *     Job 3 ┘
 *
 * **A consolidated group is keyed on the customer *and the period*.** Without
 * the second half, a selection spanning July and August would roll two months
 * onto one invoice — and, worse, a consolidated customer would get one invoice
 * per *button press* rather than one per period, which is exactly the defect
 * `0040_open_draft_invoices` exists to close. A caller that has no period rule
 * to offer (there is none for `invoice_per_job`, and none is wanted by the
 * pre-existing single-shot callers) omits `periodOf` and gets the old shape back
 * unchanged: one group per customer, carrying no period.
 *
 * It lives in `lib/domain/` rather than beside the writer in
 * `lib/invoices/from-jobs.ts` for the reason `plan.ts` does: that module reaches
 * `recordAudit` → `lib/supabase/server` → `lib/env`, which throws without a
 * configured environment, so a rule stated there is a rule no unit test can
 * reach. This repo has shipped two contracts broken behind a green `verify` for
 * exactly that reason, and the fix is always the same — put the rule somewhere
 * with no I/O in its import graph.
 */

/** The minimum a job has to say about itself to be grouped. */
export type GroupableJob = {
  id: string;
  order_number: string;
  customer_id: string;
};

export type InvoiceGroup<T extends GroupableJob> = {
  customerId: string;
  method: BillingMethod;
  /**
   * The billing period this group's invoice covers, or `null` when the caller
   * offered no period rule and the group is therefore a single-shot invoice.
   * When it is set it is half of the group's identity, and half of the key the
   * running draft is found by.
   */
  period: BillingPeriod | null;
  jobs: T[];
};

/**
 * Group approved jobs into the invoices they should become.
 *
 * A per-job customer yields one group per job; a consolidated customer yields
 * one group per **period** carrying all of theirs in it, in the order they
 * arrived. Omit `periodOf` and every consolidated customer collapses to a single
 * periodless group, which is what this function did before the running draft
 * existed and what the callers that bill one explicit selection still want.
 *
 * Two customers never share an invoice, whatever their methods, and neither do
 * two periods.
 *
 * A customer whose method is unknown — missing from the map, or a value the enum
 * does not recognise — is **consolidated**. That is the safe reading of a data
 * gap: the mistake it avoids is a customer suddenly receiving fifteen separate
 * invoices, which is the one they actually notice and complain about.
 * `manual` is treated the same way if it reaches here at all; the callers filter
 * it out of any run that was not a person's explicit selection.
 *
 * A consolidated job for which `periodOf` returns `null` — a job that never
 * finished, so nothing can say which month it belongs to — falls back to the
 * customer's periodless group rather than being dropped. Losing a job silently
 * is the one outcome worse than putting it on an invoice somebody has to look at.
 */
export function groupJobsForInvoicing<T extends GroupableJob>(
  jobs: readonly T[],
  methodByCustomer: ReadonlyMap<string, BillingMethod>,
  periodOf?: (job: T, method: BillingMethod) => BillingPeriod | null,
): Array<InvoiceGroup<T>> {
  const groups: Array<InvoiceGroup<T>> = [];
  const consolidatedByKey = new Map<string, InvoiceGroup<T>>();

  for (const job of jobs) {
    const method = methodByCustomer.get(job.customer_id) ?? "monthly_consolidated";

    if (method === "invoice_per_job") {
      groups.push({ customerId: job.customer_id, method, period: null, jobs: [job] });
      continue;
    }

    const period = periodOf ? periodOf(job, method) : null;
    const key = period
      ? `${job.customer_id}|${period.start}|${period.end}`
      : `${job.customer_id}|-`;

    const existing = consolidatedByKey.get(key);
    if (existing) {
      existing.jobs.push(job);
      continue;
    }
    const group: InvoiceGroup<T> = { customerId: job.customer_id, method, period, jobs: [job] };
    consolidatedByKey.set(key, group);
    groups.push(group);
  }

  return groups;
}
