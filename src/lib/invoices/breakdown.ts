import type { createClient } from "@/lib/supabase/server";
import { toZonedDate } from "@/lib/domain/timezone";
import { loadChargesForJobs } from "@/lib/orders/job-billing";
import {
  buildServiceBreakdown, itemTotals,
  type BreakdownWeek, type ChargeEntry, type ItemTotal,
} from "@/lib/domain/invoice-consolidation";

/**
 * The service breakdown behind a consolidated invoice.
 *
 * A rolled-up invoice says *"Towels 1,450"*. This is the other half the client
 * asked for: **which weeks, which days, which jobs** those 1,450 towels came
 * from — so the customer gets both a total they can pay and an audit trail they
 * can query.
 *
 * **It reads no new table.** The breakdown already exists, frozen at approval,
 * one row per job per item in `job_charge_snapshots`, and the invoice already
 * names its jobs in `invoice_source_jobs`. Storing a second copy on the invoice
 * would be a second thing to keep in step with the first — the duplication this
 * codebase argues against everywhere else — and it would be the copy that goes
 * stale.
 *
 *     invoice ──► invoice_source_jobs ──► laundry_orders ──► job_charge_snapshots
 *
 * Empty for a per-job invoice and for a manual one: there is nothing to break
 * down when the invoice already *is* the detail, and the caller renders nothing.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type InvoiceBreakdown = {
  weeks: BreakdownWeek[];
  totals: ItemTotal[];
  jobCount: number;
};

export async function loadInvoiceBreakdown(
  supabase: Client, tenantId: string, invoiceId: string,
): Promise<InvoiceBreakdown> {
  const empty: InvoiceBreakdown = { weeks: [], totals: [], jobCount: 0 };

  const { data: sources } = await supabase
    .from("invoice_source_jobs")
    .select("order_id")
    .eq("tenant_id", tenantId)
    .eq("invoice_id", invoiceId)
    .returns<Array<{ order_id: string }>>();

  const orderIds = (sources ?? []).map((row) => row.order_id);
  if (orderIds.length === 0) return empty;

  const { data: jobs } = await supabase
    .from("laundry_orders")
    .select("id, order_number, completed_at")
    .eq("tenant_id", tenantId)
    .in("id", orderIds)
    .returns<Array<{ id: string; order_number: string; completed_at: string | null }>>();

  const charges = await loadChargesForJobs(supabase, orderIds);

  // Oldest first, so the weeks read forwards.
  const ordered = [...(jobs ?? [])].sort((a, b) =>
    (a.completed_at ?? "").localeCompare(b.completed_at ?? "")
    || a.order_number.localeCompare(b.order_number));

  const entries: ChargeEntry[] = ordered.flatMap((job) =>
    (charges.get(job.id) ?? []).map((charge) => ({
      job: {
        id: job.id,
        orderNumber: job.order_number,
        date: job.completed_at ? toZonedDate(job.completed_at) : null,
      },
      charge,
    })),
  );

  if (entries.length === 0) return empty;

  return {
    weeks: buildServiceBreakdown(entries),
    totals: itemTotals(entries),
    jobCount: ordered.length,
  };
}
