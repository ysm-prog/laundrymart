import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { money } from "@/lib/format";
import {
  BILLING_METHODS, BILLING_METHOD_LABELS, BILLING_STATUS_LABELS, isBillingMethod,
} from "@/lib/domain/billing";
import { ACTIVITY_PERIOD_PRESETS, resolvePeriod } from "@/lib/domain/dates";
import { businessToday } from "@/lib/domain/timezone";
import { isFiltered } from "@/lib/filters";
import { loadChargesForJobs } from "@/lib/orders/job-billing";
import { jobChargeSubtotal } from "@/lib/domain/job-pricing";
import { Badge, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { ListControls } from "@/components/list-controls";
import { FilterChips, FilterSummary, PeriodFilter } from "@/components/filters";
import { BillingQueue, type QueueRow } from "./billing-queue";

export const dynamic = "force-dynamic";

export const metadata = { title: "Awaiting invoice" };

/** The parameters this queue can be narrowed by. `FILTER_KEYS` is what Clear clears. */
type Search = {
  q?: string; customer?: string; method?: string; priced?: string;
  period?: string; from?: string; to?: string; page?: string;
};
const FILTER_KEYS = ["q", "customer", "method", "priced", "period", "from", "to"] as const;

/** The identity `matches()` compares against to skip re-resolving the period. */
const NO_OVERRIDE: Record<string, never> = {};

/** The two things a reviewer actually sorts this queue by, as one-press chips. */
const PRICED_OPTIONS = [
  { value: "unpriced", label: "Not priced yet",
    title: "Jobs with no charges on them — these cannot be approved until they are priced" },
  { value: "priced", label: "Priced", title: "Jobs with charges, ready to check and approve" },
] as const;

/**
 * The billing queue: every job whose work is done and whose money is not.
 *
 * Two groups, because they are two different decisions and each has its own
 * bulk action:
 *
 *   **Awaiting review** — the charges need checking. `Select → Approve Selected`.
 *   **Approved**        — approved, but on no draft. `Select → Add to Draft`.
 *
 * **Nothing on this screen creates an invoice**, which is the change from what
 * it used to be: the second group's verb was Generate Selected, and it turned
 * the ticked jobs into invoices there and then. A job joins its customer's draft
 * here; the draft becomes an invoice on the drafts board, when somebody issues
 * it, and the customer hears nothing until it is sent after that.
 *
 * Gated on `billing.read`, and the tables behind it are gated independently:
 * `job_charge_snapshots` is readable only through `can_read_billing()`, so an
 * operational role reaching this URL sees the auth gate first and would read no
 * money even if they got past it.
 */
export default async function AwaitingInvoicePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireCapability("billing.read");
  const params = await searchParams;
  const supabase = await createClient();
  const today = businessToday();
  const period = resolvePeriod(params, today, "all");

  const { data: jobs } = await supabase
    .from("laundry_orders")
    .select(
      "id, order_number, customer_id, status, billing_status, completed_at, due_date, " +
      "customers(id, business_name, billing_method, rate_card_agreement_id)",
    )
    // Named rather than left to RLS (§23). Every id on this screen is posted
    // back into a write — pricing, approving, generating — and each of those is
    // filtered to the laundry the person is working in, so a list that spans two
    // (which it does for a platform admin, since `is_member()` is true of every
    // laundry for them) offers ticks that can only fail.
    .eq("tenant_id", session.tenantId)
    .in("billing_status", ["awaiting_review", "approved"])
    .order("completed_at", { ascending: true })
    .limit(500)
    .returns<Array<{
      id: string; order_number: string; customer_id: string; status: string;
      billing_status: string; completed_at: string | null; due_date: string | null;
      customers: {
        id: string; business_name: string; billing_method: string;
        rate_card_agreement_id: string | null;
      } | null;
    }>>();

  const rows = jobs ?? [];
  // One query for every job's charges rather than one per row — the queue is a
  // list of up to 500 and a per-row read would be 500 round trips.
  const chargesByJob = await loadChargesForJobs(supabase, rows.map((row) => row.id));

  const toRow = (row: (typeof rows)[number]): QueueRow => {
    const method = row.customers?.billing_method ?? "";
    const charges = chargesByJob.get(row.id) ?? [];
    return {
      id: row.id,
      orderNumber: row.order_number,
      customerId: row.customer_id,
      customerName: row.customers?.business_name ?? "Unknown customer",
      billingMethod: isBillingMethod(method) ? BILLING_METHOD_LABELS[method] : "—",
      billingMethodValue: method,
      completedAt: row.completed_at,
      chargeCount: charges.length,
      subtotal: jobChargeSubtotal(charges),
      hasRateCard: Boolean(row.customers?.rate_card_agreement_id),
    };
  };

  const allAwaiting = rows.filter((row) => row.billing_status === "awaiting_review").map(toRow);
  const allApproved = rows.filter((row) => row.billing_status === "approved").map(toRow);

  /**
   * Filtering happens here rather than in the query, deliberately.
   *
   * The queue is one capped read of at most 500 jobs, and every chip has to
   * carry a count — *2 not priced yet* is the number a reviewer works from, and
   * a count taken from a filtered query would count only what was already
   * showing. Two of the three questions (has this been priced? what is the
   * customer's billing method?) also cannot be asked of `laundry_orders` at all:
   * the first is derived from a second read, the second lives on the customer.
   *
   * So one read, exact counts, and an honest "showing N of M".
   */
  /**
   * Filtering happens here rather than in the query, deliberately.
   *
   * The queue is one capped read of at most 500 jobs, and every chip has to
   * carry a count — *2 not priced yet* is the number a reviewer works from.
   * Two of the three questions also cannot be asked of `laundry_orders` at all:
   * whether a job has been priced is derived from a second read, and the
   * customer's billing method lives on the customer. So: one read, filtered in
   * memory, with exact counts and an honest "showing N of M".
   */
  const all = [...allAwaiting, ...allApproved];

  /**
   * Does this row survive the filters? `override` replaces one of them, which is
   * what makes a chip count honest: the number on "Not priced yet" is what
   * pressing it would actually show, given everything *else* that is filtered —
   * not a count of the whole queue that promises two rows and delivers none
   * because a customer is also selected.
   */
  const matches = (row: QueueRow, override: Partial<Search> = NO_OVERRIDE) => {
    const f = override === NO_OVERRIDE ? params : { ...params, ...override };
    const term = f.q?.trim().toLowerCase();
    if (term && !`${row.orderNumber} ${row.customerName}`.toLowerCase().includes(term)) return false;
    if (f.customer && row.customerId !== f.customer) return false;
    if (f.method && row.billingMethodValue !== f.method) return false;
    if (f.priced === "unpriced" && row.chargeCount > 0) return false;
    if (f.priced === "priced" && row.chargeCount === 0) return false;
    // Resolved once for the common case; only a period override pays for a parse.
    const range = f === params ? period.range : resolvePeriod(f, today, "all").range;
    if (range) {
      // A job with no completion date has no date to judge, so a window excludes
      // it rather than quietly keeping it.
      const day = row.completedAt?.slice(0, 10);
      if (!day || day < range.start || day > range.end) return false;
    }
    return true;
  };

  const awaiting = allAwaiting.filter((row) => matches(row));
  const approved = allApproved.filter((row) => matches(row));
  const filtered = isFiltered(params, FILTER_KEYS);

  const shown = awaiting.length + approved.length;
  const approvedValue = approved.reduce((sum, row) => sum + row.subtotal, 0);
  const unpriced = awaiting.filter((row) => row.chargeCount === 0).length;

  const pricedCount = (value: string | undefined) =>
    all.filter((row) => matches(row, { priced: value })).length;

  // The customer picker offers only the customers with work in this queue — a
  // list of every customer in the laundry would be mostly options that show
  // nothing, which reads as a broken filter. Same for the method.
  const customers = [...new Map(all.map((row) => [row.customerId, row.customerName]))]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const methodsInUse = BILLING_METHODS.filter((method) =>
    all.some((row) => row.billingMethodValue === method));

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Billing"
        title="Awaiting invoice"
        description="Work that is finished and not yet billed. Completing a job never raises an
                     invoice on its own \u2014 approving its charges puts them on that customer\u2019s
                     invoice for the period."
      />

      {/* The tiles follow the filters. A filter narrows the screen, all of it —
          a tile reading $1,200 over a list showing one customer's $50 is the
          wrong answer to the question the operator is asking. The summary line
          under the bar is what keeps that honest, by saying how much of the
          queue is hidden. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Awaiting review" value={String(awaiting.length)}
              hint={unpriced > 0 ? `${unpriced} not priced yet` : "All priced"} />
        <Stat label="Approved, not on a draft" value={String(approved.length)}
              hint={approved.length > 0 ? "Add them to a draft" : "All on a draft"}
              tone={approved.length > 0 ? "warning" : "default"} />
        <Stat label="Approved value" value={money(approvedValue)}
              hint={filtered ? "GST included, filtered" : "GST included"} />
      </div>

      <ListControls
        action="/invoices/awaiting"
        q={params.q}
        params={params}
        filterKeys={FILTER_KEYS}
        placeholder="Job number or customer\u2026"
        filters={[
          ...(customers.length > 1 ? [{
            name: "customer", label: "Customer", value: params.customer,
            options: customers.map(([id, name]) => ({ value: id, label: name })),
          }] : []),
          ...(methodsInUse.length > 1 ? [{
            name: "method", label: "Billing method", value: params.method,
            options: methodsInUse.map((method) => ({
              value: method, label: BILLING_METHOD_LABELS[method],
            })),
          }] : []),
        ]}
        chips={
          <>
            <FilterChips
              basePath="/invoices/awaiting"
              params={params}
              name="priced"
              label="Pricing"
              allLabel="All jobs"
              allCount={pricedCount(undefined)}
              options={PRICED_OPTIONS.map((option) => ({
                ...option, count: pricedCount(option.value),
              }))}
            />
            <PeriodFilter
              basePath="/invoices/awaiting"
              params={params}
              period={period}
              presets={ACTIVITY_PERIOD_PRESETS}
              today={today}
              label="Completed in"
              hideCustomWhenPreset
            />
          </>
        }
        summary={
          <FilterSummary
            basePath="/invoices/awaiting"
            shown={shown}
            total={all.length}
            noun="job"
            filtered={filtered}
          />
        }
      />

      {/* Two columns from `xl` (\u00a710b). The two groups are two decisions and are
          worked in parallel at month end, so reading one under the other is a
          long page and a lot of scrolling back. Below `xl` they stack in the
          order they always did. */}
      <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
      <Card
        title="Awaiting review"
        description="Price the jobs that need it, check the charges, then approve them. Approving
                     freezes the price and puts it on the customer\u2019s draft invoice."
        actions={filtered && awaiting.length > 0
          ? <span className="text-2xs text-muted-foreground">Filtered</span> : null}
      >
        {awaiting.length === 0 ? (
          <EmptyState
            title={filtered ? "No jobs match those filters" : "Nothing waiting on a review"}
            description={filtered
              ? "Try a wider date range, or clear the filters above."
              : "Completed jobs land here for their charges to be priced and checked."}
          />
        ) : (
          <BillingQueue
            rows={awaiting}
            mode="approve"
            canAct={can(session.role, "invoices.approve") && can(session.role, "invoices.bulk")}
            canPrice={can(session.role, "billing.write") && can(session.role, "invoices.bulk")}
          />
        )}
      </Card>

      <Card
        title="Approved, not on a draft"
        description="Approving puts a job straight onto its customer\u2019s draft invoice, so this
                     is normally empty. A job sits here only when that could not be done \u2014
                     adding it to a draft is how it gets there."
      >
        {approved.length === 0 ? (
          <EmptyState
            title={filtered ? "No approved jobs match those filters" : "Nothing is waiting"}
            description={filtered
              ? "Try a wider date range, or clear the filters above."
              : "Approved jobs go straight onto their customer\u2019s draft invoice, so this "
                + "list is empty unless one could not be placed."}
            action={<Link href="/invoices/drafts" className="text-sm text-primary hover:underline">Open drafts</Link>}
          />
        ) : (
          <BillingQueue
            rows={approved}
            mode="place"
            canAct={can(session.role, "invoices.write") && can(session.role, "invoices.bulk")}
          />
        )}
      </Card>

      </div>

      <p className="text-sm text-muted-foreground">
        A customer&rsquo;s billing method decides how many drafts their work collects on:{" "}
        <Badge tone="neutral">{BILLING_STATUS_LABELS.approved}</Badge> jobs for a per-job customer
        each open a draft of their own, and a consolidated customer&rsquo;s jobs share one for the
        period. Either way it is a draft until somebody issues it. Set the method on the
        customer&rsquo;s Billing &amp; pricing section.
      </p>
    </div>
  );
}
