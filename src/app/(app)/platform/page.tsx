import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import {
  Badge, Card, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { createTenant, switchTenant, updateTenant } from "./actions";

export const metadata = { title: "Laundries" };
export const dynamic = "force-dynamic";

type TenantRow = {
  id: string;
  name: string;
  abn: string | null;
  timezone: string;
  status: string;
  created_at: string;
};

const TIMEZONES = [
  // Adelaide leads because that is where this business is; the rest follow in
  // population order. The list is the same set either way — only the default
  // and the first thing an owner sees have moved.
  "Australia/Adelaide", "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
  "Australia/Perth", "Australia/Hobart", "Australia/Darwin",
].map((value) => ({ value, label: value.replace("Australia/", "") }));

const STATUSES = [
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "archived", label: "Archived" },
];

export default async function PlatformPage() {
  const session = await requireCapability("platform.read");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Laundries"
        description="Every business running on this system. You are looking at one of them at a time — switching changes what the rest of the app shows you."
      />

      <Suspense fallback={<SkeletonRows rows={4} />}>
        <TenantList activeTenantId={session.tenantId} />
      </Suspense>

      <Card
        title="Add a laundry"
        description="It starts empty. Invite its owner from People once you have switched to it."
      >
        <form action={createTenant} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Business name" name="name" required>
            <Input name="name" required placeholder="Adelaide Towel Service" />
          </Field>
          <Field label="ABN" name="abn" hint="Optional. Shown on their invoices.">
            <Input name="abn" inputMode="numeric" placeholder="12 345 678 901" />
          </Field>
          <Field label="Timezone" name="timezone">
            <Select name="timezone" defaultValue="Australia/Adelaide" options={TIMEZONES} />
          </Field>
          <div className="flex items-end">
            <SubmitButton pendingLabel="Adding…">Add laundry</SubmitButton>
          </div>
        </form>
      </Card>
    </div>
  );
}

async function TenantList({ activeTenantId }: { activeTenantId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tenants")
    .select("id, name, abn, timezone, status, created_at")
    .order("name")
    .returns<TenantRow[]>();

  const tenants = data ?? [];
  if (tenants.length === 0) {
    return (
      <EmptyState
        title="No laundries yet"
        description="Add the first one below."
      />
    );
  }

  return (
    <Card bodyClassName="p-0">
      <DataTable
        bare
        label="Laundries"
        rows={tenants}
        empty={<EmptyState title="No laundries yet" description="Add the first one below." />}
        columns={[
          {
            header: "Laundry",
            cell: (row) => (
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  {row.id === activeTenantId ? (
                    <Badge tone="primary">you are here</Badge>
                  ) : null}
                </div>
                <span className="block text-xs text-muted-foreground">
                  {row.abn ? `ABN ${row.abn} · ` : ""}{row.timezone.replace("Australia/", "")}
                </span>
              </div>
            ),
          },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
          {
            header: "Rename or suspend",
            cell: (row) => (
              <form action={updateTenant} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="tenant_id" value={row.id} />
                <Field label="Name" name={`name-${row.id}`}>
                  <Input name="name" defaultValue={row.name} required />
                </Field>
                <Field label="Status" name={`status-${row.id}`}>
                  <Select name="status" defaultValue={row.status} options={STATUSES} />
                </Field>
                <SubmitButton variant="secondary" pendingLabel="Saving…">Save</SubmitButton>
              </form>
            ),
          },
          {
            header: "",
            cell: (row) => (row.id === activeTenantId ? null : (
              <form action={switchTenant}>
                <input type="hidden" name="tenant_id" value={row.id} />
                <SubmitButton variant="secondary" pendingLabel="Switching…">
                  Look at this one
                </SubmitButton>
              </form>
            )),
          },
        ]}
      />
    </Card>
  );
}
