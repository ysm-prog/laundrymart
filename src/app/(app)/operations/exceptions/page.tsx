import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date } from "@/lib/format";
import {
  DataTable, EmptyState, PageHeader, SkeletonRows, humanise,
} from "@/components/ui";
import { parseExceptionNotes } from "@/lib/exceptions";
import { EXCEPTION_REASONS, EXCEPTION_REASON_VALUES } from "@/app/(app)/jobs/exception-reasons";
import { ListControls } from "@/components/list-controls";
import { FilterSummary, PeriodFilter, ToggleChips } from "@/components/filters";
import { isFiltered, parseMulti } from "@/lib/filters";
import { ACTIVITY_PERIOD_PRESETS, resolvePeriod } from "@/lib/domain/dates";
import { businessToday } from "@/lib/domain/timezone";
import { resolveException } from "@/app/(app)/jobs/actions";

export const metadata = { title: "Problems" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  job_number: string;
  scheduled_date: string;
  exception_reason: string | null;
  exception_notes: string | null;
  customers: { business_name: string } | null;
  drivers: { full_name: string } | null;
};

type Search = { q?: string; reason?: string; period?: string; from?: string; to?: string };
const FILTER_KEYS = ["q", "reason", "period", "from", "to"] as const;

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireCapability("operations.read");
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Problems"
        description="Stops that could not be completed. Clearing one puts the job back in the queue."
      />
      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={6} />}>
        <ExceptionList params={params} writable={can(session.role, "operations.write")} />
      </Suspense>
    </div>
  );
}

async function ExceptionList({ params, writable }: { params: Search; writable: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("jobs")
    .select("id, job_number, scheduled_date, exception_reason, exception_notes, " +
            "customers(business_name), drivers(full_name)")
    .eq("status", "exception")
    .order("scheduled_date", { ascending: false })
    .limit(200)
    .returns<Row[]>();

  const all = data ?? [];
  // All time by default: an open problem is open however long ago it happened,
  // and defaulting to today would hide the ones that have been ignored longest.
  const period = resolvePeriod(params, businessToday(), "all");
  const reasons = parseMulti(params.reason, EXCEPTION_REASON_VALUES);
  const term = params.q?.trim().toLowerCase();
  const rows = all.filter((row) => {
    if (term && !`${row.job_number} ${row.customers?.business_name ?? ""} ${row.drivers?.full_name ?? ""} ${row.exception_notes ?? ""}`
      .toLowerCase().includes(term)) return false;
    if (reasons.length && !reasons.includes(row.exception_reason ?? "")) return false;
    if (period.range && (row.scheduled_date < period.range.start || row.scheduled_date > period.range.end)) {
      return false;
    }
    return true;
  });
  const filtered = isFiltered(params, FILTER_KEYS);
  const reasonCount = (reason: string) =>
    all.filter((row) => row.exception_reason === reason).length;

  return (
    <>
    <ListControls
      action="/operations/exceptions"
      q={params.q}
      params={params}
      filterKeys={FILTER_KEYS}
      placeholder="Job number, customer, driver or note…"
      chips={
        <>
          {/* Multi-select: "no access or customer closed" is one decision — go
              back tomorrow — and asking it as two separate views splits a round
              that should be planned together. */}
          <ToggleChips
            basePath="/operations/exceptions" params={params} name="reason" label="Reason"
            allLabel="Every reason" allCount={all.length}
            options={EXCEPTION_REASONS
              .filter((reason) => reasonCount(reason.value) > 0)
              .map((reason) => ({ ...reason, count: reasonCount(reason.value) }))}
          />
          <PeriodFilter
            basePath="/operations/exceptions" params={params} period={period}
            presets={ACTIVITY_PERIOD_PRESETS} today={businessToday()} label="Happened in"
            hideCustomWhenPreset
          />
        </>
      }
      summary={
        <FilterSummary basePath="/operations/exceptions" shown={rows.length} total={all.length}
                       noun="problem" filtered={filtered} />
      }
    />
    <DataTable
      rows={rows}
      rowHref={(row) => `/jobs/${row.id}`}
      empty={filtered
        ? <EmptyState title="No problems match those filters"
                      description="Try another reason or a wider period, or clear the filters above." />
        : <EmptyState title="No open problems" description="Every stop either completed or is still in progress." />}
      columns={[
        { header: "Job", cell: (row) => row.job_number },
        { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
        { header: "Date", cell: (row) => date(row.scheduled_date), hideBelow: "sm" },
        { header: "Reason", cell: (row) => humanise(row.exception_reason) },
        {
          header: "Notes",
          // Photo markers ride inside the column; the job page shows the photos.
          cell: (row) => parseExceptionNotes(row.exception_notes).note || "—",
          hideBelow: "lg",
        },
        { header: "Driver", cell: (row) => row.drivers?.full_name ?? "—", hideBelow: "md" },
        {
          header: "",
          align: "right",
          cell: (row) => (writable ? (
            <form action={resolveException}>
              <input type="hidden" name="id" value={row.id} />
              <button type="submit" className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-primary transition hover:bg-primary/8 hover:underline">
                Clear
              </button>
            </form>
          ) : null),
        },
      ]}
    />
    </>
  );
}
