import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, dateTime, time } from "@/lib/format";
import type { DailyRoute, Driver, Vehicle } from "@/lib/db/types";
import {
  Button, ButtonLink, Card, DataTable, EmptyState, Notice,
  PageHeader, SkeletonRows, StatusBadge, humanise,
} from "@/components/ui";
import { Field, FormActions, Select, SubmitButton, Textarea } from "@/components/form";
import { assignRoute, setRouteStatus } from "../actions";

export const dynamic = "force-dynamic";

type JobRow = {
  id: string;
  job_number: string;
  sequence: number;
  service_type: string;
  status: string;
  progress_status: string;
  completed_at: string | null;
  customers: { business_name: string } | null;
  customer_locations: { name: string; suburb: string | null } | null;
};

/** The run states a dispatcher can drive from the office, in workflow order. */
const NEXT_STATUS: Array<{ from: string[]; to: string; label: string }> = [
  { from: ["planned"], to: "inspection_pending", label: "Request inspection" },
  { from: ["load_confirmed", "inspection_complete"], to: "in_progress", label: "Start route" },
  { from: ["in_progress"], to: "returning", label: "Mark returning" },
  { from: ["returning"], to: "unloading", label: "Mark unloading" },
  { from: ["unloading"], to: "closed", label: "Close run" },
];

export default async function DailyRouteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireCapability("routes.read");
  const writable = can(session.role, "routes.write");

  const supabase = await createClient();
  const { data: route } = await supabase
    .from("daily_routes")
    .select("id, route_date, code, name, status, driver_id, vehicle_id, depot_id, template_id, inspection_id, load_confirmed_at, started_at, returned_at, unloaded_at, closed_at, odometer_start_km, odometer_end_km, notes")
    .eq("id", id)
    .maybeSingle<DailyRoute>();

  if (!route) notFound();

  const blockers = [
    !route.inspection_id && "vehicle inspection not recorded",
    !route.load_confirmed_at && "load not confirmed",
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${route.code} · ${date(route.route_date)}`}
        description={route.name}
        actions={
          <>
            <StatusBadge status={route.status} />
            <ButtonLink href={`/routes/daily/${id}/sheet`}>Route sheet</ButtonLink>
          </>
        }
      />

      {blockers.length && !["closed", "cancelled"].includes(route.status) ? (
        <Notice tone="warning" title="This run cannot start yet">
          {blockers.join(" · ")}. The database refuses the transition until both are done.
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Run progress" className="lg:col-span-2">
          <ol className="grid gap-2 sm:grid-cols-2">
            <Step label="Inspection" value={route.inspection_id ? "Recorded" : "Outstanding"} done={!!route.inspection_id} />
            <Step label="Load confirmed" value={dateTime(route.load_confirmed_at)} done={!!route.load_confirmed_at} />
            <Step label="Started" value={dateTime(route.started_at)} done={!!route.started_at} />
            <Step label="Returned" value={dateTime(route.returned_at)} done={!!route.returned_at} />
            <Step label="Unloaded" value={dateTime(route.unloaded_at)} done={!!route.unloaded_at} />
            <Step label="Closed" value={dateTime(route.closed_at)} done={!!route.closed_at} />
          </ol>

          {writable ? (
            <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
              {NEXT_STATUS.filter((step) => step.from.includes(route.status)).map((step) => (
                <form key={step.to} action={setRouteStatus}>
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="status" value={step.to} />
                  <Button variant="primary">{step.label}</Button>
                </form>
              ))}
              {!["closed", "cancelled"].includes(route.status) ? (
                <form action={setRouteStatus}>
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="status" value="cancelled" />
                  <Button variant="danger">Cancel run</Button>
                </form>
              ) : null}
            </div>
          ) : null}
        </Card>

        {writable ? (
          <Suspense fallback={<SkeletonRows rows={3} />}>
            <Assignment route={route} />
          </Suspense>
        ) : null}
      </div>

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <Stops routeId={id} />
      </Suspense>
    </div>
  );
}

function Step({ label, value, done }: { label: string; value: string; done: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        <span aria-hidden className={done ? "text-success" : "text-muted-foreground"}>{done ? "●" : "○"}</span>
        {label}
      </span>
      <span className="text-muted-foreground">{value}</span>
    </li>
  );
}

async function Assignment({ route }: { route: DailyRoute }) {
  const supabase = await createClient();
  const [{ data: drivers }, { data: vehicles }] = await Promise.all([
    supabase.from("drivers").select("id, full_name").eq("status", "active").order("full_name")
      .returns<Pick<Driver, "id" | "full_name">[]>(),
    supabase.from("vehicles").select("id, registration, vehicle_type")
      .eq("status", "active").neq("maintenance_status", "out_of_service").order("registration")
      .returns<Pick<Vehicle, "id" | "registration" | "vehicle_type">[]>(),
  ]);

  const trucks = (vehicles ?? []).filter((vehicle) => vehicle.vehicle_type !== "trailer");
  const trailers = (vehicles ?? []).filter((vehicle) => vehicle.vehicle_type === "trailer");

  return (
    <form action={assignRoute}>
      <Card title="Assignment" description="Assigning a driver also assigns the route's jobs.">
        <input type="hidden" name="id" value={route.id} />
        <div className="space-y-4">
          <Field label="Driver" name="driver_id">
            <Select name="driver_id" placeholder="Unassigned" defaultValue={route.driver_id}
                    options={(drivers ?? []).map((driver) => ({ value: driver.id, label: driver.full_name }))} />
          </Field>
          <Field label="Vehicle" name="vehicle_id">
            <Select name="vehicle_id" placeholder="Unassigned" defaultValue={route.vehicle_id}
                    options={trucks.map((vehicle) => ({ value: vehicle.id, label: vehicle.registration }))} />
          </Field>
          {trailers.length ? (
            <Field label="Trailer" name="trailer_id">
              <Select name="trailer_id" placeholder="None"
                      options={trailers.map((trailer) => ({ value: trailer.id, label: trailer.registration }))} />
            </Field>
          ) : null}
          <Field label="Notes" name="notes">
            <Textarea name="notes" rows={2} defaultValue={route.notes} />
          </Field>
        </div>
        <div className="mt-4">
          <FormActions>
            <SubmitButton>Save assignment</SubmitButton>
          </FormActions>
        </div>
      </Card>
    </form>
  );
}

async function Stops({ routeId }: { routeId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("jobs")
    .select("id, job_number, sequence, service_type, status, progress_status, completed_at, " +
            "customers(business_name), customer_locations(name, suburb)")
    .eq("route_id", routeId).order("sequence")
    .returns<JobRow[]>();

  return (
    <Card title={`Stops · ${data?.length ?? 0}`}>
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/jobs/${row.id}`}
        empty={<EmptyState title="This route has no jobs" description="Regenerate it, or add jobs manually." />}
        columns={[
          { header: "#", cell: (row) => row.sequence },
          { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
          {
            header: "Site",
            cell: (row) => [row.customer_locations?.name, row.customer_locations?.suburb].filter(Boolean).join(" · ") || "—",
            hideBelow: "md",
          },
          { header: "Service", cell: (row) => humanise(row.service_type), hideBelow: "sm" },
          { header: "Progress", cell: (row) => <StatusBadge status={row.progress_status} /> },
          { header: "Completed", cell: (row) => time(row.completed_at?.slice(11)), hideBelow: "lg" },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
    </Card>
  );
}
