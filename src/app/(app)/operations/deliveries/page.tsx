import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { date, dateTime, number, today } from "@/lib/format";
import { DataTable, EmptyState, PageHeader, SkeletonRows } from "@/components/ui";
import {
  ACTIVITY_PERIOD_PRESETS, resolvePeriod, type ResolvedPeriod,
} from "@/lib/domain/dates";
import { businessToday } from "@/lib/domain/timezone";
import { ListControls } from "@/components/list-controls";
import { FilterSummary, PeriodFilter } from "@/components/filters";
import { isFiltered } from "@/lib/filters";

export const metadata = { title: "Deliveries" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  delivery_date: string;
  signed_by: string | null;
  completed_at: string | null;
  job_id: string;
  customers: { business_name: string } | null;
  drivers: { full_name: string } | null;
  delivery_lines: Array<{ quantity: number }>;
};

type Search = { q?: string; period?: string; from?: string; to?: string; error?: string; ok?: string };
const FILTER_KEYS = ["q", "period", "from", "to"] as const;

export default async function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  await requireCapability("operations.read");

  // Today by default, for the reason Collections gives: this is what happened on
  // the round, and the round is today's.
  const period = resolvePeriod(params, businessToday(), "today");
  const range = period.range ?? { start: "0001-01-01", end: "9999-12-31" };

  return (
    <div className="space-y-6">
      <PageHeader title="Deliveries"
                  description="Clean linen handed back, with the signature and photo taken at the door." />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={8} />}>
        <DeliveryList params={params} from={range.start} to={range.end} period={period} />
      </Suspense>
    </div>
  );
}

async function DeliveryList({
  params, from, to, period,
}: {
  params: Search; from: string; to: string; period: ResolvedPeriod;
}) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("deliveries")
    .select("id, delivery_date, signed_by, completed_at, job_id, " +
            "customers(business_name), drivers(full_name), delivery_lines(quantity)")
    .gte("delivery_date", from).lte("delivery_date", to)
    .order("completed_at", { ascending: false })
    .limit(200)
    .returns<Row[]>();

  const total = (row: Row) => (row.delivery_lines ?? []).reduce((sum, line) => sum + line.quantity, 0);

  const all = data ?? [];
  const term = params.q?.trim().toLowerCase();
  const rows = term
    ? all.filter((row) => `${row.customers?.business_name ?? ""} ${row.drivers?.full_name ?? ""} ${row.signed_by ?? ""}`
        .toLowerCase().includes(term))
    : all;
  const filtered = isFiltered(params, FILTER_KEYS);

  return (
    <>
      <ListControls
        action="/operations/deliveries"
        q={params.q}
        params={params}
        filterKeys={FILTER_KEYS}
        placeholder="Customer, driver or who signed…"
        chips={
          <PeriodFilter
            basePath="/operations/deliveries" params={params} period={period}
            presets={ACTIVITY_PERIOD_PRESETS} today={today()} label="Delivered in"
            hideCustomWhenPreset
          />
        }
        summary={
          <FilterSummary basePath="/operations/deliveries" shown={rows.length} total={all.length}
                         noun="delivery" nouns="deliveries" filtered={filtered} />
        }
      />
      <DataTable
        rows={rows}
        rowHref={(row) => `/jobs/${row.job_id}`}
        empty={<EmptyState
          title={filtered ? "No deliveries match those filters" : "No deliveries in this range"}
          description={period.preset === "today"
            ? "Nothing has been delivered today yet. Try a wider period above."
            : "Try a wider period, or clear the filters above."} />}
        columns={[
          { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
          { header: "Date", cell: (row) => date(row.delivery_date) },
          { header: "Driver", cell: (row) => row.drivers?.full_name ?? "—", hideBelow: "md" },
          { header: "Items", cell: (row) => number(total(row)), align: "right" },
          { header: "Signed by", cell: (row) => row.signed_by ?? "—", hideBelow: "sm" },
          { header: "Completed", cell: (row) => dateTime(row.completed_at), hideBelow: "lg" },
        ]}
      />
    </>
  );
}
