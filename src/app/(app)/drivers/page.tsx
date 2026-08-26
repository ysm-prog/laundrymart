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
import { ListControls } from "@/components/list-controls";
import { FilterChips, FilterSummary } from "@/components/filters";
import { isFiltered } from "@/lib/filters";
import { listMembers, staffMembers, type Member } from "@/lib/directory";
import { createDriver, linkDriverLogin } from "./actions";

export const metadata = { title: "Drivers" };
export const dynamic = "force-dynamic";

type Search = { q?: string; status?: string; depot?: string; link?: string };
const FILTER_KEYS = ["q", "status", "depot", "link"] as const;

const DRIVER_STATUSES = [
  { value: "active", label: "Active" },
  { value: "on_leave", label: "On leave" },
  { value: "inactive", label: "Inactive" },
] as const;

export default async function DriversPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireCapability("fleet.read");
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Drivers"
        description="Link a driver to a login so their run — and only their run — appears on their device."
      />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={5} />}>
        <DriverList params={params} canWrite={can(session.role, "admin.write")} />
      </Suspense>

      {can(session.role, "fleet.write") ? (
        <Suspense fallback={null}>
          <NewDriverForm />
        </Suspense>
      ) : null}
    </div>
  );
}

async function DriverList({ params, canWrite }: { params: Search; canWrite: boolean }) {
  const supabase = await createClient();
  const [{ data }, { data: depots }] = await Promise.all([
    supabase
      .from("drivers")
      .select("id, full_name, employee_number, email, phone, licence_number, licence_expiry, depot_id, user_id, status")
      .is("deleted_at", null)
      .order("full_name")
      .returns<Driver[]>(),
    supabase.from("depots").select("id, name").order("name")
      .returns<Pick<Depot, "id" | "name">[]>(),
  ]);

  const now = today();
  // Who could be linked: this laundry's people who are not already somebody's
  // login. Computed from every driver, not the filtered view — a login is taken
  // whether or not the driver holding it is on screen.
  const linkable = canWrite ? await linkableMembers(data ?? []) : [];

  /**
   * A laundry has tens of drivers, not thousands, so the list is read once and
   * narrowed here — which is what lets each chip carry the number of rows it
   * would actually show, given everything else already filtered.
   */
  const all = data ?? [];
  const matches = (row: Driver, override: Partial<Search> = {}) => {
    const f = { ...params, ...override };
    const term = f.q?.trim().toLowerCase();
    if (term && !`${row.full_name} ${row.employee_number ?? ""} ${row.phone ?? ""} ${row.email ?? ""}`
      .toLowerCase().includes(term)) return false;
    if (f.status && row.status !== f.status) return false;
    if (f.depot && row.depot_id !== f.depot) return false;
    if (f.link === "unlinked" && row.user_id) return false;
    if (f.link === "linked" && !row.user_id) return false;
    return true;
  };
  const rows = all.filter((row) => matches(row));
  const filtered = isFiltered(params, FILTER_KEYS);
  const countWith = (override: Partial<Search>) =>
    all.filter((row) => matches(row, override)).length;

  return (
    <>
    <ListControls
      action="/drivers"
      q={params.q}
      params={params}
      filterKeys={FILTER_KEYS}
      placeholder="Name, employee number or phone…"
      filters={(depots ?? []).length > 1 ? [{
        name: "depot", label: "Depot", value: params.depot,
        options: (depots ?? []).map((depot) => ({ value: depot.id, label: depot.name })),
      }] : []}
      chips={
        <>
          <FilterChips
            basePath="/drivers" params={params} name="status" label="Driver status"
            allLabel="All drivers" allCount={countWith({ status: undefined })}
            options={DRIVER_STATUSES.map((option) => ({
              ...option, count: countWith({ status: option.value }),
            }))}
          />
          {/* The link chip is the one that earns its place. An unlinked driver
              signs in successfully and sees an empty My Runs, which reads as a
              broken app — so "who is not linked?" has to be one press. */}
          <FilterChips
            basePath="/drivers" params={params} name="link" label="App login"
            allLabel="Linked or not" allCount={countWith({ link: undefined })}
            options={[
              { value: "unlinked", label: "No login yet", count: countWith({ link: "unlinked" }),
                title: "These drivers can sign in to nothing — My Runs is empty for them" },
              { value: "linked", label: "Has a login", count: countWith({ link: "linked" }) },
            ]}
          />
        </>
      }
      summary={
        <FilterSummary basePath="/drivers" shown={rows.length} total={all.length}
                       noun="driver" filtered={filtered} />
      }
    />
    <DataTable
      rows={rows}
      empty={filtered
        ? <EmptyState title="No drivers match those filters"
                      description="Try a broader search, or clear the filters above." />
        : <EmptyState title="No drivers yet" description="Add drivers before assigning daily routes." />}
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
                          value: member.id, label: `${member.label} · ${member.role}`,
                        }))} />
                <SubmitButton variant="secondary" pendingLabel="Linking…">Link</SubmitButton>
              </form>
            );
          },
        },
        { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
      ]}
    />
    </>
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
  const linkable = await linkableMembers(existing ?? []);

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
                    value: member.id, label: `${member.label} · ${member.role}`,
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
 * The laundry's people who are not already linked to a driver record.
 *
 * Deliberately **not** filtered to the `driver` role. A laundry that gives its
 * owner a van, or a manager who covers a run, is ordinary; refusing to link them
 * would leave the app insisting they cannot drive while they are out driving.
 * Roles decide what somebody may *do*; this link decides *which driver they are*.
 *
 * Platform administrators are out, like everywhere else people are picked from:
 * they administer the deployment rather than this business, and a van is very
 * much this business.
 */
async function linkableMembers(
  drivers: readonly Pick<Driver, "user_id">[],
): Promise<Member[]> {
  const taken = new Set((drivers ?? []).map((d) => d.user_id).filter(Boolean) as string[]);
  return staffMembers(await listMembers()).filter((member) => !taken.has(member.id));
}
