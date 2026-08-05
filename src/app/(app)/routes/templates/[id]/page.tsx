import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { time } from "@/lib/format";
import type { CustomerLocation, Depot, Driver, RouteTemplate, Vehicle } from "@/lib/db/types";
import {
  Button, ButtonLink, Card, EmptyState, PageHeader, SkeletonRows,
  StatusBadge, humanise,
} from "@/components/ui";
import { Field, FormActions, Input, Select, SubmitButton, Textarea, WeekdayPicker } from "@/components/form";
import { StopSequencer } from "@/components/stop-sequencer";
import {
  addTemplateStop, duplicateTemplate, removeTemplateStop, reorderTemplateStops, updateTemplate,
} from "../actions";

export const dynamic = "force-dynamic";

type StopRow = {
  id: string;
  sequence: number;
  service_type: string;
  planned_arrival: string | null;
  service_minutes: number;
  notes: string | null;
  customers: { business_name: string; customer_number: string } | null;
  customer_locations: { name: string; suburb: string | null } | null;
};

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireCapability("routes.read");
  const writable = can(session.role, "routes.write");

  const supabase = await createClient();
  const { data: template } = await supabase
    .from("route_templates")
    .select("id, code, name, description, weekdays, depot_id, default_driver_id, default_vehicle_id, planned_start_time, status")
    .eq("id", id)
    .maybeSingle<RouteTemplate>();

  if (!template) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${template.code} · ${template.name}`}
        description={template.description ?? "Stops run in the order below on every generated daily route."}
        actions={
          <>
            <StatusBadge status={template.status} />
            <ButtonLink href={`/routes/daily?template=${id}`}>Today&apos;s runs</ButtonLink>
            {writable ? (
              <form action={duplicateTemplate}>
                <input type="hidden" name="id" value={id} />
                <Button variant="secondary">Duplicate</Button>
              </form>
            ) : null}
          </>
        }
      />

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <Stops templateId={id} writable={writable} />
      </Suspense>

      {writable ? (
        <Suspense fallback={<SkeletonRows rows={4} />}>
          <TemplateSettings template={template} />
        </Suspense>
      ) : null}
    </div>
  );
}

async function Stops({ templateId, writable }: { templateId: string; writable: boolean }) {
  const supabase = await createClient();
  const [{ data: stops }, { data: customers }, { data: locations }] = await Promise.all([
    supabase.from("route_template_stops")
      .select("id, sequence, service_type, planned_arrival, service_minutes, notes, " +
              "customers(business_name, customer_number), customer_locations(name, suburb)")
      .eq("template_id", templateId).order("sequence")
      .returns<StopRow[]>(),
    supabase.from("customers").select("id, business_name, customer_number")
      .is("deleted_at", null).eq("status", "active").order("business_name"),
    supabase.from("customer_locations").select("id, name, customer_id")
      .is("deleted_at", null).order("name")
      .returns<Pick<CustomerLocation, "id" | "name" | "customer_id">[]>(),
  ]);

  const rows = stops ?? [];

  return (
    <Card
      title={`Stops · ${rows.length}`}
      description={writable ? "Drag to reorder, or use the arrow buttons." : undefined}
    >
      {rows.length === 0 ? (
        <EmptyState title="No stops yet" description="Add the customers this route services, in order." />
      ) : writable ? (
        <StopSequencer
          templateId={templateId}
          action={reorderTemplateStops}
          stops={rows.map((stop) => ({
            id: stop.id,
            title: stop.customers?.business_name ?? "Unknown customer",
            subtitle: [stop.customer_locations?.name, stop.customer_locations?.suburb]
              .filter(Boolean).join(" · ") || undefined,
            meta: `${humanise(stop.service_type)} · ${stop.service_minutes} min${
              stop.planned_arrival ? ` · ${time(stop.planned_arrival)}` : ""}`,
          }))}
        />
      ) : (
        <ol className="space-y-2">
          {rows.map((stop) => (
            <li key={stop.id} className="flex items-center gap-3 rounded-md border p-3 text-sm">
              <span className="w-6 font-semibold tabular-nums text-muted-foreground">{stop.sequence}</span>
              <span className="flex-1">{stop.customers?.business_name ?? "Unknown customer"}</span>
              <span className="text-xs text-muted-foreground">{humanise(stop.service_type)}</span>
            </li>
          ))}
        </ol>
      )}

      {writable ? (
        <>
          <form action={addTemplateStop} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
            <input type="hidden" name="template_id" value={templateId} />
            <Field label="Customer" name="customer_id" required>
              <Select name="customer_id" required placeholder="Choose a customer"
                      options={(customers ?? []).map((customer) => ({
                        value: customer.id,
                        label: `${customer.business_name} (${customer.customer_number})`,
                      }))} />
            </Field>
            <Field label="Site" name="location_id">
              <Select name="location_id" placeholder="Primary site"
                      options={(locations ?? []).map((location) => ({ value: location.id, label: location.name }))} />
            </Field>
            <Field label="Service" name="service_type">
              <Select name="service_type" defaultValue="both" options={[
                { value: "both", label: "Pickup + delivery" },
                { value: "pickup", label: "Pickup only" },
                { value: "delivery", label: "Delivery only" },
              ]} />
            </Field>
            <Field label="Planned arrival" name="planned_arrival">
              <Input name="planned_arrival" type="time" />
            </Field>
            <Field label="Service minutes" name="service_minutes">
              <Input name="service_minutes" type="number" min={0} defaultValue="15" />
            </Field>
            <Field label="Notes" name="notes">
              <Input name="notes" placeholder="Rear dock only" />
            </Field>
            <div className="flex items-end lg:col-span-3">
              <SubmitButton variant="secondary">Add stop</SubmitButton>
            </div>
          </form>

          {rows.length ? (
            <div className="mt-4 border-t pt-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Remove a stop
              </p>
              <div className="flex flex-wrap gap-2">
                {rows.map((stop) => (
                  <form key={stop.id} action={removeTemplateStop}>
                    <input type="hidden" name="id" value={stop.id} />
                    <input type="hidden" name="template_id" value={templateId} />
                    <button type="submit"
                            className="rounded-md border px-2 py-1 text-xs text-danger hover:bg-danger/5">
                      {stop.sequence}. {stop.customers?.business_name ?? "Stop"} ✕
                    </button>
                  </form>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

async function TemplateSettings({ template }: { template: RouteTemplate }) {
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
    <form action={updateTemplate}>
      <Card title="Template settings">
        <input type="hidden" name="id" value={template.id} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Code" name="code" required>
            <Input name="code" required defaultValue={template.code} />
          </Field>
          <Field label="Name" name="name" required>
            <Input name="name" required defaultValue={template.name} />
          </Field>
          <Field label="Planned start" name="planned_start_time">
            <Input name="planned_start_time" type="time" defaultValue={template.planned_start_time?.slice(0, 5)} />
          </Field>
          <Field label="Depot" name="depot_id">
            <Select name="depot_id" placeholder="Unassigned" defaultValue={template.depot_id}
                    options={(depots ?? []).map((depot) => ({ value: depot.id, label: depot.name }))} />
          </Field>
          <Field label="Default driver" name="default_driver_id">
            <Select name="default_driver_id" placeholder="Unassigned" defaultValue={template.default_driver_id}
                    options={(drivers ?? []).map((driver) => ({ value: driver.id, label: driver.full_name }))} />
          </Field>
          <Field label="Default vehicle" name="default_vehicle_id">
            <Select name="default_vehicle_id" placeholder="Unassigned" defaultValue={template.default_vehicle_id}
                    options={(vehicles ?? []).map((vehicle) => ({ value: vehicle.id, label: vehicle.registration }))} />
          </Field>
          <Field label="Runs on" name="weekdays" className="sm:col-span-2 lg:col-span-3">
            <WeekdayPicker name="weekdays" defaultValue={template.weekdays ?? []} />
          </Field>
          <Field label="Description" name="description" className="sm:col-span-2">
            <Textarea name="description" rows={2} defaultValue={template.description} />
          </Field>
          <Field label="Status" name="status">
            <Select name="status" defaultValue={template.status}
                    options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }]} />
          </Field>
        </div>
        <div className="mt-4">
          <FormActions>
            <SubmitButton>Save template</SubmitButton>
          </FormActions>
        </div>
      </Card>
    </form>
  );
}
