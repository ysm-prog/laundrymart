import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import type { Depot } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { ListControls } from "@/components/list-controls";
import { FilterChips, FilterSummary } from "@/components/filters";
import { isFiltered } from "@/lib/filters";
import { createDepot, updateDepotStatus } from "../actions";

export const metadata = { title: "Sites" };
export const dynamic = "force-dynamic";

const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]
  .map((state) => ({ value: state, label: state }));

const TIMEZONES = [
  // Adelaide leads because that is where this business is; the rest follow in
  // population order. The list is the same set either way — only the default
  // and the first thing an owner sees have moved.
  "Australia/Adelaide", "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
  "Australia/Perth", "Australia/Hobart", "Australia/Darwin",
].map((value) => ({ value, label: value.replace("Australia/", "") }));

type Search = { q?: string; status?: string };
const FILTER_KEYS = ["q", "status"] as const;

export default async function DepotsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireCapability("admin.read");
  const params = await searchParams;
  const writable = can(session.role, "admin.write");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sites"
        description="Each place you operate from. Runs, trucks, drivers and stock all belong to one site — most laundries only ever need one."
      />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={4} />}>
        <DepotList params={params} writable={writable} />
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
              <Select name="timezone" options={TIMEZONES} defaultValue="Australia/Adelaide" />
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

async function DepotList({ params, writable }: { params: Search; writable: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("depots")
    .select("id, code, name, suburb, state, timezone, contact_name, contact_phone, status")
    .is("deleted_at", null).order("code")
    .returns<Depot[]>();

  const all = data ?? [];
  const term = params.q?.trim().toLowerCase();
  const rows = all.filter((row) => {
    if (term && !`${row.code} ${row.name} ${row.suburb ?? ""}`.toLowerCase().includes(term)) {
      return false;
    }
    if (params.status && row.status !== params.status) return false;
    return true;
  });
  const filtered = isFiltered(params, FILTER_KEYS);
  const statusCount = (status: string) => all.filter((row) => row.status === status).length;

  return (
    <>
    {/* Most laundries have one site, and a filter bar over one row is furniture.
        It appears when there are enough sites to hunt through. */}
    {all.length > 3 ? (
      <ListControls
        action="/admin/depots"
        q={params.q}
        params={params}
        filterKeys={FILTER_KEYS}
        placeholder="Code, name or suburb…"
        chips={
          <FilterChips
            basePath="/admin/depots" params={params} name="status" label="Site status"
            allLabel="All sites" allCount={all.length}
            options={[
              { value: "active", label: "Active", count: statusCount("active") },
              { value: "inactive", label: "Inactive", count: statusCount("inactive") },
            ]}
          />
        }
        summary={
          <FilterSummary basePath="/admin/depots" shown={rows.length} total={all.length}
                         noun="site" filtered={filtered} />
        }
      />
    ) : null}
    <DataTable
      rows={rows}
      empty={filtered
        ? <EmptyState title="No sites match those filters"
                      description="Try a broader search, or clear the filters above." />
        : <EmptyState title="No depots yet" description="Add your first depot before creating routes." />}
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
    </>
  );
}
