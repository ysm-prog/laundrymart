import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, relativeDays, today } from "@/lib/format";
import type { Depot, Driver } from "@/lib/db/types";
import {
  Badge, Card, DataTable, EmptyState, FlashMessages, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { createDriver } from "./actions";

export const metadata = { title: "Drivers" };
export const dynamic = "force-dynamic";

export default async function DriversPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const params = await searchParams;
  const session = await requireCapability("fleet.read");

  return (
    <div className="space-y-6">
      <FlashMessages error={params.error} ok={params.ok} />
      <PageHeader
        title="Drivers"
        description="Link a driver to a login so their run — and only their run — appears on their device."
      />

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <DriverList />
      </Suspense>

      {can(session.role, "fleet.write") ? (
        <Suspense fallback={null}>
          <NewDriverForm />
        </Suspense>
      ) : null}
    </div>
  );
}

async function DriverList() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("drivers")
    .select("id, full_name, employee_number, email, phone, licence_number, licence_expiry, depot_id, user_id, status")
    .is("deleted_at", null)
    .order("full_name")
    .returns<Driver[]>();

  const now = today();

  return (
    <DataTable
      rows={data ?? []}
      empty={<EmptyState title="No drivers yet" description="Add drivers before assigning daily routes." />}
      columns={[
        { header: "Driver", cell: (row) => <span className="font-medium">{row.full_name}</span> },
        { header: "Employee #", cell: (row) => row.employee_number ?? "—", hideBelow: "md" },
        { header: "Phone", cell: (row) => row.phone ?? "—", hideBelow: "sm" },
        {
          header: "Licence",
          cell: (row) => {
            if (!row.licence_expiry) return "—";
            const days = relativeDays(now, row.licence_expiry);
            if (days < 0) return <Badge tone="danger">Expired {date(row.licence_expiry)}</Badge>;
            if (days <= 30) return <Badge tone="warning">Expires {date(row.licence_expiry)}</Badge>;
            return date(row.licence_expiry);
          },
          hideBelow: "lg",
        },
        {
          header: "Login",
          cell: (row) => (row.user_id
            ? <Badge tone="success">Linked</Badge>
            : <Badge tone="warning">Not linked</Badge>),
        },
        { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
      ]}
    />
  );
}

async function NewDriverForm() {
  const supabase = await createClient();
  const { data: depots } = await supabase
    .from("depots").select("id, name").eq("status", "active").order("name")
    .returns<Pick<Depot, "id" | "name">[]>();

  return (
    <Card title="Add a driver">
      <form action={createDriver} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Full name" name="full_name" required>
          <Input name="full_name" required />
        </Field>
        <Field label="Employee number" name="employee_number"><Input name="employee_number" /></Field>
        <Field label="Email" name="email"><Input name="email" type="email" /></Field>
        <Field label="Phone" name="phone"><Input name="phone" type="tel" /></Field>
        <Field label="Licence number" name="licence_number"><Input name="licence_number" /></Field>
        <Field label="Licence expiry" name="licence_expiry">
          <Input name="licence_expiry" type="date" />
        </Field>
        <Field label="Depot" name="depot_id">
          <Select name="depot_id" placeholder="Unassigned"
                  options={(depots ?? []).map((depot) => ({ value: depot.id, label: depot.name }))} />
        </Field>
        <Field label="Status" name="status">
          <Select name="status" defaultValue="active" options={[
            { value: "active", label: "Active" },
            { value: "on_leave", label: "On leave" },
            { value: "inactive", label: "Inactive" },
          ]} />
        </Field>
        <Field label="Login user ID" name="user_id"
               hint="Optional — paste from Administration → Users to link their app login">
          <Input name="user_id" placeholder="00000000-0000-0000-0000-000000000000" />
        </Field>
        <div className="flex items-end lg:col-span-2">
          <SubmitButton>Add driver</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
