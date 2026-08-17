import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, relativeDays, today } from "@/lib/format";
import type { Depot, Driver } from "@/lib/db/types";
import {
  Badge, Card, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { memberEmails, memberLabel } from "@/lib/members";
import { MEMBERSHIP_ROLES } from "@/lib/roles";
import { createDriver, linkDriverLogin } from "./actions";

export const metadata = { title: "Drivers" };
export const dynamic = "force-dynamic";

export default async function DriversPage() {
  const session = await requireCapability("fleet.read");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Drivers"
        description="Link a driver to a login so their run — and only their run — appears on their device."
      />

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <DriverList canWrite={can(session.role, "admin.write")} />
      </Suspense>

      {can(session.role, "fleet.write") ? (
        <Suspense fallback={null}>
          <NewDriverForm />
        </Suspense>
      ) : null}
    </div>
  );
}

async function DriverList({ canWrite }: { canWrite: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("drivers")
    .select("id, full_name, employee_number, email, phone, licence_number, licence_expiry, depot_id, user_id, status")
    .is("deleted_at", null)
    .order("full_name")
    .returns<Driver[]>();

  const now = today();
  // Who could be linked: this tenant's members who are not already somebody's
  // login. Read through the caller's own RLS-bound client, so the ids handed to
  // `memberEmails` are ones this session was already allowed to see.
  const linkable = canWrite ? await linkableMembers(supabase, data ?? []) : [];

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
          // **The link is what makes My Runs work at all.** `current_driver_id()`
          // matches `drivers.user_id` to the caller, so an unlinked driver signs
          // in to empty screens — which reads as a broken app rather than as a
          // missing link. This used to be a box asking for a raw UUID "from
          // Administration → Users", pasted from a screen that has shown emails
          // and not ids since the People rewrite. So it is a picker of the
          // tenant's own unlinked members instead.
          header: "Login",
          cell: (row) => {
            if (row.user_id) return <Badge tone="success">Linked</Badge>;
            if (!canWrite || linkable.length === 0) {
              return <Badge tone="warning">Not linked</Badge>;
            }
            return (
              <form action={linkDriverLogin} className="flex items-center gap-2">
                <input type="hidden" name="id" value={row.id} />
                <Select name="user_id" placeholder="Choose a login…" required
                        options={linkable.map((member) => ({
                          value: member.userId, label: member.label,
                        }))} />
                <SubmitButton variant="secondary" pendingLabel="Linking…">Link</SubmitButton>
              </form>
            );
          },
        },
        { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
      ]}
    />
  );
}

async function NewDriverForm() {
  const supabase = await createClient();
  const [{ data: depots }, { data: existing }] = await Promise.all([
    supabase.from("depots").select("id, name").eq("status", "active").order("name")
      .returns<Pick<Depot, "id" | "name">[]>(),
    supabase.from("drivers").select("user_id").is("deleted_at", null)
      .returns<Pick<Driver, "user_id">[]>(),
  ]);
  const linkable = await linkableMembers(supabase, existing ?? []);

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
        <Field label="App login" name="user_id"
               hint="Optional, and you can link it later. Without one they can sign in and My Runs is empty.">
          <Select name="user_id" placeholder="Link later"
                  options={linkable.map((member) => ({
                    value: member.userId, label: member.label,
                  }))} />
        </Field>
        <div className="flex items-end lg:col-span-2">
          <SubmitButton>Add driver</SubmitButton>
        </div>
      </form>
    </Card>
  );
}

/**
 * The tenant's members who are not already linked to a driver record.
 *
 * Deliberately **not** filtered to the `driver` role. A laundry that gives its
 * owner a van, or a manager who covers a run, is ordinary; refusing to link them
 * would leave the app insisting they cannot drive while they are out driving.
 * Roles decide what somebody may *do*; this link decides *which driver they are*.
 *
 * Both reads go through the caller's RLS-bound client, so the ids passed to
 * `memberEmails` are already ones this session may see — the admin client is
 * used only to turn an id into an address, never to discover one.
 */
async function linkableMembers(
  supabase: Awaited<ReturnType<typeof createClient>>,
  drivers: readonly Pick<Driver, "user_id">[],
): Promise<Array<{ userId: string; label: string }>> {
  const { data: memberships } = await supabase
    .from("memberships").select("user_id, role")
    .returns<Array<{ user_id: string; role: string }>>();

  const taken = new Set((drivers ?? []).map((d) => d.user_id).filter(Boolean) as string[]);
  const candidates = (memberships ?? [])
    .filter((m) => !taken.has(m.user_id))
    .filter((m) => (MEMBERSHIP_ROLES as readonly string[]).includes(m.role));

  const emails = await memberEmails(candidates.map((m) => m.user_id));
  return candidates
    .map((m) => ({ userId: m.user_id, label: memberLabel(m.user_id, emails.get(m.user_id)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
