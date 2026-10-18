import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { describeDbError } from "@/lib/actions";
import { voidRefusal } from "@/lib/domain/payment-gate";
import { checkTransition, isOrderStatus } from "@/lib/domain/laundry-orders";
import { jobChargeSubtotal } from "@/lib/domain/job-pricing";
import { TEST_DATA_REASON, matchCustomers } from "@/lib/domain/test-data";
import { logOrderActivity } from "@/lib/orders/activity";
import { loadChargesForJobs, priceAndSaveJob, priceJobFromRateCard } from "@/lib/orders/job-billing";
import { voidOneInvoice } from "@/lib/invoices/void";

/**
 * The two tidy-up tools on Settings › Your records, both **dry run first**: the
 * page renders the plan, and the button that acts appears only beside it. The
 * action re-plans from scratch rather than trusting anything the page posted
 * back, so it does exactly what a fresh dry run would show.
 *
 * Both run on the Owner's own RLS-bound client (`admin.write`), so every write
 * passes the same policies and guards the screens do — nothing here is a door
 * the rest of the app does not have.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

/* ------------------------------------------- 1.3 — price finished jobs ---- */

/** How many jobs one press prices. Enough for a backlog; small enough to finish in one request. */
export const BACKFILL_LIMIT = 50;

export type BackfillCandidate = {
  id: string; orderNumber: string; customerName: string; completedAt: string | null;
  /** What pricing it now would do: price it all, price some of it, or price nothing. */
  outcome: "priced" | "partly" | "nothing";
  lines: number; unpriced: number; subtotal: number;
};

/**
 * The finished jobs still waiting for a price — `completed`, `awaiting_review`,
 * no charges — and what pricing each one now would produce. Read-only: it runs
 * the pricer and writes nothing, which is what makes it a dry run.
 */
export async function planPricingBackfill(
  supabase: Client, tenantId: string,
): Promise<{ candidates: BackfillCandidate[]; total: number }> {
  const { data: jobs } = await supabase
    .from("laundry_orders")
    .select("id, order_number, customer_id, completed_at, customers(business_name)")
    .eq("tenant_id", tenantId)
    .eq("status", "completed")
    .eq("billing_status", "awaiting_review")
    .order("completed_at", { ascending: true })
    .limit(500)
    .returns<Array<{
      id: string; order_number: string; customer_id: string; completed_at: string | null;
      customers: { business_name: string } | null;
    }>>();

  const rows = jobs ?? [];
  const charges = await loadChargesForJobs(supabase, rows.map((row) => row.id));
  const unpricedJobs = rows.filter((row) => (charges.get(row.id) ?? []).length === 0);

  const candidates: BackfillCandidate[] = [];
  for (const job of unpricedJobs.slice(0, BACKFILL_LIMIT)) {
    const priced = await priceJobFromRateCard(supabase, tenantId, job);
    candidates.push({
      id: job.id, orderNumber: job.order_number,
      customerName: job.customers?.business_name ?? "Unknown customer",
      completedAt: job.completed_at,
      outcome: priced.lines.length === 0 ? "nothing" : priced.unpriced.length > 0 ? "partly" : "priced",
      lines: priced.lines.length, unpriced: priced.unpriced.length,
      subtotal: jobChargeSubtotal(priced.lines),
    });
  }
  return { candidates, total: unpricedJobs.length };
}

/**
 * Price them. The same `priceAndSaveJob` the Price button runs, one job at a
 * time, so each job is priced, logged and audited exactly as if somebody had
 * pressed the button on it. **It never approves** — a person still checks and
 * approves every one.
 */
export async function runPricingBackfill(
  supabase: Client, session: Session,
): Promise<{ priced: number; needsPrice: number; failed: string[] }> {
  const { candidates } = await planPricingBackfill(supabase, session.tenantId);
  let priced = 0;
  let needsPrice = 0;
  const failed: string[] = [];
  for (const candidate of candidates) {
    const result = await priceAndSaveJob(supabase, session, candidate.id);
    if (result.ok) {
      if (result.unpriced > 0) needsPrice += 1; else priced += 1;
    } else if (candidate.outcome === "nothing") {
      // Nothing could be priced, which the dry run said; it is now on the
      // Needs a price list (priceAndSaveJob marked it). Not a failure.
      needsPrice += 1;
    } else {
      failed.push(result.error);
    }
  }
  await recordAudit(session, {
    entity: "tenant", entityId: session.tenantId, action: "update",
    summary: `Priced finished jobs: ${priced} priced, ${needsPrice} need a price`,
    metadata: { priced, needs_price: needsPrice, failed: failed.length },
  });
  return { priced, needsPrice, failed };
}

/* -------------------------------------------- 1.8 — test-data clean-up ---- */

const OPEN_JOB = ["new", "in_progress", "ready_for_delivery", "assigned", "out_for_delivery"];

export type CleanupPlan = {
  customers: Array<{
    id: string; number: string; name: string; status: string;
    voids: Array<{ id: string; number: string; status: string; total: number }>;
    blocked: Array<{ number: string; reason: string }>;
    cancels: Array<{ id: string; number: string; status: string }>;
    writeOffs: Array<{ id: string; number: string; billing: string }>;
  }>;
  notFound: string[];
  /** Jobs still waiting on a round from before the cutoff, from any customer. */
  lateAssigned: Array<{ id: string; number: string; customer: string; date: string | null }>;
  cutoff: string;
};

/** What the clean-up would do with these entries. Reads only. */
export async function planTestDataCleanup(
  supabase: Client, tenantId: string, entries: readonly string[], cutoff: string,
): Promise<CleanupPlan> {
  const [{ data: customerRows }, { data: late }] = await Promise.all([
    supabase.from("customers")
      .select("id, customer_number, business_name, status")
      .eq("tenant_id", tenantId)
      .returns<Array<{ id: string; customer_number: string; business_name: string; status: string }>>(),
    supabase.from("laundry_orders")
      .select("id, order_number, assigned_delivery_date, customers(business_name)")
      .eq("tenant_id", tenantId)
      .eq("status", "assigned")
      .lt("assigned_delivery_date", cutoff)
      .order("assigned_delivery_date", { ascending: true })
      .limit(200)
      .returns<Array<{
        id: string; order_number: string; assigned_delivery_date: string | null;
        customers: { business_name: string } | null;
      }>>(),
  ]);

  const { matched, notFound } = entries.length > 0
    ? matchCustomers(entries, customerRows ?? [])
    : { matched: [], notFound: [] };
  const ids = matched.map((customer) => customer.id);

  const [{ data: invoices }, { data: jobs }] = ids.length === 0
    ? [{ data: [] }, { data: [] }]
    : await Promise.all([
        supabase.from("invoices")
          .select("id, customer_id, invoice_number, status, total, amount_paid")
          .eq("tenant_id", tenantId).in("customer_id", ids).neq("status", "void")
          .returns<Array<{ id: string; customer_id: string; invoice_number: string; status: string; total: number; amount_paid: number }>>(),
        supabase.from("laundry_orders")
          .select("id, customer_id, order_number, status, billing_status")
          .eq("tenant_id", tenantId).in("customer_id", ids)
          .returns<Array<{ id: string; customer_id: string; order_number: string; status: string; billing_status: string }>>(),
      ]);

  const invoiceIds = (invoices ?? []).map((invoice) => invoice.id);
  const [{ data: payments }, { data: credits }] = invoiceIds.length === 0
    ? [{ data: [] }, { data: [] }]
    : await Promise.all([
        supabase.from("payments").select("invoice_id").eq("tenant_id", tenantId).in("invoice_id", invoiceIds)
          .returns<Array<{ invoice_id: string }>>(),
        supabase.from("credit_notes").select("invoice_id").eq("tenant_id", tenantId)
          .in("invoice_id", invoiceIds).in("status", ["issued", "applied"])
          .returns<Array<{ invoice_id: string }>>(),
      ]);
  const count = (rows: Array<{ invoice_id: string }> | null, id: string) =>
    (rows ?? []).filter((row) => row.invoice_id === id).length;

  return {
    customers: matched.map((customer) => {
      const theirs = (invoices ?? []).filter((invoice) => invoice.customer_id === customer.id);
      const voids: CleanupPlan["customers"][number]["voids"] = [];
      const blocked: CleanupPlan["customers"][number]["blocked"] = [];
      for (const invoice of theirs) {
        const refusal = voidRefusal({
          status: invoice.status, amountPaid: Number(invoice.amount_paid),
          paymentCount: count(payments, invoice.id), creditNoteCount: count(credits, invoice.id),
        });
        if (refusal) blocked.push({ number: invoice.invoice_number, reason: refusal });
        else voids.push({ id: invoice.id, number: invoice.invoice_number, status: invoice.status, total: Number(invoice.total) });
      }
      const theirJobs = (jobs ?? []).filter((job) => job.customer_id === customer.id);
      return {
        id: customer.id, number: customer.customer_number, name: customer.business_name,
        status: (customerRows ?? []).find((row) => row.id === customer.id)?.status ?? "",
        voids, blocked,
        cancels: theirJobs.filter((job) => OPEN_JOB.includes(job.status))
          .map((job) => ({ id: job.id, number: job.order_number, status: job.status })),
        writeOffs: theirJobs
          .filter((job) => job.status === "completed" && ["awaiting_review", "approved"].includes(job.billing_status))
          .map((job) => ({ id: job.id, number: job.order_number, billing: job.billing_status })),
      };
    }),
    notFound,
    lateAssigned: (late ?? []).map((job) => ({
      id: job.id, number: job.order_number,
      customer: job.customers?.business_name ?? "Unknown customer", date: job.assigned_delivery_date,
    })),
    cutoff,
  };
}

export type CleanupResult = {
  voided: number; writtenOff: number; cancelled: number; archived: number; closed: number;
  problems: string[];
};

/** Cancel one job with a reason, through the same transition rule the screens use. */
async function cancelJob(
  supabase: Client, session: Session, job: { id: string; number: string; status: string }, reason: string,
): Promise<string | null> {
  if (!isOrderStatus(job.status)) return `${job.number}: its status could not be read.`;
  const allowed = checkTransition(job.status, "cancelled", true);
  if (!allowed.ok) return `${job.number}: ${allowed.reason}`;
  const { error } = await supabase
    .from("laundry_orders")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancellation_reason: reason })
    .eq("id", job.id).eq("tenant_id", session.tenantId);
  if (error) return `${job.number}: ${describeDbError(error)}`;
  await logOrderActivity(supabase, session, job.id, {
    activity_type: "cancelled", previous: { status: job.status }, next: { status: "cancelled" }, note: reason,
  });
  return null;
}

/**
 * Do it. Invoices first — voided, never deleted, and their jobs written off
 * rather than put back in the queue (`rebill: false`, brief 1.6); then the
 * finished jobs still waiting to be billed; then the open jobs; then the
 * customers, archived the way the customer screen archives one. The late
 * assigned jobs are closed only when the person ticked that box.
 */
export async function runTestDataCleanup(
  supabase: Client, session: Session, plan: CleanupPlan, options: { closeLate: boolean },
): Promise<CleanupResult> {
  const result: CleanupResult = { voided: 0, writtenOff: 0, cancelled: 0, archived: 0, closed: 0, problems: [] };

  for (const customer of plan.customers) {
    for (const invoice of customer.voids) {
      const outcome = await voidOneInvoice(supabase, session, invoice.id, { reason: TEST_DATA_REASON, rebill: false });
      if (!outcome.ok) { result.problems.push(outcome.error); continue; }
      result.voided += 1;
      result.writtenOff += outcome.release.excluded;
      if (!outcome.release.ok) result.problems.push(`${invoice.number}: ${outcome.release.error}`);
    }
    for (const invoice of customer.blocked) result.problems.push(`${invoice.number}: ${invoice.reason}`);

    if (customer.writeOffs.length > 0) {
      const { data, error } = await supabase
        .from("laundry_orders")
        .update({ billing_status: "not_billable", billing_exclusion_reason: TEST_DATA_REASON, billing_hold_reason: null })
        .in("id", customer.writeOffs.map((job) => job.id))
        .eq("tenant_id", session.tenantId)
        .in("billing_status", ["awaiting_review", "approved"])
        .select("id");
      if (error) result.problems.push(`${customer.name}: ${describeDbError(error)}`);
      result.writtenOff += data?.length ?? 0;
    }

    for (const job of customer.cancels) {
      const problem = await cancelJob(supabase, session, job, TEST_DATA_REASON);
      if (problem) result.problems.push(problem); else result.cancelled += 1;
    }

    const { error: archiveError } = await supabase
      .from("customers")
      .update({ status: "archived", deleted_at: new Date().toISOString() })
      .eq("id", customer.id).eq("tenant_id", session.tenantId);
    if (archiveError) result.problems.push(`${customer.name}: ${describeDbError(archiveError)}`);
    else result.archived += 1;
  }

  if (options.closeLate) {
    for (const job of plan.lateAssigned) {
      const problem = await cancelJob(supabase, session, { ...job, status: "assigned" },
        `Closed in the clean-up: still waiting on a round from ${job.date ?? "an earlier day"}`);
      if (problem) result.problems.push(problem); else result.closed += 1;
    }
  }

  await recordAudit(session, {
    entity: "tenant", entityId: session.tenantId, action: "update",
    summary: `Test data cleared: ${result.archived} customers archived, ${result.voided} invoices voided, `
      + `${result.cancelled} jobs cancelled, ${result.writtenOff} written off, ${result.closed} late jobs closed`,
    metadata: {
      customers: plan.customers.map((customer) => customer.number),
      problems: result.problems.length, close_late: options.closeLate,
    },
  });
  return result;
}
