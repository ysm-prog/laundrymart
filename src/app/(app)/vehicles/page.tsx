import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, number } from "@/lib/format";
import type { Depot, Vehicle } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge, humanise,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { ListControls } from "@/components/list-controls";
import { FilterChips, FilterSummary } from "@/components/filters";
import { isFiltered } from "@/lib/filters";
import { createVehicle } from "./actions";

export const metadata = { title: "Vehicles" };
export const dynamic = "force-dynamic";

const VEHICLE_TYPES = ["van", "truck", "ute", "trailer", "prime_mover", "other"] as const;
const MAINTENANCE = ["ok", "due", "overdue", "in_service", "out_of_service"] as const;

type Search = { q?: string; maintenance?: string; type?: string; status?: string };
const FILTER_KEYS = ["q", "maintenance", "type", "status"] as const;

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireCapability("fleet.read");
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vehicles"
        description="Routes need a vehicle, so vehicles are first-class: capacity, maintenance state and trailers."
      />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={5} />}>
        <VehicleList params={params} />
      </Suspense>

      {can(session.role, "fleet.write") ? (
        <Suspense fallback={null}>
          <NewVehicleForm />
        </Suspense>
      ) : null}
    </div>
  );
}

async function VehicleList({ params }: { params: Search }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("vehicles")
    .select("id, registration, vin, make, model, year, vehicle_type, capacity_kg, fuel_type, maintenance_status, next_service_date, depot_id, status")
    .is("deleted_at", null)
    .order("registration")
    .returns<Vehicle[]>();

  const all = data ?? [];
  const matches = (row: Vehicle, override: Partial<Search> = {}) => {
    const f = { ...params, ...override };
    const term = f.q?.trim().toLowerCase();
    if (term && !`${row.registration} ${row.make ?? ""} ${row.model ?? ""} ${row.vin ?? ""}`
      .toLowerCase().includes(term)) return false;
    if (f.maintenance && row.maintenance_status !== f.maintenance) return false;
    if (f.type && row.vehicle_type !== f.type) return false;
    if (f.status && row.status !== f.status) return false;
    return true;
  };
  const rows = all.filter((row) => matches(row));
  const filtered = isFiltered(params, FILTER_KEYS);
  const countWith = (override: Partial<Search>) =>
    all.filter((row) => matches(row, override)).length;

  return (
    <>
    <ListControls
      action="/vehicles"
      q={params.q}
      params={params}
      filterKeys={FILTER_KEYS}
      placeholder="Registration, make, model or VIN…"
      filters={[
        { name: "type", label: "Vehicle type", value: params.type,
          options: VEHICLE_TYPES.map((value) => ({ value, label: humanise(value) })) },
        { name: "status", label: "Status", value: params.status,
          options: [
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ] },
      ]}
      chips={
        /* Maintenance leads, because it is the only question on this screen with
           a consequence today: a van that is overdue or out of service is one a
           run cannot be planned onto. */
        <FilterChips
          basePath="/vehicles" params={params} name="maintenance" label="Maintenance"
          allLabel="All vehicles" allCount={countWith({ maintenance: undefined })}
          options={MAINTENANCE.map((value) => ({
            value, label: humanise(value), count: countWith({ maintenance: value }),
          }))}
        />
      }
      summary={
        <FilterSummary basePath="/vehicles" shown={rows.length} total={all.length}
                       noun="vehicle" filtered={filtered} />
      }
    />
    <DataTable
      rows={rows}
      empty={filtered
        ? <EmptyState title="No vehicles match those filters"
                      description="Try a broader search, or clear the filters above." />
        : <EmptyState title="No vehicles yet" description="Add a vehicle before planning daily routes." />}
      columns={[
        { header: "Registration", cell: (row) => <span className="font-medium">{row.registration}</span> },
        {
          header: "Vehicle",
          cell: (row) => [row.year, row.make, row.model].filter(Boolean).join(" ") || humanise(row.vehicle_type),
          hideBelow: "sm",
        },
        { header: "Type", cell: (row) => humanise(row.vehicle_type), hideBelow: "md" },
        {
          header: "Capacity",
          cell: (row) => (row.capacity_kg ? `${number(row.capacity_kg)} kg` : "—"),
          align: "right", hideBelow: "lg",
        },
        { header: "Next service", cell: (row) => date(row.next_service_date), hideBelow: "lg" },
        { header: "Maintenance", cell: (row) => <StatusBadge status={row.maintenance_status} /> },
        { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
      ]}
    />
    </>
  );
}

async function NewVehicleForm() {
  const supabase = await createClient();
  const { data: depots } = await supabase
    .from("depots").select("id, name").eq("status", "active").order("name")
    .returns<Pick<Depot, "id" | "name">[]>();

  return (
    <Card title="Add a vehicle">
      <form action={createVehicle} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Registration" name="registration" required>
          <Input name="registration" required placeholder="ABC12D" />
        </Field>
        <Field label="Type" name="vehicle_type">
          <Select name="vehicle_type" defaultValue="van"
                  options={VEHICLE_TYPES.map((value) => ({ value, label: humanise(value) }))} />
        </Field>
        <Field label="Make" name="make"><Input name="make" /></Field>
        <Field label="Model" name="model"><Input name="model" /></Field>
        <Field label="Year" name="year"><Input name="year" type="number" min={1950} max={2100} /></Field>
        <Field label="VIN" name="vin"><Input name="vin" /></Field>
        <Field label="Capacity (kg)" name="capacity_kg">
          <Input name="capacity_kg" type="number" step="0.01" min={0} />
        </Field>
        <Field label="Fuel" name="fuel_type">
          <Select name="fuel_type" placeholder="—" options={[
            { value: "diesel", label: "Diesel" }, { value: "petrol", label: "Petrol" },
            { value: "electric", label: "Electric" }, { value: "hybrid", label: "Hybrid" },
            { value: "lpg", label: "LPG" },
          ]} />
        </Field>
        <Field label="Depot" name="depot_id">
          <Select name="depot_id" placeholder="Unassigned"
                  options={(depots ?? []).map((depot) => ({ value: depot.id, label: depot.name }))} />
        </Field>
        <Field label="Maintenance" name="maintenance_status">
          <Select name="maintenance_status" defaultValue="ok"
                  options={MAINTENANCE.map((value) => ({ value, label: humanise(value) }))} />
        </Field>
        <Field label="Next service" name="next_service_date">
          <Input name="next_service_date" type="date" />
        </Field>
        <Field label="Status" name="status">
          <Select name="status" defaultValue="active"
                  options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} />
        </Field>
        <div className="flex items-end lg:col-span-4">
          <SubmitButton>Add vehicle</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
