import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { date, today } from "@/lib/format";
import {
  ButtonLink,
  DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge, humanise,
} from "@/components/ui";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";

export const metadata = { title: "Stops" };
export const dynamic = "force-dynamic";

type Search = { q?: string; status?: string; date?: string; page?: string; error?: string; ok?: string };

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

export default async function JobsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  await requireCapability("routes.read");

  return (
    <div>
      <PageHeader
        title="Stops"
        description="Every stop on a run: what was collected, what was delivered, and anything that went wrong."
      />
      <ListControls
        action="/jobs"
        q={params.q}
        filters={[
          {
            name: "status", label: "Status", value: params.status,
            options: [
              { value: "scheduled", label: "Scheduled" },
              { value: "assigned", label: "Assigned" },
              { value: "in_progress", label: "In progress" },
              { value: "completed", label: "Completed" },
              { value: "exception", label: "Exception" },
              { value: "cancelled", label: "Cancelled" },
              { value: "unassigned", label: "No route" },
            ],
          },
        ]}
      />
      <form method="get" action="/jobs" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="status" value={params.status ?? ""} />
        <label className="text-sm">
          <span className="mb-1 block font-medium">Date</span>
          <input type="date" name="date" defaultValue={params.date ?? today()}
                 className="rounded-md border bg-surface px-3 py-2 text-sm" />
        </label>
        <button type="submit" className="rounded-md border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-muted">
          Show
        </button>
      </form>

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={8} />}>
        <JobList params={params} />
      </Suspense>
    </div>
  );
}

async function JobList({ params }: { params: Search }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);
  const scheduled = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : today();

  let query = supabase
    .from("jobs")
    .select(
      "id, job_number, scheduled_date, service_type, status, progress_status, route_id, " +
      "customers(business_name), daily_routes(code), drivers(full_name)",
      { count: "exact" },
    )
    .eq("scheduled_date", scheduled)
    .is("deleted_at", null)
    .order("sequence")
    .range(from, to);

  if (params.status === "unassigned") query = query.is("route_id", null);
  else if (params.status) query = query.eq("status", params.status);
  if (params.q) query = query.ilike("job_number", `%${params.q}%`);

  const { data, count } = await query.returns<Row[]>();

  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground">Showing jobs scheduled for {date(scheduled)}.</p>
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/jobs/${row.id}`}
        empty={
          <EmptyState
            title="No stops for this date"
            description="Plan the day's runs and each customer visit appears here as a stop."
            action={<ButtonLink href="/orders">Go to jobs</ButtonLink>}
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
