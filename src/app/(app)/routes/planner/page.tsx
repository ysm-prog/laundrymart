import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { date as formatDate, today } from "@/lib/format";
import {
  ButtonLink, Card, EmptyState, FlashMessages, PageHeader, SkeletonRows, Stat, cx,
} from "@/components/ui";
import { Field, Input } from "@/components/form";
import { applyDispatchPlan } from "./actions";
import { UNASSIGNED, averageWeights, lockReason } from "./plan";
import {
  PlannerBoard, type Option, type PlannerColumn, type PlannerJob,
} from "./planner-board";

export const metadata = { title: "Dispatch planner" };
export const dynamic = "force-dynamic";

type Search = { date?: string; error?: string; ok?: string };

/**
 * The dispatch planner (design pack, screen 03).
 *
 * A day laid out as one board — every run for the date as a column, plus a tray
 * of stops that have no run yet — so the decision "who takes this stop" is made
 * against the whole day rather than by opening two route pages side by side.
 */
export default async function DispatchPlannerPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  await requireCapability("routes.write");
  const routeDate = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : today();

  return (
    <div className="space-y-4">
      <FlashMessages error={params.error} ok={params.ok} />
      <PageHeader
        eyebrow={formatDate(routeDate)}
        title="Dispatch planner"
        description="Arrange the whole day, then apply it in one go."
        actions={<ButtonLink href={`/routes/daily?date=${routeDate}`}>Route list</ButtonLink>}
      />

      <form method="get" action="/routes/planner" className="flex flex-wrap items-end gap-2">
        <Field label="Date" name="date">
          <Input name="date" type="date" defaultValue={routeDate} />
        </Field>
        <button type="submit"
                className="border border-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium hover:bg-surface-muted">
          Show
        </button>
      </form>

      <Suspense key={routeDate} fallback={<SkeletonRows rows={8} />}>
        <Board routeDate={routeDate} />
      </Suspense>
    </div>
  );
}

type RouteRow = {
  id: string; code: string; name: string; status: string;
  driver_id: string | null; vehicle_id: string | null;
};

type JobRow = {
  id: string; job_number: string; route_id: string | null; sequence: number;
  service_type: string; status: string; progress_status: string; customer_id: string;
  customers: { business_name: string } | null;
  customer_locations: { name: string; suburb: string | null } | null;
};

async function Board({ routeDate }: { routeDate: string }) {
  const supabase = await createClient();

  const [routes, jobs, drivers, vehicles] = await Promise.all([
    supabase.from("daily_routes")
      .select("id, code, name, status, driver_id, vehicle_id")
      .eq("route_date", routeDate).is("deleted_at", null).order("code")
      .returns<RouteRow[]>(),
    supabase.from("jobs")
      .select("id, job_number, route_id, sequence, service_type, status, progress_status, " +
              "customer_id, customers(business_name), customer_locations(name, suburb)")
      .eq("scheduled_date", routeDate).is("deleted_at", null)
      .order("sequence")
      .returns<JobRow[]>(),
    supabase.from("drivers").select("id, full_name")
      .eq("status", "active").is("deleted_at", null).order("full_name")
      .returns<Array<{ id: string; full_name: string }>>(),
    supabase.from("vehicles").select("id, registration, vehicle_type, capacity_kg, maintenance_status")
      .eq("status", "active").is("deleted_at", null).order("registration")
      .returns<Array<{
        id: string; registration: string; vehicle_type: string;
        capacity_kg: number | string | null; maintenance_status: string;
      }>>(),
  ]);

  const routeRows = routes.data ?? [];
  const jobRows = jobs.data ?? [];

  if (routeRows.length === 0 && jobRows.length === 0) {
    return (
      <Card title={`Board for ${formatDate(routeDate)}`}>
        <EmptyState
          title="Nothing scheduled for this date"
          description="Generate the day's routes from your templates first, then come back to arrange them."
          action={<ButtonLink href={`/routes/daily?date=${routeDate}`} variant="primary">Generate routes</ButtonLink>}
        />
      </Card>
    );
  }

  // Recent weighed collections, newest first, for the customers on the board.
  // The estimate never leaves this date's customers, so a big tenant does not
  // pay for a full-history scan to draw one meter.
  const customerIds = [...new Set(jobRows.map((job) => job.customer_id))];
  const { data: weighed } = customerIds.length
    ? await supabase.from("pickups")
        .select("customer_id, total_weight_kg, pickup_date")
        .in("customer_id", customerIds)
        .gt("total_weight_kg", 0)
        .order("pickup_date", { ascending: false })
        .limit(Math.min(1000, customerIds.length * 12))
        .returns<Array<{ customer_id: string; total_weight_kg: number | string | null }>>()
    : { data: [] as Array<{ customer_id: string; total_weight_kg: number | string | null }> };

  const averages = averageWeights(weighed ?? []);

  const jobsById: Record<string, PlannerJob> = {};
  for (const job of jobRows) {
    jobsById[job.id] = {
      id: job.id,
      jobNumber: job.job_number,
      customer: job.customers?.business_name ?? "Unknown customer",
      site: [job.customer_locations?.name, job.customer_locations?.suburb].filter(Boolean).join(" · ") || "—",
      serviceType: job.service_type,
      status: job.status,
      lockedBecause: lockReason(job),
      estimateKg: averages.get(job.customer_id) ?? null,
    };
  }

  // Trailers cannot be a run's prime vehicle, and something off the road cannot
  // be planned onto one — but a run that is already on an out-of-service vehicle
  // keeps it in the list, or the board would silently unassign it on apply.
  const assignedVehicleIds = new Set(routeRows.map((route) => route.vehicle_id).filter(Boolean));
  const vehicleOptions: Option[] = (vehicles.data ?? [])
    .filter((vehicle) => vehicle.vehicle_type !== "trailer")
    .filter((vehicle) => vehicle.maintenance_status !== "out_of_service" || assignedVehicleIds.has(vehicle.id))
    .map((vehicle) => ({
      value: vehicle.id,
      label: vehicle.capacity_kg
        ? `${vehicle.registration} · ${Math.round(Number(vehicle.capacity_kg))} kg`
        : vehicle.registration,
      capacityKg: vehicle.capacity_kg == null ? null : Number(vehicle.capacity_kg),
    }));

  const driverOptions: Option[] = (drivers.data ?? [])
    .map((driver) => ({ value: driver.id, label: driver.full_name }));

  const capacityById = new Map(vehicleOptions.map((option) => [option.value, option.capacityKg ?? null]));

  const columns: PlannerColumn[] = [
    {
      id: UNASSIGNED,
      code: "Unassigned",
      name: "No run yet",
      status: null,
      open: true,
      driverId: "",
      vehicleId: "",
      capacityKg: null,
      jobIds: jobRows.filter((job) => !job.route_id).map((job) => job.id),
    },
    ...routeRows.map((route) => ({
      id: route.id,
      code: route.code,
      name: route.name,
      status: route.status,
      open: !["closed", "cancelled"].includes(route.status),
      driverId: route.driver_id ?? "",
      vehicleId: route.vehicle_id ?? "",
      capacityKg: route.vehicle_id ? capacityById.get(route.vehicle_id) ?? null : null,
      jobIds: jobRows.filter((job) => job.route_id === route.id).map((job) => job.id),
    })),
  ];

  const unassigned = columns[0]!.jobIds.length;
  const exceptions = jobRows.filter((job) => job.status === "exception").length;
  const uncrewed = routeRows.filter((route) => !route.driver_id
    && !["closed", "cancelled"].includes(route.status)).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-px border bg-border sm:grid-cols-2 lg:grid-cols-4">
        <Stat flush label="Runs" value={String(routeRows.length)} hint={`${jobRows.length} stops in total`} />
        <Stat flush label="Unassigned stops" value={String(unassigned)}
              hint={unassigned === 0 ? "every stop has a run" : "waiting on a run"}
              tone={unassigned > 0 ? "warning" : "success"} />
        <Stat flush label="Runs without a driver" value={String(uncrewed)}
              hint={uncrewed === 0 ? "all crewed" : "assign before the day starts"}
              tone={uncrewed > 0 ? "warning" : "success"} />
        <Stat flush label="Exceptions" value={String(exceptions)}
              hint={exceptions === 0 ? "none on the board" : "may need re-dispatching"}
              tone={exceptions > 0 ? "danger" : "success"} />
      </div>

      <div className={cx("border bg-surface p-3")}>
        <PlannerBoard
          columns={columns}
          jobs={jobsById}
          drivers={driverOptions}
          vehicles={vehicleOptions}
          action={applyDispatchPlan}
        />
      </div>
    </div>
  );
}
