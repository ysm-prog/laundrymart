import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { date } from "@/lib/format";
import {
  ButtonLink,
  DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge, humanise,
} from "@/components/ui";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";
import { FilterChips, PeriodFilter } from "@/components/filters";
import { isFiltered } from "@/lib/filters";
import {
  ACTIVITY_PERIOD_PRESETS, resolvePeriod, type ResolvedPeriod,
} from "@/lib/domain/dates";
import { businessToday } from "@/lib/domain/timezone";

export const metadata = { title: "Driver visits" };
export const dynamic = "force-dynamic";

type Search = {
  q?: string; status?: string; period?: string; from?: string; to?: string;
  page?: string; error?: string; ok?: string;
};

type Row = {
  id: string;
  job_number: string;
  scheduled_date: string;
  service_type: string;
  status: string;
  progress_status: string;
  route_id: string | null;
  customers: { business_name: string } | null;
  daily_routes: { code: string } | null;
  drivers: { full_name: string } | null;
};

const VISIT_STATUSES = [
  { value: "scheduled", label: "Scheduled" },
  { value: "assigned", label: "Assigned" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "exception", label: "Exception" },
  { value: "cancelled", label: "Cancelled" },
  { value: "unassigned", label: "No route" },
] as const;

const FILTER_KEYS = ["q", "status", "period", "from", "to"] as const;

export default async function JobsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  await requireCapability("routes.read");
  // Today by default, as this screen has always been — but a *window* now, so
  // "this week" is one press. It used to be a single day with its own hand-rolled
  // date box that carried the status through and silently dropped the search.
  const period = resolvePeriod(params, businessToday(), "today");

  return (
    <div>
      <PageHeader
        title="Driver visits"
        description="Every time a driver called on a customer: what was collected, what was dropped off, and anything that went wrong."
      />
      <ListControls
        action="/jobs"
        q={params.q}
        params={params}
        filterKeys={FILTER_KEYS}
        placeholder="Job number…"
        chips={
          <>
            <FilterChips
              basePath="/jobs" params={params} name="status" label="Visit status"
              allLabel="All visits" options={VISIT_STATUSES}
            />
            <PeriodFilter
              basePath="/jobs" params={params} period={period}
              presets={ACTIVITY_PERIOD_PRESETS} today={businessToday()} label="Scheduled in"
              hideCustomWhenPreset
            />
          </>
        }
      />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={8} />}>
        <JobList params={params} period={period} />
      </Suspense>
    </div>
  );
}

async function JobList({ params, period }: { params: Search; period: ResolvedPeriod }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);

  let query = supabase
    .from("jobs")
    .select(
      "id, job_number, scheduled_date, service_type, status, progress_status, route_id, " +
      "customers(business_name), daily_routes(code), drivers(full_name)",
      { count: "exact" },
    )
    .is("deleted_at", null)
    // Newest day first inside the window, then the run's own order within a day
    // — a week of visits read oldest-first would open on last Monday.
    .order("scheduled_date", { ascending: false })
    .order("sequence")
    .range(from, to);

  if (period.range) {
    query = query.gte("scheduled_date", period.range.start).lte("scheduled_date", period.range.end);
  }

  if (params.status === "unassigned") query = query.is("route_id", null);
  else if (params.status) query = query.eq("status", params.status);
  if (params.q) query = query.ilike("job_number", `%${params.q}%`);

  const { data, count } = await query.returns<Row[]>();

  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground">
        {period.range
          ? (period.range.start === period.range.end
            ? `Visits scheduled for ${date(period.range.start)}.`
            : `Visits scheduled between ${date(period.range.start)} and ${date(period.range.end)}.`)
          : "Every visit on record."}
      </p>
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/jobs/${row.id}`}
        empty={
          <EmptyState
            title={isFiltered(params, FILTER_KEYS)
              ? "No visits match those filters" : "No visits in this period"}
            description={isFiltered(params, FILTER_KEYS)
              ? "Try a wider period, or clear the filters above."
              : "Plan the day's runs and each customer visit appears here."}
            action={<ButtonLink href="/orders">Go to customer laundry</ButtonLink>}
          />
        }
        columns={[
          { header: "Job", cell: (row) => row.job_number },
          { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
          { header: "Route", cell: (row) => row.daily_routes?.code ?? "Unassigned", hideBelow: "sm" },
          { header: "Driver", cell: (row) => row.drivers?.full_name ?? "—", hideBelow: "md" },
          { header: "Service", cell: (row) => humanise(row.service_type), hideBelow: "lg" },
          { header: "Progress", cell: (row) => <StatusBadge status={row.progress_status} /> },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/jobs" />
    </>
  );
}
