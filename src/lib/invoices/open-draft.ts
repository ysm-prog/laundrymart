import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { describeDbError } from "@/lib/actions";
import { addDays } from "@/lib/domain/dates";
import { toZonedDate } from "@/lib/domain/timezone";
import type { BillingPeriod } from "@/lib/domain/billing-period";
import {
  jobInvoiceLines, type ChargeEntry, type InvoiceLineDraft,
} from "@/lib/domain/invoice-consolidation";
import { accountLookupsFor, resolveChargeAccount } from "@/lib/invoices/account-coding";
import { loadChargesForJobs } from "@/lib/orders/job-billing";

/**
 * The running draft: one open invoice per customer per billing period.
 *
 * **What this exists to make true.** A job's approved charges land on the
 * customer's invoice for the month *at the moment they are approved*, and the
 * next job the same customer sends in joins the same invoice rather than
 * starting a second one. The owner closes it when they choose — the 31st, the
 * 9th, twice in a month — and the next approval opens a fresh one.
 *
 *     approve LJ00007 ─┐
 *                      ├──► INV00042 · draft · Acme · August ──► issue ──► sent
 *     approve LJ00011 ─┘         (towels merged, levies kept apart)
 *
 * Before this, `generateInvoicesForJobs` always **inserted**: a consolidated
 * customer got one invoice per *button press*, so approving on the 3rd and again
 * on the 11th produced two August invoices. Nothing was billed twice —
 * `uq_invoice_source_jobs_once` saw to that — the month was simply split across
 * two documents.
 *
 * **This module is the only way an invoice comes into existence from a job.**
 * `from-jobs.ts` used to insert one itself whenever a group had no period — a
 * per-job customer, or a `manual` one — so pressing Approve could mint a whole
 * invoice document straight off a job. There is one door now, and everything it
 * opens is a `draft`: the job's money reaches a customer only when somebody
 * issues that draft.
 *
 * Four rules run through everything here:
 *
 * - **The draft is found in the database, not remembered.** `uq_invoices_open_draft`
 *   (0040) is what makes "one open draft" a fact; the lookup below is the fast
 *   path, and losing the race is handled by reading again rather than by failing.
 * - **Job lines are rebuilt, never patched.** Adding a job re-derives every
 *   job-origin line on the invoice from the frozen charges of *all* the jobs it
 *   bills. That is what makes 100 towels plus 50 towels one line of 150 instead
 *   of two lines, and it is why `invoice_lines.origin` exists: a line somebody
 *   typed by hand must survive the rebuild untouched.
 * - **Nothing here re-prices anything.** Every number comes from
 *   `job_charge_snapshots`, frozen at approval. This module moves money onto a
 *   document; it never decides what the money is.
 * - **A draft without a period is still a draft.** A per-job customer's job is
 *   its own document, so there is no window to key it on and nothing to find —
 *   it opens, once, and is issued from the drafts board like every other.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

/** What opening a draft needs to know about the customer it belongs to. */
export type DraftCustomer = {
  id: string;
  payment_terms_days: number | null;
  depot_id: string | null;
  purchase_order_number: string | null;
};

export type OpenDraft = {
  id: string;
  invoiceNumber: string;
  /** True when this call created it, which is what the caller reports. */
  opened: boolean;
};

/* --------------------------------------------------------- find the draft */

/**
 * The customer's open draft for this period, or null.
 *
 * The predicate mirrors `uq_invoices_open_draft` exactly — status, type, both
 * period ends and `deleted_at`. It has to: a lookup narrower than the index
 * would miss a draft the index then refuses to let us open, and a lookup wider
 * than the index would hand back an invoice nothing stops a second copy of.
 *
 * **`deleted_at` is named here and `archived_at` is not**, and the asymmetry is
 * the point rather than an oversight. The index excludes both; RLS already
 * excludes archived rows from every read (0017 appends `archived_at is null` to
 * each policy), so asking again would be noise. Nothing excludes a *soft-deleted*
 * one — no policy mentions the column — so without this clause a draft somebody
 * deleted would be found and joined, and the next approval's charges would land
 * on it. Dormant today (nothing in `src/` writes `deleted_at` on an invoice, and
 * the live project holds none), which is exactly when a predicate that disagrees
 * with its index is cheap to correct.
 */
export async function findOpenDraft(
  supabase: Client, tenantId: string, customerId: string, period: BillingPeriod,
): Promise<{ id: string; invoice_number: string } | null> {
  const { data } = await supabase
    .from("invoices")
    .select("id, invoice_number")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "draft")
    .eq("invoice_type", "consolidated")
    .eq("period_start", period.start)
    .eq("period_end", period.end)
    .is("deleted_at", null)
    .maybeSingle<{ id: string; invoice_number: string }>();
  return data ?? null;
}

/**
 * The customer's open draft for this period, opening one if there is none.
 *
 * **The race is real and is handled by re-reading, not by locking.** Two
 * reviewers approving two jobs for the same customer in the same second both
 * find nothing and both try to insert; the unique index lets one through and
 * gives the other `23505`, which is answered by looking again and joining the
 * winner. The cost is one burnt invoice number in that rare case, which is the
 * right trade against a lock held across an HTTP request.
 */
export async function findOrOpenDraft(
  supabase: Client,
  session: Session,
  customer: DraftCustomer,
  period: BillingPeriod | null,
  issueDate: string,
  /**
   * `per_job` opens a document for one job and nothing else — a per-job
   * customer's shape. It is passed rather than derived because only the caller
   * knows *why* there is no period: a per-job customer has none by design, and a
   * job with no completion date has none by accident, and those must not produce
   * the same kind of invoice.
   */
  shape: "consolidated" | "per_job" = "consolidated",
): Promise<{ ok: true; draft: OpenDraft } | { ok: false; error: string }> {
  const existing = period
    ? await findOpenDraft(supabase, session.tenantId, customer.id, period)
    : null;
  if (existing) {
    return { ok: true, draft: { id: existing.id, invoiceNumber: existing.invoice_number, opened: false } };
  }

  const { data: invoiceNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "invoice", p: "INV" });
  if (numberError) return { ok: false, error: describeDbError(numberError) };

  const terms = Number(customer.payment_terms_days ?? 14);
  const { data: created, error } = await supabase
    .from("invoices")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      customer_id: customer.id,
      depot_id: customer.depot_id,
      invoice_number: invoiceNumber as string,
      // `consolidated` and not `recurring`, because after 0040 one invoice can
      // hold both job charges and contract charges and one type cannot describe
      // both. Which is which is a property of the *line* now (`origin`).
      // `per_job` is the one exception and says the opposite: this document was
      // opened for a single job and no second one will join it.
      invoice_type: shape,
      status: "draft",
      // Provisional while the draft is open, and re-stamped the day it is
      // actually issued — see `issueOneInvoice`. A draft opened on the 3rd with
      // 14-day terms would otherwise reach the customer on the 31st already a
      // fortnight overdue.
      issue_date: issueDate,
      due_date: addDays(issueDate, terms),
      payment_terms_days: terms,
      purchase_order_number: customer.purchase_order_number,
      period_start: period?.start ?? null,
      period_end: period?.end ?? null,
    })
    .select("id, invoice_number")
    .maybeSingle<{ id: string; invoice_number: string }>();

  if (error) {
    // Only the periodic shape can lose this race: `uq_invoices_open_draft` is
    // partial on both period ends, so a period-less draft is outside it and a
    // 23505 there is some other constraint entirely.
    if (error.code === "23505" && period) {
      const winner = await findOpenDraft(supabase, session.tenantId, customer.id, period);
      if (winner) {
        return { ok: true, draft: { id: winner.id, invoiceNumber: winner.invoice_number, opened: false } };
      }
    }
    return { ok: false, error: describeDbError(error) };
  }
  if (!created) return { ok: false, error: "the draft invoice could not be opened" };

  return { ok: true, draft: { id: created.id, invoiceNumber: created.invoice_number, opened: true } };
}

/* ------------------------------------------------------- rebuild the lines */

type SourceJob = { id: string; order_number: string; completed_at: string | null };

/**
 * Re-derive every job-origin line on an invoice from the jobs it bills.
 *
 * Delete-and-rewrite rather than a diff, and that is a decision rather than
 * laziness. Consolidated lines are *sums* of frozen amounts; patching one would
 * mean recomputing it from a quantity and a unit price, and the cent that comes
 * back is not guaranteed to be the cent the snapshots add up to. Re-deriving the
 * whole set from the same rows by the same rule cannot drift from the breakdown
 * printed underneath it, because both are computed from those rows.
 *
 * **Lines the generator did not write are not touched.** `origin = 'manual'` is
 * somebody's typing and `origin = 'contract'` is the recurring run's; only
 * `'job'` is re-derivable and only `'job'` is deleted. They are re-sequenced
 * after the job lines so the invoice reads laundry first, in a stable order.
 *
 * Refused unless the invoice is a draft. The database refuses it too — 0040's
 * `guard_invoice_line_draft_only` — and this is the sentence in front of it.
 */
export async function rebuildJobLines(
  supabase: Client, session: Session, invoiceId: string,
): Promise<{ ok: true; lines: number; subtotal: number } | { ok: false; error: string }> {
  // **Two passes at most, and the second exists for one specific race.** Two
  // approvals landing on the same draft each claim their job and then rebuild.
  // If the first reads the source list *before* the second's claim and writes
  // *after* it, the second job's charges are on the invoice's job list and not
  // on its lines — a document that under-bills and says nothing. Re-reading the
  // claim count after writing catches exactly that, and one retry is enough
  // because the second pass reads a list that already contains both.
  //
  // Not airtight: a third claim landing inside the retry would need a third
  // pass. Closing it completely means doing the whole rebuild inside one
  // statement, which is a database function and a bigger change than the window
  // justifies — and the failure it leaves is visible (the invoice's job list and
  // its lines disagree) rather than silent money.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pass = await rebuildOnce(supabase, session, invoiceId);
    if (!pass.ok) return pass;
    if (!pass.stale) return { ok: true, lines: pass.lines, subtotal: pass.subtotal };
  }
  // Both passes saw the list move. Report it rather than looping: something is
  // writing to this invoice faster than it can be read back, and a rebuild loop
  // is not the place to find out what.
  return { ok: false, error: "that invoice changed while its lines were being written" };
}

async function rebuildOnce(
  supabase: Client, session: Session, invoiceId: string,
): Promise<
  { ok: true; lines: number; subtotal: number; stale: boolean } | { ok: false; error: string }
> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, status, invoice_type")
    .eq("id", invoiceId)
    .eq("tenant_id", session.tenantId)
    .maybeSingle<{ id: string; status: string; invoice_type: string }>();
  if (!invoice) return { ok: false, error: "that invoice could not be found" };
  if (invoice.status !== "draft") {
    return { ok: false, error: "that invoice is no longer a draft, so its lines cannot change" };
  }

  const { data: sources } = await supabase
    .from("invoice_source_jobs")
    .select("order_id")
    .eq("invoice_id", invoiceId)
    .eq("tenant_id", session.tenantId)
    .returns<Array<{ order_id: string }>>();
  const orderIds = (sources ?? []).map((row) => row.order_id);

  const [{ data: jobs }, chargesByJob] = await Promise.all([
    orderIds.length === 0
      ? Promise.resolve({ data: [] as SourceJob[] })
      : supabase
        .from("laundry_orders")
        .select("id, order_number, completed_at")
        .in("id", orderIds)
        .eq("tenant_id", session.tenantId)
        .returns<SourceJob[]>(),
    loadChargesForJobs(supabase, orderIds),
  ]);

  // Chronological, so the un-mergeable lines (a levy, a surcharge) read in the
  // order the work happened and each item takes the position it was first seen.
  // A job with no completion date sorts last rather than first: ￿ is above every
  // digit, the same sentinel `buildServiceBreakdown` uses.
  const ordered = [...(jobs ?? [])].sort((a, b) =>
    (a.completed_at ?? "￿").localeCompare(b.completed_at ?? "￿")
    || a.order_number.localeCompare(b.order_number));

  /*
   * **Resolved before consolidation, not after, and the order is the point.**
   * `consolidationKey` carries the account, so two towel charges at one rate —
   * one carrying its item's account and one carrying nothing — used to key
   * differently (`acct:<id>` against `acct:none`) and come out as two lines that
   * were then written with the *same* account. Resolving first makes the key
   * honest, so they merge into the one line the customer should read.
   */
  const lookups = await accountLookupsFor(
    supabase, session.tenantId, [...chargesByJob.values()].flat(),
  );

  const entries: ChargeEntry[] = ordered.flatMap((job) =>
    (chargesByJob.get(job.id) ?? []).map((charge) => ({
      job: {
        id: job.id,
        orderNumber: job.order_number,
        date: job.completed_at ? toZonedDate(job.completed_at) : null,
      },
      charge: { ...charge, gl_account_id: resolveChargeAccount(charge, lookups) },
    })));

  const lines: InvoiceLineDraft[] = jobInvoiceLines(entries, {
    perJob: invoice.invoice_type === "per_job",
  });

  const { error: clearError } = await supabase
    .from("invoice_lines")
    .delete()
    .eq("invoice_id", invoiceId)
    .eq("tenant_id", session.tenantId)
    .eq("origin", "job");
  if (clearError) return { ok: false, error: describeDbError(clearError) };

  if (lines.length > 0) {
    const { error: insertError } = await supabase.from("invoice_lines").insert(
      lines.map((line, index) => ({
        tenant_id: session.tenantId,
        created_by: session.userId,
        invoice_id: invoiceId,
        laundry_order_id: line.jobId,
        item_id: line.source_item_id,
        // Already resolved, above, through the whole ladder — the charge's own
        // account (0039), then the item's, then the charge type's default (0044).
        gl_account_id: line.gl_account_id,
        agreement_id: line.source_agreement_id,
        description: line.description,
        charge_type: line.charge_type,
        quantity: line.quantity,
        unit_price: line.unit_price,
        amount: line.amount,
        taxable: line.taxable,
        origin: "job",
        sequence: index + 1,
      })),
    );
    if (insertError) return { ok: false, error: describeDbError(insertError) };
  }

  await resequenceNonJobLines(supabase, session, invoiceId, lines.length);

  const { error: totalError } = await supabase
    .rpc("recalculate_invoice", { p_invoice: invoiceId });
  if (totalError) return { ok: false, error: describeDbError(totalError) };

  // Did the invoice's job list move while this pass was writing? See the note on
  // `rebuildJobLines`.
  const { count: after } = await supabase
    .from("invoice_source_jobs")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", invoiceId)
    .eq("tenant_id", session.tenantId);

  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  return {
    ok: true, lines: lines.length, subtotal,
    stale: (after ?? orderIds.length) !== orderIds.length,
  };
}

/**
 * Push the contract and hand-written lines after the job lines.
 *
 * Cheap because there are almost never any: a laundry invoice is job lines, and
 * a typed line is the exception. Doing it at all is what stops the invoice
 * re-ordering itself every time a job joins — `addInvoiceLine` numbers from the
 * line count at the time, so a manual line added when there were nine lines sits
 * at 10 and would interleave once a rebuild produced six.
 *
 * Best-effort: a failure here is cosmetic, and failing the placement over the
 * order of a line nobody has looked at yet would be the wrong trade.
 */
async function resequenceNonJobLines(
  supabase: Client, session: Session, invoiceId: string, offset: number,
): Promise<void> {
  const { data: others } = await supabase
    .from("invoice_lines")
    .select("id, origin, sequence")
    .eq("invoice_id", invoiceId)
    .eq("tenant_id", session.tenantId)
    .neq("origin", "job")
    .order("sequence")
    .returns<Array<{ id: string; origin: string; sequence: number }>>();
  if (!others || others.length === 0) return;

  // Contract charges before typed ones: the first are part of what was agreed,
  // the second are an adjustment to it.
  const rank = (origin: string) => (origin === "contract" ? 0 : 1);
  const sorted = [...others].sort((a, b) => rank(a.origin) - rank(b.origin) || a.sequence - b.sequence);

  for (const [index, line] of sorted.entries()) {
    const next = offset + index + 1;
    if (line.sequence === next) continue;
    await supabase
      .from("invoice_lines")
      .update({ sequence: next })
      .eq("id", line.id)
      .eq("tenant_id", session.tenantId);
  }
}

/* -------------------------------------------------------- take a job off it */

export type RemovalResult =
  | { ok: true; invoiceNumber: string; orderNumber: string; remaining: number }
  | { ok: false; error: string };

/**
 * Take one job back off a draft.
 *
 * The reverse gear the running draft needs. Before this the only way to get a
 * job off an invoice was to **void** it, which releases *every* job on it — so
 * correcting the twelfth job on a draft meant undoing the other eleven,
 * re-approving them and generating again.
 *
 * The job returns to `approved` and reappears in the queue; the draft's lines are
 * rebuilt without it. A draft whose last job is removed is left in place, empty,
 * rather than deleted: its number has been on a screen, and silently reusing an
 * invoice number is how a finance record grows a hole nobody can explain.
 */
export async function removeJobFromDraft(
  supabase: Client, session: Session, invoiceId: string, orderId: string,
): Promise<RemovalResult> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, invoice_number, status")
    .eq("id", invoiceId)
    .eq("tenant_id", session.tenantId)
    .maybeSingle<{ id: string; invoice_number: string; status: string }>();
  if (!invoice) return { ok: false, error: "That invoice could not be found." };
  if (invoice.status !== "draft") {
    return {
      ok: false,
      error: "This invoice is no longer a draft. Void it if the charges were wrong — "
        + "that releases every job on it to be billed again.",
    };
  }

  const { data: job } = await supabase
    .from("laundry_orders")
    .select("id, order_number, billing_status")
    .eq("id", orderId)
    .eq("tenant_id", session.tenantId)
    .maybeSingle<{ id: string; order_number: string; billing_status: string }>();
  if (!job) return { ok: false, error: "That job could not be found." };

  const { data: unlinked, error: unlinkError } = await supabase
    .from("invoice_source_jobs")
    .delete()
    .eq("invoice_id", invoiceId)
    .eq("order_id", orderId)
    .eq("tenant_id", session.tenantId)
    .select("id");
  if (unlinkError) return { ok: false, error: describeDbError(unlinkError) };
  // A delete matching nothing is not an error to PostgREST, and here it is the
  // outcome that most needs naming: a stale page pressing Remove twice would
  // otherwise report success and put an already-billed job back in the queue.
  if (!unlinked || unlinked.length === 0) {
    return { ok: false, error: `${job.order_number} is not on this invoice.` };
  }

  // Back to `approved`, which is exactly where voiding an invoice leaves a job:
  // the charges are still frozen, and the work is billable again.
  const { error: statusError } = await supabase
    .from("laundry_orders")
    .update({ billing_status: "approved" })
    .eq("id", orderId)
    .eq("tenant_id", session.tenantId)
    .in("billing_status", ["invoice_generated", "invoice_sent"]);
  if (statusError) return { ok: false, error: describeDbError(statusError) };

  const rebuilt = await rebuildJobLines(supabase, session, invoiceId);
  if (!rebuilt.ok) return { ok: false, error: rebuilt.error };

  const { count } = await supabase
    .from("invoice_source_jobs")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", invoiceId)
    .eq("tenant_id", session.tenantId);

  return {
    ok: true,
    invoiceNumber: invoice.invoice_number,
    orderNumber: job.order_number,
    remaining: count ?? 0,
  };
}

/* ------------------------------------------------------------- the board */

export type DraftSummary = {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  periodStart: string | null;
  periodEnd: string | null;
  jobCount: number;
  lineCount: number;
  total: number;
  updatedAt: string | null;
  createdAt: string;
};

/**
 * Every draft that is still collecting, newest period first.
 *
 * The answer to the only question an owner asks at month end — *what is ready to
 * go out?* — which the register could not give: it lists drafts among issued,
 * paid, overdue and void invoices with nothing saying which are still filling up.
 *
 * `tenant_id` is named rather than left to RLS (§23). Every id here is posted
 * back into a write that is filtered to the laundry the person is working in, so
 * a list spanning two — which it does for a platform admin, since `is_member()`
 * is true of every laundry for them — would offer buttons that can only fail.
 */
export async function loadOpenDrafts(
  supabase: Client, tenantId: string, limit = 500,
): Promise<DraftSummary[]> {
  const { data } = await supabase
    .from("invoices")
    .select("id, invoice_number, customer_id, period_start, period_end, total, "
      + "created_at, updated_at, customers(business_name)")
    .eq("tenant_id", tenantId)
    .eq("status", "draft")
    .order("period_end", { ascending: false, nullsFirst: false })
    .order("invoice_number", { ascending: true })
    .limit(limit)
    .returns<Array<{
      id: string; invoice_number: string; customer_id: string;
      period_start: string | null; period_end: string | null; total: number;
      created_at: string; updated_at: string | null;
      customers: { business_name: string } | null;
    }>>();

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [{ data: sources }, { data: lines }] = await Promise.all([
    supabase
      .from("invoice_source_jobs")
      .select("invoice_id")
      .in("invoice_id", ids)
      .eq("tenant_id", tenantId)
      .returns<Array<{ invoice_id: string }>>(),
    supabase
      .from("invoice_lines")
      .select("invoice_id")
      .in("invoice_id", ids)
      .eq("tenant_id", tenantId)
      .returns<Array<{ invoice_id: string }>>(),
  ]);

  const tally = (rowsIn: Array<{ invoice_id: string }> | null) => {
    const counts = new Map<string, number>();
    for (const row of rowsIn ?? []) counts.set(row.invoice_id, (counts.get(row.invoice_id) ?? 0) + 1);
    return counts;
  };
  const jobCounts = tally(sources);
  const lineCounts = tally(lines);

  return rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoice_number,
    customerId: row.customer_id,
    customerName: row.customers?.business_name ?? "Unknown customer",
    periodStart: row.period_start,
    periodEnd: row.period_end,
    jobCount: jobCounts.get(row.id) ?? 0,
    lineCount: lineCounts.get(row.id) ?? 0,
    total: Number(row.total ?? 0),
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  }));
}

/** The jobs a given invoice bills, for the invoice screen's own list. */
export type InvoiceSourceJob = {
  orderId: string;
  orderNumber: string;
  completedAt: string | null;
  billingStatus: string;
  total: number;
};

export async function loadInvoiceSourceJobs(
  supabase: Client, tenantId: string, invoiceId: string,
): Promise<InvoiceSourceJob[]> {
  const { data: sources } = await supabase
    .from("invoice_source_jobs")
    .select("order_id")
    .eq("invoice_id", invoiceId)
    .eq("tenant_id", tenantId)
    .returns<Array<{ order_id: string }>>();

  const ids = (sources ?? []).map((row) => row.order_id);
  if (ids.length === 0) return [];

  const [{ data: jobs }, chargesByJob] = await Promise.all([
    supabase
      .from("laundry_orders")
      .select("id, order_number, completed_at, billing_status")
      .in("id", ids)
      .eq("tenant_id", tenantId)
      .returns<Array<{
        id: string; order_number: string; completed_at: string | null; billing_status: string;
      }>>(),
    loadChargesForJobs(supabase, ids),
  ]);

  return [...(jobs ?? [])]
    .sort((a, b) => (a.completed_at ?? "￿").localeCompare(b.completed_at ?? "￿")
      || a.order_number.localeCompare(b.order_number))
    .map((job) => ({
      orderId: job.id,
      orderNumber: job.order_number,
      completedAt: job.completed_at,
      billingStatus: job.billing_status,
      total: (chargesByJob.get(job.id) ?? []).reduce((sum, charge) => sum + Number(charge.amount), 0),
    }));
}
