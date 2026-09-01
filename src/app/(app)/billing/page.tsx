import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { money } from "@/lib/format";
import {
  BILLING_PERIOD_PRESETS, PERIOD_PRESET_LABELS, formatIso, resolvePeriod, periodParams,
} from "@/lib/domain/dates";
import { businessToday } from "@/lib/domain/timezone";
import { BILLING_METHOD_LABELS, isBillingMethod } from "@/lib/domain/billing";
import { periodBillingSummary, type PeriodCustomerRow } from "@/lib/invoices/period";
import { Badge, ButtonLink, Card, DataTable, EmptyState, PageHeader, Stat } from "@/components/ui";
import { PeriodFilter } from "@/components/filters";

export const dynamic = "force-dynamic";

export const metadata = { title: "Billing" };

/**
 * Billing: a period, then a customer, then one invoice.
 *
 * This is the month-end screen the business actually works from, and it answers
 * a different question from the review queue beside it. The queue asks *what
 * needs pricing?* and is an unbounded list of every open job. This asks *what do
 * I bill ABC Hotel for August?* — which needs a period, a customer, and their
 * whole month in one place.
 *
 * **The period defaults to last month.** Defaulting to the month you are
 * standing in bills 1 September to 1 September on the 1st, finds nothing, and
 * reports "nothing to invoice" — which reads as *everything is billed* rather
 * than as *wrong month*. That trap has been walked into once here already.
 *
 * The period lives in the URL, so a chosen month survives a refresh and a link
 * sent to somebody else.
 */

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const session = await requireCapability("billing.read");
  const params = await searchParams;
  const today = businessToday();
  // Last month, not this one: a run defaulting to the month you are standing in
  // finds nothing on the 1st and reports "nothing to invoice", which reads as
  // *everything is billed* rather than as *wrong month*. `all` is not offered at
  // all here — an unbounded billing period is an invitation to bill the wrong
  // thing — so the range is always real and the `!` below is safe.
  const period = resolvePeriod(params, today, "last_month");
  const range = period.range!;

  const supabase = await createClient();
  // Named rather than left to RLS (§23): every customer id here is posted into a
  // Generate, which is filtered to the laundry the person is working in.
  const rows = await periodBillingSummary(supabase, session.tenantId, range);

  const totals = rows.reduce(
    (acc, row) => ({
      jobs: acc.jobs + row.jobCount,
      items: acc.items + row.itemQuantity,
      value: acc.value + row.value,
      ready: acc.ready + row.readyToInvoice,
      review: acc.review + row.awaitingReview,
    }),
    { jobs: 0, items: 0, value: 0, ready: 0, review: 0 },
  );

  const uninvoiced = rows.filter((row) => row.state !== "invoiced").length;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Money"
        title="Billing"
        description="Pick a period, pick a customer, and raise one invoice for everything they had done in it."
      />

      <Card
        title="Billing period"
        description={`${PERIOD_PRESET_LABELS[period.preset]} — ${formatIso(range.start)} to ${formatIso(range.end)}.`}
      >
        <PeriodFilter
          basePath="/billing" params={params} period={period}
          presets={BILLING_PERIOD_PRESETS} today={today} label="Billing period"
        />
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Customers" value={String(rows.length)}
              hint={uninvoiced > 0 ? `${uninvoiced} not fully invoiced` : "All invoiced"} />
        <Stat label="Completed jobs" value={String(totals.jobs)} hint="In this period" />
        <Stat label="Pieces of laundry" value={totals.items.toLocaleString("en-AU")}
              hint="Counted from the jobs" />
        <Stat label="Value" value={money(totals.value)}
              hint={totals.review > 0 ? `${totals.review} job(s) not reviewed` : "GST included"} />
      </div>

      <Card
        title="Customers with work in this period"
        description="Most valuable first. Open one to see every job and the invoice it would produce."
      >
        {rows.length === 0 ? (
          <EmptyState
            title="No completed jobs in this period"
            description="Only jobs that were finished between those two dates appear here. Try a wider range, or check the Awaiting invoice queue."
            action={<ButtonLink href="/invoices/awaiting" variant="secondary">Awaiting invoice</ButtonLink>}
          />
        ) : (
          <DataTable
            bare
            label="Customers with billable work"
            empty="No customers"
            rows={rows}
            columns={[
              {
                header: "Customer",
                cell: (row: PeriodCustomerRow) => (
                  <Link
                    href={`/billing/${row.customerId}?${new URLSearchParams(periodParams(period)).toString()}`}
                    className="font-medium text-action hover:underline"
                  >
                    {row.businessName}
                  </Link>
                ),
              },
              {
                header: "Billing",
                cell: (row: PeriodCustomerRow) =>
                  isBillingMethod(row.billingMethod)
                    ? BILLING_METHOD_LABELS[row.billingMethod] : "—",
              },
              { header: "Jobs", align: "right",
                cell: (row: PeriodCustomerRow) => String(row.jobCount),
              },
              { header: "Total items", align: "right",
                cell: (row: PeriodCustomerRow) => row.itemQuantity.toLocaleString("en-AU"),
              },
              { header: "Value", align: "right",
                cell: (row: PeriodCustomerRow) => money(row.value),
              },
              {
                header: "Invoice status",
                // Never colour alone: every badge carries its words.
                cell: (row: PeriodCustomerRow) => (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {row.state === "invoiced" ? <Badge tone="success">Invoiced</Badge> : null}
                    {row.state === "part_invoiced" ? <Badge tone="warning">Part invoiced</Badge> : null}
                    {row.state === "not_invoiced" ? <Badge tone="neutral">Not invoiced</Badge> : null}
                    {row.awaitingReview > 0
                      ? <Badge tone="warning">{row.awaitingReview} to review</Badge> : null}
                    {row.readyToInvoice > 0
                      ? <Badge tone="info">{row.readyToInvoice} ready</Badge> : null}
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
