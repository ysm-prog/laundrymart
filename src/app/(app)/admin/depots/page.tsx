import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import type { Depot } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { createDepot, updateDepotStatus } from "../actions";

export const metadata = { title: "Sites" };
export const dynamic = "force-dynamic";

const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]
  .map((state) => ({ value: state, label: state }));

const TIMEZONES = [
  "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
  "Australia/Adelaide", "Australia/Perth", "Australia/Hobart", "Australia/Darwin",
].map((value) => ({ value, label: value.replace("Australia/", "") }));

export default async function DepotsPage() {
  const session = await requireCapability("admin.read");
  const writable = can(session.role, "admin.write");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sites"
        description="Each place you operate from. Runs, trucks, drivers and stock all belong to one site — most laundries only ever need one."
      />

      <Suspense fallback={<SkeletonRows rows={4} />}>
        <DepotList writable={writable} />
      </Suspense>

      {writable ? (
        <Card title="Add a depot">
          <form action={createDepot} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Code" name="code" required>
              <Input name="code" required placeholder="SYD" />
            </Field>
            <Field label="Name" name="name" required>
              <Input name="name" required placeholder="Sydney depot" />
            </Field>
            <Field label="Address" name="address_line1"><Input name="address_line1" /></Field>
            <Field label="Suburb" name="suburb"><Input name="suburb" /></Field>
            <Field label="State" name="state">
              <Select name="state" placeholder="—" options={AU_STATES} defaultValue="NSW" />
            </Field>
            <Field label="Postcode" name="postcode"><Input name="postcode" /></Field>
            <Field label="Contact" name="contact_name"><Input name="contact_name" /></Field>
            <Field label="Phone" name="contact_phone"><Input name="contact_phone" type="tel" /></Field>
            <Field label="Email" name="contact_email"><Input name="contact_email" type="email" /></Field>
            <Field label="Timezone" name="timezone">
              <Select name="timezone" options={TIMEZONES} defaultValue="Australia/Sydney" />
            </Field>
            <Field label="Status" name="status">
              <Select name="status" defaultValue="active"
                      options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} />
            </Field>
            <div className="flex items-end">
              <SubmitButton>Add depot</SubmitButton>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

async function DepotList({ writable }: { writable: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("depots")
    .select("id, code, name, suburb, state, timezone, contact_name, contact_phone, status")
    .is("deleted_at", null).order("code")
    .returns<Depot[]>();

  return (
    <DataTable
      rows={data ?? []}
      empty={<EmptyState title="No depots yet" description="Add your first depot before creating routes." />}
      columns={[
        { header: "Code", cell: (row) => row.code },
        { header: "Name", cell: (row) => row.name },
        {
          header: "Location",
          cell: (row) => [row.suburb, row.state].filter(Boolean).join(", ") || "—",
          hideBelow: "sm",
        },
        { header: "Timezone", cell: (row) => row.timezone.replace("Australia/", ""), hideBelow: "md" },
        { header: "Contact", cell: (row) => row.contact_name ?? "—", hideBelow: "lg" },
        { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        {
          header: "",
          align: "right",
          cell: (row) => (writable ? (
            <form action={updateDepotStatus}>
              <input type="hidden" name="id" value={row.id} />
              <input type="hidden" name="status" value={row.status === "active" ? "inactive" : "active"} />
              <button type="submit" className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-primary transition hover:bg-primary/8 hover:underline">
                {row.status === "active" ? "Deactivate" : "Activate"}
              </button>
            </form>
          ) : null),
        },
      ]}
    />
  );
}
