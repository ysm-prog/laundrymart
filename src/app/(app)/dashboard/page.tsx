import { Suspense } from "react";
import Link from "next/link";
import { requireSession, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { money, today } from "@/lib/format";
import {
  Card, DataTable, EmptyState, FlashMessages, PageHeader, SkeletonRows,
  SkeletonStats, Stat, StatusBadge,
} from "@/components/ui";

export const metadata = { title: "Dashboard" };

// Per-request session read; the heavy widgets stream in under Suspense.
export const dynamic = "force-dynamic";

const FORBIDDEN = "You do not have access to that area.";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession();
  const date = today();

  return (
    <div className="space-y-6">
      <FlashMessages error={params.error === "forbidden" ? FORBIDDEN : params.error} ok={params.ok} />
      <PageHeader
        title={`Good day, ${session.email?.split("@")[0] ?? "there"}`}
        description={`${session.tenantName} · ${date}`}
      />

      {can(session.role, "run.execute") ? (
        <Suspense fallback={<SkeletonStats count={3} />}>
          <DriverPanel session={session} date={date} />
        </Suspense>
      ) : null}

      {can(session.role, "routes.read") ? (
        <Suspense fallback={<SkeletonStats />}>
          <DispatchPanel date={date} />
        </Suspense>
      ) : null}

      {can(session.role, "invoices.read") ? (
        <Suspense fallback={<SkeletonStats count={3} />}>
          <FinancePanel date={date} />
        </Suspense>
      ) : null}

      {can(session.role, "admin.read") ? (
        <Suspense fallback={<SkeletonRows rows={3} />}>
          <AdminPanel />
        </Suspense>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- driver panel */

async function DriverPanel({ session, date }: { session: Session; date: string }) {
  const supabase = await createClient();

  const { data: driver } = await supabase
    .from("drivers").select("id, full_name").eq("user_id", session.userId).maybeSingle();

  if (!driver) {
    return (
      <Card title="Today's run">
        <EmptyState
          title="No driver profile linked to your account"
          description="Ask a dispatcher to link your login to a driver record."
        />
      </Card>
    );
  }

  const [{ data: route }, { count: stops }, { count: doneStops }] = await Promise.all([
    supabase.from("daily_routes")
      .select("id, code, name, status, load_confirmed_at, inspection_id")
      .eq("driver_id", driver.id).eq("route_date", date).maybeSingle(),
    supabase.from("jobs").select("id", { count: "exact", head: true })
      .eq("driver_id", driver.id).eq("scheduled_date", date),
    supabase.from("jobs").select("id", { count: "exact", head: true })
      .eq("driver_id", driver.id).eq("scheduled_date", date).eq("status", "completed"),
  ]);

  return (
    <Card
      title="Today's run"
      actions={route ? <Link href="/run" className="text-sm font-medium text-primary hover:underline">Open run →</Link> : null}
    >
      {route ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Route" value={route.code} hint={route.name} />
          <Stat label="Status" value={<StatusBadge status={route.status} />} />
          <Stat label="Stops done" value={`${doneStops ?? 0} / ${stops ?? 0}`} />
          <Stat
            label="Pre-start"
            value={route.inspection_id ? (route.load_confirmed_at ? "Ready" : "Load pending") : "Inspection due"}
            tone={route.inspection_id && route.load_confirmed_at ? "success" : "warning"}
          />
        </div>
      ) : (
        <EmptyState title="No run assigned for today" description="Check back later or contact your dispatcher." />
      )}
    </Card>
  );
}

/* --------------------------------------------------------- dispatch panel */

async function DispatchPanel({ date }: { date: string }) {
  const supabase = await createClient();

  const [routes, jobsToday, unassigned, exceptions, drivers] = await Promise.all([
    supabase.from("daily_routes")
      .select("id, code, name, status, route_date, driver_id, vehicle_id")
      .eq("route_date", date).order("code"),
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("scheduled_date", date),
    supabase.from("jobs").select("id", { count: "exact", head: true })
      .eq("scheduled_date", date).is("route_id", null),
    supabase.from("jobs").select("id", { count: "exact", head: true })
      .eq("scheduled_date", date).eq("status", "exception"),
    supabase.from("drivers").select("id", { count: "exact", head: true }).eq("status", "active"),
  ]);

  const routeRows = routes.data ?? [];
  const active = routeRows.filter((r) => ["in_progress", "returning", "unloading"].includes(r.status)).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Routes today" value={routeRows.length} hint={`${active} on the road`} href="/routes/daily" />
        <Stat label="Jobs today" value={jobsToday.count ?? 0} href="/jobs" />
        <Stat label="Unassigned jobs" value={unassigned.count ?? 0}
              tone={(unassigned.count ?? 0) > 0 ? "warning" : "default"} href="/jobs?status=unassigned" />
        <Stat label="Exceptions" value={exceptions.count ?? 0}
              tone={(exceptions.count ?? 0) > 0 ? "danger" : "default"} href="/operations/exceptions" />
      </div>

      <Card title="Today's routes" description={`${drivers.count ?? 0} active drivers`}>
        <DataTable
          rows={routeRows}
          rowHref={(row) => `/routes/daily/${row.id}`}
          empty={
            <EmptyState
              title="No routes planned for today"
              description="Generate today's routes from your route templates."
            />
          }
          columns={[
            { header: "Route", cell: (row) => row.code },
            { header: "Name", cell: (row) => row.name, hideBelow: "sm" },
            { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
            { header: "Driver", cell: (row) => (row.driver_id ? "Assigned" : "—"), hideBelow: "md" },
            { header: "Vehicle", cell: (row) => (row.vehicle_id ? "Assigned" : "—"), hideBelow: "md" },
          ]}
        />
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------- finance panel */

async function FinancePanel({ date }: { date: string }) {
  const supabase = await createClient();

  const [outstanding, overdue, paidThisMonth] = await Promise.all([
    supabase.from("invoices").select("balance").in("status", ["issued", "part_paid", "overdue"]),
    supabase.from("invoices").select("balance").lt("due_date", date).in("status", ["issued", "part_paid", "overdue"]),
    supabase.from("payments").select("amount").gte("paid_on", `${date.slice(0, 7)}-01`),
  ]);

  const sum = (rows: Array<{ balance?: number; amount?: number }> | null, key: "balance" | "amount") =>
    (rows ?? []).reduce((total, row) => total + Number(row[key] ?? 0), 0);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Stat label="Outstanding" value={money(sum(outstanding.data, "balance"))}
            hint={`${outstanding.data?.length ?? 0} open invoices`} href="/invoices" />
      <Stat label="Overdue" value={money(sum(overdue.data, "balance"))}
            tone={(overdue.data?.length ?? 0) > 0 ? "danger" : "default"}
            hint={`${overdue.data?.length ?? 0} past due`} href="/invoices?status=overdue" />
      <Stat label="Received this month" value={money(sum(paidThisMonth.data, "amount"))} tone="success" />
    </div>
  );
}

/* ------------------------------------------------------------ admin panel */

async function AdminPanel() {
  const supabase = await createClient();

  const [customers, agreements, depots, recent] = await Promise.all([
    supabase.from("customers").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("service_agreements").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("depots").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("audit_logs").select("id, entity, action, summary, created_at")
      .order("created_at", { ascending: false }).limit(6),
  ]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Active customers" value={customers.count ?? 0} href="/customers" />
        <Stat label="Active agreements" value={agreements.count ?? 0} href="/agreements" />
        <Stat label="Depots" value={depots.count ?? 0} href="/admin/depots" />
      </div>
      <Card title="Recent activity"
            actions={<Link href="/admin/audit" className="text-sm text-primary hover:underline">View all</Link>}>
        <DataTable
          rows={recent.data ?? []}
          empty={<EmptyState title="Nothing has happened yet" />}
          columns={[
            { header: "Entity", cell: (row) => row.entity },
            { header: "Action", cell: (row) => row.action },
            { header: "Detail", cell: (row) => row.summary ?? "—", hideBelow: "sm" },
          ]}
        />
      </Card>
    </div>
  );
}
