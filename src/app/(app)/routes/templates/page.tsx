import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { time } from "@/lib/format";
import type { Depot, Driver, RouteTemplate, Vehicle } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton, Textarea, WeekdayPicker } from "@/components/form";
import { createTemplate } from "./actions";

export const metadata = { title: "Weekly runs" };
export const dynamic = "force-dynamic";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function RouteTemplatesPage() {
  const session = await requireCapability("routes.read");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Weekly runs" eyebrow="Route templates"
        description="The planning model. A daily route is instantiated from a template for a specific date."
      />

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <TemplateList />
      </Suspense>

      {can(session.role, "routes.write") ? (
        <Suspense fallback={null}>
          <NewTemplateForm />
        </Suspense>
      ) : null}
    </div>
  );
}

async function TemplateList() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("route_templates")
    .select("id, code, name, description, weekdays, depot_id, default_driver_id, default_vehicle_id, planned_start_time, status")
    .is("deleted_at", null)
    .order("code")
    .returns<RouteTemplate[]>();

  return (
    <DataTable
      rows={data ?? []}
      rowHref={(row) => `/routes/templates/${row.id}`}
      empty={<EmptyState title="No route templates yet"
                         description="Build a template once, then generate a daily route from it every service day." />}
      columns={[
        { header: "Code", cell: (row) => row.code },
        { header: "Name", cell: (row) => row.name },
        {
          header: "Runs on",
          cell: (row) => (row.weekdays?.length
            ? row.weekdays.map((day) => DAY_NAMES[day - 1]).join(", ")
            : "—"),
          hideBelow: "sm",
        },
        { header: "Start", cell: (row) => time(row.planned_start_time), hideBelow: "md" },
        { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
      ]}
    />
  );
}

async function NewTemplateForm() {
  const supabase = await createClient();
  const [{ data: depots }, { data: drivers }, { data: vehicles }] = await Promise.all([
    supabase.from("depots").select("id, name").eq("status", "active").order("name")
      .returns<Pick<Depot, "id" | "name">[]>(),
    supabase.from("drivers").select("id, full_name").eq("status", "active").order("full_name")
      .returns<Pick<Driver, "id" | "full_name">[]>(),
    supabase.from("vehicles").select("id, registration").eq("status", "active").order("registration")
      .returns<Pick<Vehicle, "id" | "registration">[]>(),
  ]);

  return (
    <Card title="New template">
      <form action={createTemplate} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Code" name="code" required>
          <Input name="code" required placeholder="NORTH-AM" />
        </Field>
        <Field label="Name" name="name" required>
          <Input name="name" required placeholder="Northern beaches morning" />
        </Field>
        <Field label="Planned start" name="planned_start_time">
          <Input name="planned_start_time" type="time" />
        </Field>
        <Field label="Depot" name="depot_id">
          <Select name="depot_id" placeholder="Unassigned"
                  options={(depots ?? []).map((depot) => ({ value: depot.id, label: depot.name }))} />
        </Field>
        <Field label="Default driver" name="default_driver_id">
          <Select name="default_driver_id" placeholder="Unassigned"
                  options={(drivers ?? []).map((driver) => ({ value: driver.id, label: driver.full_name }))} />
        </Field>
        <Field label="Default vehicle" name="default_vehicle_id">
          <Select name="default_vehicle_id" placeholder="Unassigned"
                  options={(vehicles ?? []).map((vehicle) => ({ value: vehicle.id, label: vehicle.registration }))} />
        </Field>
        <Field label="Runs on" name="weekdays" className="sm:col-span-2 lg:col-span-3">
          <WeekdayPicker name="weekdays" />
        </Field>
        <Field label="Description" name="description" className="sm:col-span-2">
          <Textarea name="description" rows={2} />
        </Field>
        <Field label="Status" name="status">
          <Select name="status" defaultValue="active"
                  options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }]} />
        </Field>
        <div className="flex items-end lg:col-span-3">
          <SubmitButton>Create template</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
