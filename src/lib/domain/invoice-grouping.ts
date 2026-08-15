import type { BillingMethod } from "@/lib/domain/billing";

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
  jobs: T[];
};

/**
 * Group approved jobs into the invoices they should become.
 *
 * A per-job customer yields one group per job; a consolidated customer yields
 * exactly one group carrying all of theirs, in the order they arrived.
 *
 * Two customers never share an invoice, whatever their methods.
 *
 * A customer whose method is unknown — missing from the map, or a value the enum
 * does not recognise — is **consolidated**. That is the safe reading of a data
 * gap: the mistake it avoids is a customer suddenly receiving fifteen separate
 * invoices, which is the one they actually notice and complain about.
 * `manual` is treated the same way if it reaches here at all; the callers filter
 * it out of any run that was not a person's explicit selection.
 */
export function groupJobsForInvoicing<T extends GroupableJob>(
  jobs: readonly T[],
  methodByCustomer: ReadonlyMap<string, BillingMethod>,
): Array<InvoiceGroup<T>> {
  const groups: Array<InvoiceGroup<T>> = [];
  const consolidatedByCustomer = new Map<string, InvoiceGroup<T>>();

  for (const job of jobs) {
    const method = methodByCustomer.get(job.customer_id) ?? "monthly_consolidated";

    if (method === "invoice_per_job") {
      groups.push({ customerId: job.customer_id, method, jobs: [job] });
      continue;
    }

    const existing = consolidatedByCustomer.get(job.customer_id);
    if (existing) {
      existing.jobs.push(job);
      continue;
    }
    const group: InvoiceGroup<T> = { customerId: job.customer_id, method, jobs: [job] };
    consolidatedByCustomer.set(job.customer_id, group);
    groups.push(group);
  }

  return groups;
}
