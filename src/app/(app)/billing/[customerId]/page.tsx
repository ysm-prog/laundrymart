import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { money } from "@/lib/format";
import {
  BILLING_PERIOD_PRESETS, formatIso, periodParams, resolvePeriod,
} from "@/lib/domain/dates";
import { businessToday } from "@/lib/domain/timezone";
import { BILLING_STATUS_LABELS } from "@/lib/domain/billing";
import { customerPeriodDetail } from "@/lib/invoices/period";
import {
  Badge, ButtonLink, Card, DataTable, EmptyState, Notice, PageHeader, Stat,
} from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { PeriodFilter } from "@/components/filters";
import { generateCustomerPeriodInvoice } from "../actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Customer billing" };

/**
 * One customer's billing period: every job, and the one invoice they add up to.
 *
 * Three things on one page, in the order the decision is made:
 *
 *   1. **Job history**, grouped by week and collapsible. This is the audit trail
 *      — what was actually processed, on which day.
 *   2. **The invoice summary**, rolled up per item. Ten jobs' towels are one
 *      line carrying 1,450, which is what the customer receives.
 *   3. **One button**, raising one invoice for the lot.
 *
 * The two views are computed from the *same* charges in one pass
 * (`invoice-consolidation.ts`), so the summary can never disagree with the
 * history above it.
 *
 * **Jobs already on an invoice are out by default.** That is the duplicate-billing
 * requirement, and the database enforces it regardless — but "why is August
 * short?" is answered by seeing what was already billed, so `?show=all` carries
 * them, clearly marked and excluded from every total.
 */

export default async function CustomerBillingPage({
  params, searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string; show?: string }>;
}) {
  const session = await requireCapability("billing.read");
  const { customerId } = await params;
  const query = await searchParams;
  const today = businessToday();
  // `last_month` for the reason `/billing` gives, and `all` is not on offer, so
  // the range is always real.
  const period = resolvePeriod(query, today, "last_month");
  const range = period.range!;
  const showAll = query.show === "all";

  const supabase = await createClient();
  const detail = await customerPeriodDetail(
    supabase, session.tenantId, customerId, range, { includeInvoiced: showAll },
  );
  // Not a 404: a platform admin's session reads every laundry, so the customer
  // may well exist — just not here. Saying which is the difference between a
  // dead end and a next step (§23).
  if (!detail) {
    return (
      <div className="space-y-4">
        <PageHeader
          eyebrow="Billing" title="Customer not in this laundry"
          back={{ href: "/billing", label: "All customers" }}
        />
        <Notice tone="danger" title="This customer belongs to another laundry">
          Switch laundry in the account menu to bill them.
        </Notice>
      </div>
    );
  }

  const canGenerate = can(session.role, "invoices.write");
  const base = `/billing/${customerId}`;
  const periodQuery = new URLSearchParams(periodParams(period)).toString();

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Billing"
        title={detail.businessName}
        description={`${formatIso(range.start)} to ${formatIso(range.end)}`}
        back={{ href: `/billing?${periodQuery}`, label: "All customers" }}
        actions={
          <ButtonLink href={`/customers/${customerId}`} variant="secondary">
            Customer record
          </ButtonLink>
        }
      />

      <Card title="Billing period">
        <PeriodFilter
          basePath={base}
          params={showAll ? { ...query, show: "all" } : { ...query, show: undefined }}
          period={period} presets={BILLING_PERIOD_PRESETS} today={today}
          label="Billing period"
        />
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Jobs to bill" value={String(detail.billableJobIds.length)}
              hint={detail.invoicedCount > 0 ? `${detail.invoicedCount} already invoiced` : "In this period"} />
        <Stat label="Pieces of laundry"
              value={detail.totals.reduce((sum, t) => sum + t.quantity, 0).toLocaleString("en-AU")}
              hint="Across the period" />
        <Stat label="Invoice lines" value={String(detail.lines.length)} hint="After rolling up" />
        <Stat label="Invoice total" value={money(detail.subtotal)} hint="Before GST" />
      </div>

      {detail.awaitingReview > 0 ? (
        <Notice tone="warning" title={`${detail.awaitingReview} job(s) are not approved yet`}>
          Only approved jobs go on an invoice, so those are not counted above. Price and approve
          them in <Link className="underline" href="/invoices/awaiting">Awaiting invoice</Link>
          {detail.unpriced > 0 ? ` — ${detail.unpriced} of them have no charges at all.` : "."}
        </Notice>
      ) : null}

      {/* ------------------------------------------------ the invoice summary */}
      <Card
        title="Invoice summary"
        description="What the invoice would carry. Identical items are added together; a rate that changed mid-period stays two lines, at the two rates actually charged."
      >
        {detail.lines.length === 0 ? (
          <EmptyState
            title="Nothing to invoice in this period"
            description="An invoice is raised from approved jobs. Nothing here has been approved yet."
            action={<ButtonLink href="/invoices/awaiting" variant="secondary">Awaiting invoice</ButtonLink>}
          />
        ) : (
          <div className="space-y-4">
            <DataTable
              bare
              label="Consolidated invoice lines"
              empty="No lines"
              rows={detail.lines}
              columns={[
                {
                  header: "Description",
                  cell: (line) => (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{line.description}</span>
                      {line.merged ? (
                        <Badge tone="info">{line.contributions.length} jobs</Badge>
                      ) : null}
                    </div>
                  ),
                },
                {
                  header: "Quantity", align: "right",
                  cell: (line) => line.quantity.toLocaleString("en-AU"),
                },
                { header: "Unit price", align: "right", cell: (line) => money(line.unit_price) },
                { header: "GST", hideBelow: "md", cell: (line) => (line.taxable ? "Yes" : "No") },
                { header: "Amount", align: "right", cell: (line) => money(line.amount) },
              ]}
            />

            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {detail.billableJobIds.length} job(s) · {detail.lines.length} line(s) ·{" "}
                <span className="font-medium text-foreground">{money(detail.subtotal)}</span> before GST
              </p>
              {canGenerate ? (
                <form action={generateCustomerPeriodInvoice}>
                  <input type="hidden" name="customer_id" value={customerId} />
                  <input type="hidden" name="period_start" value={range.start} />
                  <input type="hidden" name="period_end" value={range.end} />
                  <SubmitButton pendingLabel="Raising the invoice…">
                    Raise one invoice for {detail.billableJobIds.length} job(s)
                  </SubmitButton>
                </form>
              ) : null}
            </div>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------ item totals */}
      {detail.totals.length > 0 ? (
        <Card
          title="Total laundry in this period"
          description="Quantity per kind of laundry, whatever it was charged at. The answer to “how much did we do?”, which is not the same question as “what goes on the invoice?”."
        >
          <DataTable
            bare
            label="Laundry totals"
            empty="No laundry"
            rows={detail.totals}
            columns={[
              { header: "Item", cell: (total) => total.description },
              {
                header: "Total quantity", align: "right",
                cell: (total) => total.quantity.toLocaleString("en-AU"),
              },
              { header: "Value", align: "right", cell: (total) => money(total.amount) },
            ]}
          />
        </Card>
      ) : null}

      {/* -------------------------------------------------------- the history */}
      <Card
        title="Job history"
        description="What was processed, week by week. This is the detail the invoice summarises — and it stays on the invoice as its service breakdown."
        actions={
          <ButtonLink
            href={showAll ? `${base}?${periodQuery}` : `${base}?${periodQuery}&show=all`}
            variant="ghost"
          >
            {showAll ? "Hide invoiced jobs" : "Show invoiced jobs"}
          </ButtonLink>
        }
      >
        {detail.jobs.length === 0 ? (
          <EmptyState
            title="No jobs in this period"
            description="Only jobs finished between those two dates appear here."
          />
        ) : (
          <div className="space-y-2">
            {detail.jobs.map((job) => (
              <details
                key={job.id}
                className="rounded-lg border border-border bg-surface"
                open={detail.jobs.length <= 5}
              >
                <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <span className="font-medium">{job.orderNumber}</span>
                  <span className="text-muted-foreground">
                    {job.date ? formatIso(job.date) : "No completion date"}
                  </span>
                  <span className="text-muted-foreground">
                    {job.itemQuantity.toLocaleString("en-AU")} pieces
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    {job.invoiced ? <Badge tone="success">Invoiced</Badge> : null}
                    {!job.invoiced && job.billingStatus !== "approved" ? (
                      <Badge tone="warning">{BILLING_STATUS_LABELS[job.billingStatus]}</Badge>
                    ) : null}
                    <span className="font-medium tabular-nums">{money(job.subtotal)}</span>
                  </span>
                </summary>

                <div className="border-t border-border px-4 py-3">
                  <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                    {job.itemLines.map((item, index) => (
                      <div key={`${job.id}-item-${index}`} className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">{item.label}</dt>
                        <dd className="tabular-nums">
                          {item.quantity === null ? "—" : item.quantity.toLocaleString("en-AU")}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {job.charges.length > 0 ? (
                    <ul className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
                      {job.charges.map((charge) => (
                        <li key={charge.id} className="flex justify-between gap-4">
                          <span className="text-muted-foreground">{charge.description}</span>
                          <span className="tabular-nums">
                            {charge.quantity} × {money(charge.unit_price)} ={" "}
                            <span className="font-medium">{money(charge.amount)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
                      No charges yet — this job has not been priced.
                    </p>
                  )}
                  <p className="mt-3">
                    <Link href={`/orders/${job.id}`} className="text-sm text-action hover:underline">
                      Open job {job.orderNumber}
                    </Link>
                  </p>
                </div>
              </details>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
