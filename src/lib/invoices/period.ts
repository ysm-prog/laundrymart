import type { createClient } from "@/lib/supabase/server";
import { addDays, type IsoDate } from "@/lib/domain/dates";
import { toInstant, toZonedDate } from "@/lib/domain/timezone";
import { billableQuantity } from "@/lib/domain/job-pricing";
import { isBillingStatus, type BillingStatus } from "@/lib/domain/billing";
import { describeItem, type OrderItemInput } from "@/lib/domain/laundry-orders";
import { loadChargesForJobs, type StoredCharge } from "@/lib/orders/job-billing";
import {
  buildServiceBreakdown, consolidateChargeLines, consolidatedSubtotal, itemTotals,
  type BreakdownWeek, type ChargeEntry, type ConsolidatedLine, type ItemTotal,
} from "@/lib/domain/invoice-consolidation";

/**
 * A billing period, read one customer at a time.
 *
 * The question this module answers is the one the client actually asks at month
 * end — *"what do I bill ABC Hotel for August?"* — which is a different question
 * from the review queue's *"what needs pricing?"*. The queue is an unbounded
 * list of every open job; this is a **period**, and a period is what an invoice
 * covers.
 *
 * **A job belongs to a period by when the work finished.** Not when it was taken
 * in, and not when it was due: those are promises, and `completed_at` is the
 * only one of the three that means "billable work done in August". The recurring
 * run has always swept jobs this way, and this module uses the same edges so the
 * two can never disagree about which month a job is in.
 *
 * **The edges are composed in the business timezone, never in UTC.**
 * `completed_at` is a `timestamptz`, so `${end}T23:59:59Z` puts a job finished
 * at 9am Sydney on 1 September onto August's invoice — and does it silently,
 * because the job simply appears on the wrong bill.
 *
 * **Every read here names the tenant, and takes it as a required argument.**
 * RLS scopes an ordinary member to one laundry, but `is_member()` is true of
 * every laundry for a platform admin, and every id on these screens is posted
 * back into a write that *is* tenant-filtered. A list spanning two laundries
 * offers buttons that can only fail. The argument is required rather than
 * optional so the typechecker, not a reviewer, stops the next call site
 * forgetting.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type PeriodRange = { start: IsoDate; end: IsoDate };

/** The half-open instant range a period covers. Exported so the tests can see it. */
export function periodInstants(range: PeriodRange): { from: string; to: string } {
  return { from: toInstant(range.start, "00:00"), to: toInstant(addDays(range.end, 1), "00:00") };
}

/* ------------------------------------------------------- the customer list */

/**
 * Whether a customer's period has been billed.
 *
 * Three states rather than two, because "some of it" is a real and common
 * answer — a customer billed on the 15th who has handed in more laundry since.
 * Reporting that as "invoiced" is how the rest quietly never gets billed.
 */
export type PeriodInvoiceState = "not_invoiced" | "part_invoiced" | "invoiced";

export type PeriodCustomerRow = {
  customerId: string;
  businessName: string;
  billingMethod: string;
  /** Every completed, billable job of theirs in the period. */
  jobCount: number;
  /** Pieces of laundry across those jobs — counted from the job, not the price. */
  itemQuantity: number;
  /** What the priced jobs come to, GST included. Unpriced jobs contribute nothing. */
  value: number;
  /** Jobs whose charges nobody has checked yet. */
  awaitingReview: number;
  /** Approved and not yet on an invoice — what a Generate would pick up. */
  readyToInvoice: number;
  invoicedCount: number;
  state: PeriodInvoiceState;
};

type JobRow = {
  id: string;
  order_number: string;
  customer_id: string;
  completed_at: string | null;
  billing_status: string;
  customers: { id: string; business_name: string; billing_method: string } | null;
};

const INVOICED: readonly BillingStatus[] = ["invoice_generated", "invoice_sent", "paid"];

/**
 * A period's completed jobs, tenant-filtered and ordered oldest first.
 *
 * `not_billable` is excluded rather than shown as zero: a job somebody
 * deliberately marked as not billable is not waiting on anybody, and listing it
 * would make every period look permanently unfinished.
 */
async function loadPeriodJobs(
  supabase: Client, tenantId: string, range: PeriodRange, customerId?: string,
): Promise<JobRow[]> {
  const { from, to } = periodInstants(range);
  let query = supabase
    .from("laundry_orders")
    .select("id, order_number, customer_id, completed_at, billing_status, " +
            "customers(id, business_name, billing_method)")
    .eq("tenant_id", tenantId)
    .eq("status", "completed")
    .neq("billing_status", "not_billable")
    .gte("completed_at", from)
    .lt("completed_at", to)
    .order("completed_at", { ascending: true })
    .limit(2000);
  if (customerId) query = query.eq("customer_id", customerId);
  const { data } = await query.returns<JobRow[]>();
  return data ?? [];
}

/** The laundry on a set of jobs, one read rather than one per job. */
async function loadItemsForJobs(
  supabase: Client, tenantId: string, jobIds: readonly string[],
): Promise<Map<string, OrderItemInput[]>> {
  const byJob = new Map<string, OrderItemInput[]>();
  if (jobIds.length === 0) return byJob;
  const { data } = await supabase
    .from("laundry_order_items")
    .select("order_id, item_id, item_type, custom_description, quantity_type, exact_quantity, " +
            "bag_count, estimated_quantity, notes")
    .eq("tenant_id", tenantId)
    .in("order_id", [...jobIds])
    .returns<Array<OrderItemInput & { order_id: string }>>();
  for (const row of data ?? []) {
    const bucket = byJob.get(row.order_id) ?? [];
    bucket.push(row);
    byJob.set(row.order_id, bucket);
  }
  return byJob;
}

/** Pieces of laundry on a job, however it was measured. Unmeasurable rows count 0. */
function jobItemQuantity(items: readonly OrderItemInput[]): number {
  return items.reduce((sum, item) => sum + (billableQuantity(item) ?? 0), 0);
}

function chargeSubtotal(charges: readonly StoredCharge[]): number {
  return charges.reduce((sum, charge) => sum + Number(charge.amount ?? 0), 0);
}

/**
 * Every customer with billable work in the period, most valuable first.
 *
 * One read of the jobs, one of their laundry and one of their charges — three
 * round trips whatever the customer count, rather than three per customer.
 */
export async function periodBillingSummary(
  supabase: Client, tenantId: string, range: PeriodRange,
): Promise<PeriodCustomerRow[]> {
  const jobs = await loadPeriodJobs(supabase, tenantId, range);
  if (jobs.length === 0) return [];

  const jobIds = jobs.map((job) => job.id);
  const [itemsByJob, chargesByJob] = await Promise.all([
    loadItemsForJobs(supabase, tenantId, jobIds),
    loadChargesForJobs(supabase, jobIds),
  ]);

  const rows = new Map<string, PeriodCustomerRow>();
  for (const job of jobs) {
    const status = isBillingStatus(job.billing_status) ? job.billing_status : "pending";
    const row = rows.get(job.customer_id) ?? {
      customerId: job.customer_id,
      businessName: job.customers?.business_name ?? "Unknown customer",
      billingMethod: job.customers?.billing_method ?? "",
      jobCount: 0, itemQuantity: 0, value: 0,
      awaitingReview: 0, readyToInvoice: 0, invoicedCount: 0,
      state: "not_invoiced" as PeriodInvoiceState,
    };

    row.jobCount += 1;
    row.itemQuantity += jobItemQuantity(itemsByJob.get(job.id) ?? []);
    row.value += chargeSubtotal(chargesByJob.get(job.id) ?? []);
    if (status === "awaiting_review" || status === "pending") row.awaitingReview += 1;
    if (status === "approved") row.readyToInvoice += 1;
    if (INVOICED.includes(status)) row.invoicedCount += 1;

    rows.set(job.customer_id, row);
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      value: Math.round(row.value * 100) / 100,
      state: (row.invoicedCount === 0
        ? "not_invoiced"
        : row.invoicedCount === row.jobCount ? "invoiced" : "part_invoiced") as PeriodInvoiceState,
    }))
    .sort((a, b) => b.value - a.value || a.businessName.localeCompare(b.businessName));
}

/* ----------------------------------------------------- one customer's period */

export type PeriodJob = {
  id: string;
  orderNumber: string;
  /** The business-timezone day the work finished, or null. */
  date: IsoDate | null;
  completedAt: string | null;
  billingStatus: BillingStatus;
  /** True once the job is on an invoice — it takes no further part in a Generate. */
  invoiced: boolean;
  itemQuantity: number;
  /** What the counter wrote down, for the job history. */
  itemLines: Array<{ label: string; quantity: number | null }>;
  charges: StoredCharge[];
  subtotal: number;
};

export type CustomerPeriod = {
  customerId: string;
  businessName: string;
  billingMethod: string;
  range: PeriodRange;
  jobs: PeriodJob[];
  /** Jobs that a Generate would put on an invoice right now. */
  billableJobIds: string[];
  /** The lines the invoice would carry — rolled up per item. */
  lines: ConsolidatedLine[];
  /** The same charges as the audit trail underneath, grouped into weeks. */
  breakdown: BreakdownWeek[];
  /** Quantity per kind of laundry across the period, ignoring rate changes. */
  totals: ItemTotal[];
  subtotal: number;
  awaitingReview: number;
  unpriced: number;
  invoicedCount: number;
};

/**
 * One customer's period: every job, the consolidated lines, and the breakdown.
 *
 * `includeInvoiced` decides whether jobs already on an invoice are carried. They
 * are **out by default** — that is the client's duplicate-billing requirement,
 * and the database refuses the double-bill regardless — but they can be shown,
 * because "why is August short?" is answered by seeing what was already billed.
 *
 * The consolidated lines and the breakdown are always computed from the
 * **billable** jobs only, whatever is shown: an invoice must never quote a total
 * that includes work somebody has already been billed for.
 */
export async function customerPeriodDetail(
  supabase: Client,
  tenantId: string,
  customerId: string,
  range: PeriodRange,
  options: { includeInvoiced?: boolean } = {},
): Promise<CustomerPeriod | null> {
  const rows = await loadPeriodJobs(supabase, tenantId, range, customerId);

  const { data: customer } = await supabase
    .from("customers")
    .select("id, business_name, billing_method")
    .eq("tenant_id", tenantId)
    .eq("id", customerId)
    .maybeSingle<{ id: string; business_name: string; billing_method: string }>();
  if (!customer) return null;

  const jobIds = rows.map((row) => row.id);
  const [itemsByJob, chargesByJob] = await Promise.all([
    loadItemsForJobs(supabase, tenantId, jobIds),
    loadChargesForJobs(supabase, jobIds),
  ]);

  const jobs: PeriodJob[] = rows.map((row) => {
    const status = isBillingStatus(row.billing_status) ? row.billing_status : "pending";
    const items = itemsByJob.get(row.id) ?? [];
    const charges = chargesByJob.get(row.id) ?? [];
    return {
      id: row.id,
      orderNumber: row.order_number,
      date: row.completed_at ? toZonedDate(row.completed_at) : null,
      completedAt: row.completed_at,
      billingStatus: status,
      invoiced: INVOICED.includes(status),
      itemQuantity: jobItemQuantity(items),
      itemLines: items.map((item) => ({
        label: describeItem(item),
        quantity: billableQuantity(item),
      })),
      charges,
      subtotal: Math.round(chargeSubtotal(charges) * 100) / 100,
    };
  });

  const billable = jobs.filter((job) => !job.invoiced);
  const entries: ChargeEntry[] = billable.flatMap((job) =>
    job.charges.map((charge) => ({
      job: { id: job.id, orderNumber: job.orderNumber, date: job.date },
      charge,
    })),
  );

  const lines = consolidateChargeLines(entries);

  return {
    customerId: customer.id,
    businessName: customer.business_name,
    billingMethod: customer.billing_method,
    range,
    jobs: options.includeInvoiced ? jobs : billable,
    billableJobIds: billable.filter((job) => job.billingStatus === "approved").map((job) => job.id),
    lines,
    breakdown: buildServiceBreakdown(entries),
    totals: itemTotals(entries),
    subtotal: consolidatedSubtotal(lines),
    awaitingReview: billable.filter((job) =>
      job.billingStatus === "awaiting_review" || job.billingStatus === "pending").length,
    unpriced: billable.filter((job) => job.charges.length === 0).length,
    invoicedCount: jobs.filter((job) => job.invoiced).length,
  };
}
