import { Suspense } from "react";
import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { can } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { takenInByPickup } from "@/lib/runs/pickup-intake";
import { date, dateTime, number, today } from "@/lib/format";
import {
  DataTable, EmptyState, PageHeader, SkeletonRows,
} from "@/components/ui";
import {
  ACTIVITY_PERIOD_PRESETS, resolvePeriod, type ResolvedPeriod,
} from "@/lib/domain/dates";
import { businessToday } from "@/lib/domain/timezone";
import { ListControls } from "@/components/list-controls";
import { FilterSummary, PeriodFilter } from "@/components/filters";
import { isFiltered } from "@/lib/filters";

export const metadata = { title: "Collections" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  pickup_date: string;
  bag_count: number;
  total_weight_kg: number | null;
  signed_by: string | null;
  completed_at: string | null;
  job_id: string;
  customers: { business_name: string } | null;
  drivers: { full_name: string } | null;
  pickup_lines: Array<{ quantity: number; damaged_quantity: number; missing_quantity: number }>;
};

type Search = { q?: string; period?: string; from?: string; to?: string; error?: string; ok?: string };

/** What the office can do with a collection, once it has been counted at the door. */
type Intake = { tenantId: string; canRead: boolean; canWrite: boolean };
const FILTER_KEYS = ["q", "period", "from", "to"] as const;

export default async function PickupsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const session = await requireCapability("operations.read");

  // Who may act on a collection. A board and a driver hold `operations.read` and
  // neither takes laundry in, so they get no column at all rather than a link
  // that lands on a screen the auth gate bounces them off — and no extra query
  // either, since the read below is skipped with it.
  const intake: Intake = {
    tenantId: session.tenantId,
    canRead: can(session.role, "orders.read"),
    canWrite: can(session.role, "orders.write"),
  };

  // Today by default: a collections list is what happened on the round, and the
  // round is today's. The wider windows are one press away.
  const period = resolvePeriod(params, businessToday(), "today");
  const range = period.range ?? { start: "0001-01-01", end: "9999-12-31" };

  return (
    <div className="space-y-6">
      <PageHeader title="Collections"
                  description="Linen picked up at a stop, counted at the door, with anything damaged or missing." />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={8} />}>
        <PickupList params={params} from={range.start} to={range.end} period={period}
                    intake={intake} />
      </Suspense>
    </div>
  );
}

async function PickupList({
  params, from, to, period, intake,
}: {
  params: Search; from: string; to: string; period: ResolvedPeriod; intake: Intake;
}) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("pickups")
    .select("id, pickup_date, bag_count, total_weight_kg, signed_by, completed_at, job_id, " +
            "customers(business_name), drivers(full_name), " +
            "pickup_lines(quantity, damaged_quantity, missing_quantity)")
    .gte("pickup_date", from).lte("pickup_date", to)
    .order("completed_at", { ascending: false })
    .limit(200)
    .returns<Row[]>();

  const totals = (row: Row) => (row.pickup_lines ?? []).reduce(
    (acc, line) => ({
      quantity: acc.quantity + line.quantity,
      damaged: acc.damaged + line.damaged_quantity,
      missing: acc.missing + line.missing_quantity,
    }),
    { quantity: 0, damaged: 0, missing: 0 },
  );

  const all = data ?? [];

  // Which of these are already on a job — one filtered read for the whole page
  // rather than one per row, and skipped entirely for a role that cannot act on
  // the answer. A **cancelled** job does not count, matching
  // `uq_laundry_orders_source_pickup` exactly: cancelling is how a take-in
  // against the wrong customer is undone, and the collection is then still
  // sitting there waiting. A reader that disagreed with the index would either
  // offer a link the database refuses or hide one it would accept.
  const takenIn = intake.canRead
    ? await takenInByPickup(supabase, intake.tenantId, all.map((row) => row.id))
    : new Map();

  const term = params.q?.trim().toLowerCase();
  const rows = term
    ? all.filter((row) => `${row.customers?.business_name ?? ""} ${row.drivers?.full_name ?? ""} ${row.signed_by ?? ""}`
        .toLowerCase().includes(term))
    : all;
  const filtered = isFiltered(params, FILTER_KEYS);

  return (
    <>
      <ListControls
        action="/operations/pickups"
        q={params.q}
        params={params}
        filterKeys={FILTER_KEYS}
        placeholder="Customer, driver or who signed…"
        chips={
          <PeriodFilter
            basePath="/operations/pickups" params={params} period={period}
            presets={ACTIVITY_PERIOD_PRESETS} today={today()} label="Collected in"
            hideCustomWhenPreset
          />
        }
        summary={
          <FilterSummary basePath="/operations/pickups" shown={rows.length} total={all.length}
                         noun="collection" filtered={filtered} />
        }
      />
      <DataTable
        rows={rows}
        rowHref={(row) => `/jobs/${row.job_id}`}
        empty={<EmptyState
          title={filtered ? "No collections match those filters" : "No collections in this range"}
          description={period.preset === "today"
            ? "Nothing has been collected today yet. Try a wider period above."
            : "Try a wider period, or clear the filters above."} />}
        columns={[
          { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
          { header: "Date", cell: (row) => date(row.pickup_date) },
          { header: "Driver", cell: (row) => row.drivers?.full_name ?? "—", hideBelow: "md" },
          { header: "Items", cell: (row) => number(totals(row).quantity), align: "right" },
          { header: "Damaged", cell: (row) => number(totals(row).damaged), align: "right", hideBelow: "sm" },
          { header: "Missing", cell: (row) => number(totals(row).missing), align: "right", hideBelow: "sm" },
          { header: "Bags", cell: (row) => number(row.bag_count), align: "right", hideBelow: "lg" },
          { header: "Completed", cell: (row) => dateTime(row.completed_at), hideBelow: "lg" },
          // The loop this closes: a collection moves inventory and bills nothing
          // until it is taken in as a laundry job and priced per item. Without
          // this column the office has no list of what has been collected and
          // not yet billed — which is how a collection goes unbilled silently.
          ...(intake.canRead ? [{
            header: "Taken in",
            cell: (row: Row) => <TakenIn job={takenIn.get(row.id)} pickupId={row.id}
                                         canWrite={intake.canWrite} />,
          }] : []),
        ]}
      />
    </>
  );
}

/**
 * Whether a collection has become a laundry job, and the one press that makes it
 * one.
 *
 * 36px, not a bare inline link: §10b's floor for anything tappable, and this is
 * pressed on a counter tablet.
 */
function TakenIn({
  job, pickupId, canWrite,
}: {
  job?: { id: string; orderNumber: string }; pickupId: string; canWrite: boolean;
}) {
  if (job) {
    return (
      <Link href={`/orders/${job.id}`}
            className="inline-flex min-h-9 items-center font-medium text-primary hover:underline">
        {job.orderNumber}
      </Link>
    );
  }
  if (!canWrite) return <span className="text-muted-foreground">Not yet</span>;
  return (
    <Link href={`/orders/new?pickup=${pickupId}`}
          className="inline-flex min-h-9 items-center font-medium text-primary hover:underline">
      Take in
    </Link>
  );
}
