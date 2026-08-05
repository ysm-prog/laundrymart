import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, today } from "@/lib/format";
import {
  Card, DataTable, EmptyState, FlashMessages, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { Field, Input, SubmitButton } from "@/components/form";
import { generateDailyRoutes } from "./actions";

export const metadata = { title: "Daily routes" };
export const dynamic = "force-dynamic";

type Search = { date?: string; error?: string; ok?: string };

type Row = {
  id: string;
  code: string;
  name: string;
  status: string;
  route_date: string;
  drivers: { full_name: string } | null;
  vehicles: { registration: string } | null;
};

export default async function DailyRoutesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireCapability("routes.read");
  const routeDate = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : today();

  return (
    <div className="space-y-6">
      <FlashMessages error={params.error} ok={params.ok} />
      <PageHeader
        title="Daily routes"
        description="Execution for a specific day: driver, vehicle, stops and run progress."
      />

      <form method="get" action="/routes/daily" className="flex flex-wrap items-end gap-2">
        <Field label="Date" name="date">
          <Input name="date" type="date" defaultValue={routeDate} />
        </Field>
        <button type="submit" className="rounded-md border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-muted">
          Show
        </button>
      </form>

      <Suspense key={routeDate} fallback={<SkeletonRows rows={5} />}>
        <RouteList routeDate={routeDate} />
      </Suspense>

      {can(session.role, "routes.write") ? (
        <Card title="Generate routes"
              description="Creates a daily route and its jobs from every active template that runs on that weekday. Running it twice is safe.">
          <form action={generateDailyRoutes} className="flex flex-wrap items-end gap-3">
            <Field label="Route date" name="route_date" required>
              <Input name="route_date" type="date" required defaultValue={routeDate} />
            </Field>
            <SubmitButton pendingLabel="Generating…">Generate</SubmitButton>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

async function RouteList({ routeDate }: { routeDate: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("daily_routes")
    .select("id, code, name, status, route_date, drivers(full_name), vehicles(registration)")
    .eq("route_date", routeDate)
    .is("deleted_at", null)
    .order("code")
    .returns<Row[]>();

  return (
    <Card title={`Routes for ${date(routeDate)}`}>
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/routes/daily/${row.id}`}
        empty={
          <EmptyState
            title="No routes for this date"
            description="Generate them from your templates, or pick another date."
          />
        }
        columns={[
          { header: "Route", cell: (row) => row.code },
          { header: "Name", cell: (row) => row.name, hideBelow: "sm" },
          { header: "Driver", cell: (row) => row.drivers?.full_name ?? "Unassigned" },
          { header: "Vehicle", cell: (row) => row.vehicles?.registration ?? "Unassigned", hideBelow: "md" },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
    </Card>
  );
}
