import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can, ROLES, ROLE_LABELS, type Role } from "@/lib/roles";
import { date } from "@/lib/format";
import type { Depot } from "@/lib/db/types";
import {
  Badge, Card, DataTable, EmptyState, FlashMessages, Notice, PageHeader, SkeletonRows,
} from "@/components/ui";
import { Select, SubmitButton } from "@/components/form";
import { updateMembership } from "../actions";

export const metadata = { title: "Users and roles" };
export const dynamic = "force-dynamic";

type Row = { user_id: string; role: string; depot_id: string | null; created_at: string };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const params = await searchParams;
  const session = await requireCapability("admin.read");

  return (
    <div className="space-y-6">
      <FlashMessages error={params.error} ok={params.ok} />
      <PageHeader
        title="Users and roles"
        description="Roles decide which areas a person sees. Row-level security in Postgres enforces the same boundary."
      />

      <Notice tone="info" title="Inviting people">
        Users are created through Supabase Auth. Once someone has signed in, add their
        membership row to grant access — then link them to a driver record if they drive.
      </Notice>

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <MembershipList canWrite={can(session.role, "admin.write")} currentUserId={session.userId} />
      </Suspense>

      <Card title="Role reference">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {ROLES.map((role) => (
            <div key={role} className="flex items-baseline justify-between gap-3 border-b py-1">
              <dt className="font-medium">{ROLE_LABELS[role]}</dt>
              <dd className="text-right text-xs text-muted-foreground">{ROLE_SUMMARY[role]}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

const ROLE_SUMMARY: Record<Role, string> = {
  super_admin: "Everything, including settings",
  operations_manager: "Everything except system settings",
  dispatcher: "Customers, routes, jobs, fleet, invoices",
  driver: "Their own run only",
  finance: "Invoices, payments, reports",
  warehouse_operator: "Warehouse workflow and inventory",
  customer_service: "Customers and day-to-day operations",
  sales: "Customers and service agreements",
  branch_manager: "Full depot operations",
  regional_manager: "Everything except system settings",
  auditor: "Read-only across the platform",
};

async function MembershipList({
  canWrite, currentUserId,
}: { canWrite: boolean; currentUserId: string }) {
  const supabase = await createClient();
  const [{ data: memberships }, { data: depots }] = await Promise.all([
    supabase.from("memberships").select("user_id, role, depot_id, created_at").order("created_at")
      .returns<Row[]>(),
    supabase.from("depots").select("id, name").eq("status", "active").order("name")
      .returns<Pick<Depot, "id" | "name">[]>(),
  ]);

  const depotName = new Map((depots ?? []).map((depot) => [depot.id, depot.name]));

  return (
    <Card title="Members" description="Only administrators can see and change this list.">
      <DataTable
        rows={memberships ?? []}
        empty={<EmptyState title="No memberships visible"
                           description="Administrators see the full list; other roles only see themselves." />}
        columns={[
          {
            header: "User",
            cell: (row) => (
              <span className="font-mono text-xs">
                {row.user_id.slice(0, 8)}…
                {row.user_id === currentUserId ? <Badge tone="primary">you</Badge> : null}
              </span>
            ),
          },
          { header: "Role", cell: (row) => ROLE_LABELS[row.role as Role] ?? row.role },
          { header: "Depot", cell: (row) => (row.depot_id ? depotName.get(row.depot_id) ?? "—" : "—"), hideBelow: "sm" },
          { header: "Since", cell: (row) => date(row.created_at), hideBelow: "md" },
          {
            header: "",
            align: "right",
            cell: (row) => (canWrite && row.user_id !== currentUserId ? (
              <form action={updateMembership} className="flex items-center justify-end gap-2">
                <input type="hidden" name="user_id" value={row.user_id} />
                <Select name="role" defaultValue={row.role}
                        options={ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }))} />
                <Select name="depot_id" placeholder="No depot" defaultValue={row.depot_id}
                        options={(depots ?? []).map((depot) => ({ value: depot.id, label: depot.name }))} />
                <SubmitButton variant="secondary" pendingLabel="Saving…">Save</SubmitButton>
              </form>
            ) : null),
          },
        ]}
      />
    </Card>
  );
}
