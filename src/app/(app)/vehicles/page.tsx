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
import { createVehicle } from "./actions";

export const metadata = { title: "Vehicles" };
export const dynamic = "force-dynamic";

const VEHICLE_TYPES = ["van", "truck", "ute", "trailer", "prime_mover", "other"] as const;
const MAINTENANCE = ["ok", "due", "overdue", "in_service", "out_of_service"] as const;

export default async function VehiclesPage() {
  const session = await requireCapability("fleet.read");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vehicles"
        description="Routes need a vehicle, so vehicles are first-class: capacity, maintenance state and trailers."
      />

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <VehicleList />
      </Suspense>

      {can(session.role, "fleet.write") ? (
        <Suspense fallback={null}>
          <NewVehicleForm />
        </Suspense>
      ) : null}
    </div>
  );
}

async function VehicleList() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("vehicles")
    .select("id, registration, vin, make, model, year, vehicle_type, capacity_kg, fuel_type, maintenance_status, next_service_date, depot_id, status")
    .is("deleted_at", null)
    .order("registration")
    .returns<Vehicle[]>();

  return (
    <DataTable
      rows={data ?? []}
      empty={<EmptyState title="No vehicles yet" description="Add a vehicle before planning daily routes." />}
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
