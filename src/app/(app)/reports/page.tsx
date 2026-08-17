import { Suspense } from "react";
import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { can } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { date, money, number, relativeDays, today } from "@/lib/format";
import { addDays } from "@/lib/domain/dates";
import { generateServiceDates, parsePattern, type HolidayRule } from "@/lib/domain/service-calendar";
import {
  Card, DataTable, EmptyState, PageHeader, SkeletonRows,
  Stat, cx, humanise,
} from "@/components/ui";
import { PrintButton } from "@/components/print-button";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

/**
 * `money: true` marks a report built on invoices and payments.
 *
 * Those two tables are readable only through `can_read_billing()` since
 * migration 0017, so for a role without a billing capability the queries behind
 * them return nothing. A money report that renders as "$0 revenue" for a
 * dispatcher is worse than one they cannot open: it is a wrong answer that looks
 * like a right one. So the tabs are filtered instead.
 */
const REPORTS = [
  { key: "operations", label: "Daily operations" },
  { key: "revenue", label: "Revenue", money: true },
  { key: "receivables", label: "Outstanding payments", money: true },
  { key: "drivers", label: "Driver productivity" },
  { key: "vehicles", label: "Vehicle utilisation" },
  { key: "inventory", label: "Inventory position" },
  { key: "compliance", label: "Contract compliance" },
] as const;

type ReportKey = (typeof REPORTS)[number]["key"];
type Search = { report?: string; from?: string; to?: string };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireCapability("reports.read");

  // The money reports need a billing capability on top of `reports.read`, which
  // dispatch and sales hold without it. Resolved before the requested report is
  // read, so asking for one by URL lands on operations rather than on an empty
  // page of zeroes.
  const reports = REPORTS.filter((entry) => !("money" in entry) || can(session.role, "billing.read"));
  const report = (reports.find((r) => r.key === params.report)?.key ?? "operations") as ReportKey;
  const to = params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to) ? params.to : today();
  const from = params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from) ? params.from : addDays(to, -30);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description={`${date(from)} – ${date(to)}`}
        actions={<PrintButton label="Print" />}
      />

      <nav className="flex flex-wrap gap-2 print:hidden" aria-label="Reports">
        {reports.map((entry) => (
          <Link
            key={entry.key}
            href={`/reports?report=${entry.key}&from=${from}&to=${to}`}
            aria-current={entry.key === report ? "page" : undefined}
            className={cx(
              "rounded-md border px-3 py-1.5 text-sm font-medium transition",
              entry.key === report ? "border-primary bg-primary/10 text-primary" : "hover:bg-surface-muted",
            )}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      <form method="get" action="/reports" className="flex flex-wrap items-end gap-2 print:hidden">
        <input type="hidden" name="report" value={report} />
        <label className="text-sm">
          <span className="mb-1 block font-medium">From</span>
          <input type="date" name="from" defaultValue={from} className="rounded-md border bg-surface px-3 py-2 text-sm" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">To</span>
          <input type="date" name="to" defaultValue={to} className="rounded-md border bg-surface px-3 py-2 text-sm" />
        </label>
        <button type="submit" className="rounded-md border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-muted">
          Run report
        </button>
      </form>

      <Suspense key={`${report}:${from}:${to}`} fallback={<SkeletonRows rows={8} />}>
        {report === "operations" ? <Operations from={from} to={to} /> : null}
        {report === "revenue" ? <Revenue from={from} to={to} /> : null}
        {report === "receivables" ? <Receivables /> : null}
        {report === "drivers" ? <DriverProductivity from={from} to={to} /> : null}
        {report === "vehicles" ? <VehicleUtilisation from={from} to={to} /> : null}
        {report === "inventory" ? <InventoryPosition /> : null}
        {report === "compliance" ? <Compliance from={from} to={to} /> : null}
      </Suspense>
    </div>
  );
}

async function Operations({ from, to }: { from: string; to: string }) {
  const supabase = await createClient();
  const [pickups, deliveries, jobs] = await Promise.all([
    supabase.from("pickups").select("pickup_date, pickup_lines(quantity, damaged_quantity, missing_quantity)")
      .gte("pickup_date", from).lte("pickup_date", to)
      .returns<Array<{ pickup_date: string; pickup_lines: Array<{ quantity: number; damaged_quantity: number; missing_quantity: number }> }>>(),
    supabase.from("deliveries").select("delivery_date, delivery_lines(quantity)")
      .gte("delivery_date", from).lte("delivery_date", to)
      .returns<Array<{ delivery_date: string; delivery_lines: Array<{ quantity: number }> }>>(),
    supabase.from("jobs").select("scheduled_date, status")
      .gte("scheduled_date", from).lte("scheduled_date", to)
      .returns<Array<{ scheduled_date: string; status: string }>>(),
  ]);

  const byDay = new Map<string, {
    day: string; pickups: number; pickedUp: number; damaged: number; missing: number;
    deliveries: number; delivered: number; jobs: number; completed: number; exceptions: number;
  }>();

  const bucket = (day: string) => {
    const existing = byDay.get(day);
    if (existing) return existing;
    const created = {
      day, pickups: 0, pickedUp: 0, damaged: 0, missing: 0,
      deliveries: 0, delivered: 0, jobs: 0, completed: 0, exceptions: 0,
    };
    byDay.set(day, created);
    return created;
  };

  for (const pickup of pickups.data ?? []) {
    const row = bucket(pickup.pickup_date);
    row.pickups += 1;
    for (const line of pickup.pickup_lines ?? []) {
      row.pickedUp += line.quantity;
      row.damaged += line.damaged_quantity;
      row.missing += line.missing_quantity;
    }
  }
  for (const delivery of deliveries.data ?? []) {
    const row = bucket(delivery.delivery_date);
    row.deliveries += 1;
    for (const line of delivery.delivery_lines ?? []) row.delivered += line.quantity;
  }
  for (const job of jobs.data ?? []) {
    const row = bucket(job.scheduled_date);
    row.jobs += 1;
    if (job.status === "completed") row.completed += 1;
    if (job.status === "exception") row.exceptions += 1;
  }

  const rows = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
  const totals = rows.reduce(
    (acc, row) => ({
      jobs: acc.jobs + row.jobs,
      completed: acc.completed + row.completed,
      pickedUp: acc.pickedUp + row.pickedUp,
      delivered: acc.delivered + row.delivered,
    }),
    { jobs: 0, completed: 0, pickedUp: 0, delivered: 0 },
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Jobs" value={number(totals.jobs)} />
        <Stat label="Completed" value={number(totals.completed)}
              hint={totals.jobs ? `${Math.round((totals.completed / totals.jobs) * 100)}% completion` : undefined} />
        <Stat label="Items collected" value={number(totals.pickedUp)} />
        <Stat label="Items delivered" value={number(totals.delivered)} />
      </div>
      <Card title="By day">
        <DataTable
          rows={rows}
          empty={<EmptyState title="No activity in this range" />}
          columns={[
            { header: "Day", cell: (row) => date(row.day) },
            { header: "Jobs", cell: (row) => number(row.jobs), align: "right" },
            { header: "Completed", cell: (row) => number(row.completed), align: "right" },
            { header: "Problems", cell: (row) => number(row.exceptions), align: "right", hideBelow: "sm" },
            { header: "Collected", cell: (row) => number(row.pickedUp), align: "right" },
            { header: "Delivered", cell: (row) => number(row.delivered), align: "right" },
            { header: "Damaged", cell: (row) => number(row.damaged), align: "right", hideBelow: "lg" },
            { header: "Missing", cell: (row) => number(row.missing), align: "right", hideBelow: "lg" },
          ]}
        />
      </Card>
    </div>
  );
}

async function Revenue({ from, to }: { from: string; to: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("invoices")
    .select("issue_date, status, subtotal, tax_amount, total, customers(business_name)")
    .gte("issue_date", from).lte("issue_date", to).neq("status", "void")
    .returns<Array<{ issue_date: string; status: string; subtotal: number; tax_amount: number; total: number; customers: { business_name: string } | null }>>();

  const rows = data ?? [];
  const totals = rows.reduce(
    (acc, row) => ({
      subtotal: acc.subtotal + Number(row.subtotal),
      tax: acc.tax + Number(row.tax_amount),
      total: acc.total + Number(row.total),
    }),
    { subtotal: 0, tax: 0, total: 0 },
  );

  const byCustomer = new Map<string, number>();
  for (const row of rows) {
    const name = row.customers?.business_name ?? "Unknown";
    byCustomer.set(name, (byCustomer.get(name) ?? 0) + Number(row.total));
  }
  const top = [...byCustomer.entries()]
    .map(([customer, total]) => ({ customer, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Invoiced (ex GST)" value={money(totals.subtotal)} />
        <Stat label="GST" value={money(totals.tax)} />
        <Stat label="Invoiced (inc GST)" value={money(totals.total)} />
      </div>
      <Card title="Revenue by customer" description={`${rows.length} invoice(s) in this range.`}>
        <DataTable
          rows={top}
          empty={<EmptyState title="No invoices in this range" />}
          columns={[
            { header: "Customer", cell: (row) => row.customer },
            { header: "Invoiced", cell: (row) => money(row.total), align: "right" },
          ]}
        />
      </Card>
    </div>
  );
}

async function Receivables() {
  const supabase = await createClient();
  const now = today();
  const { data } = await supabase
    .from("invoices")
    .select("id, invoice_number, due_date, balance, status, customers(business_name)")
    .in("status", ["issued", "part_paid", "overdue"]).gt("balance", 0)
    .order("due_date")
    .returns<Array<{ id: string; invoice_number: string; due_date: string | null; balance: number; status: string; customers: { business_name: string } | null }>>();

  const rows = (data ?? []).map((row) => ({
    ...row,
    overdueDays: row.due_date ? Math.max(0, relativeDays(row.due_date, now)) : 0,
  }));

  return (
    <Card title="Outstanding payments">
      <DataTable
        rows={rows}
        rowHref={(row) => `/invoices/${row.id}`}
        empty={<EmptyState title="Nothing outstanding" description="Every issued invoice is paid." />}
        columns={[
          { header: "Invoice", cell: (row) => row.invoice_number },
          { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
          { header: "Due", cell: (row) => date(row.due_date), hideBelow: "sm" },
          { header: "Days overdue", cell: (row) => (row.overdueDays > 0 ? number(row.overdueDays) : "—"), align: "right" },
          { header: "Balance", cell: (row) => money(row.balance), align: "right" },
        ]}
      />
    </Card>
  );
}

async function DriverProductivity({ from, to }: { from: string; to: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("jobs")
    .select("driver_id, status, drivers(full_name)")
    .gte("scheduled_date", from).lte("scheduled_date", to).not("driver_id", "is", null)
    .returns<Array<{ driver_id: string; status: string; drivers: { full_name: string } | null }>>();

  const byDriver = new Map<string, { driver: string; jobs: number; completed: number; exceptions: number }>();
  for (const job of data ?? []) {
    const name = job.drivers?.full_name ?? "Unknown driver";
    const row = byDriver.get(name) ?? { driver: name, jobs: 0, completed: 0, exceptions: 0 };
    row.jobs += 1;
    if (job.status === "completed") row.completed += 1;
    if (job.status === "exception") row.exceptions += 1;
    byDriver.set(name, row);
  }

  const rows = [...byDriver.values()].sort((a, b) => b.completed - a.completed);

  return (
    <Card title="Driver productivity">
      <DataTable
        rows={rows}
        empty={<EmptyState title="No assigned jobs in this range" />}
        columns={[
          { header: "Driver", cell: (row) => row.driver },
          { header: "Jobs", cell: (row) => number(row.jobs), align: "right" },
          { header: "Completed", cell: (row) => number(row.completed), align: "right" },
          { header: "Problems", cell: (row) => number(row.exceptions), align: "right" },
          {
            header: "Completion",
            cell: (row) => (row.jobs ? `${Math.round((row.completed / row.jobs) * 100)}%` : "—"),
            align: "right",
          },
        ]}
      />
    </Card>
  );
}

async function VehicleUtilisation({ from, to }: { from: string; to: string }) {
  const supabase = await createClient();
  const [{ data: routes }, { count: fleet }] = await Promise.all([
    supabase.from("daily_routes")
      // Disambiguated: daily_routes has two FKs to vehicles (vehicle_id and
      // trailer_id), so a bare `vehicles(...)` embed is rejected as ambiguous.
      .select("vehicle_id, route_date, status, odometer_start_km, odometer_end_km, " +
              "vehicles!daily_routes_vehicle_id_fkey(registration)")
      .gte("route_date", from).lte("route_date", to).not("vehicle_id", "is", null)
      .returns<Array<{ vehicle_id: string; route_date: string; status: string; odometer_start_km: number | null; odometer_end_km: number | null; vehicles: { registration: string } | null }>>(),
    supabase.from("vehicles").select("id", { count: "exact", head: true })
      .eq("status", "active").is("deleted_at", null),
  ]);

  const byVehicle = new Map<string, { vehicle: string; runs: number; closed: number; km: number; days: Set<string> }>();
  for (const route of routes ?? []) {
    const name = route.vehicles?.registration ?? "Unknown";
    const row = byVehicle.get(name) ?? { vehicle: name, runs: 0, closed: 0, km: 0, days: new Set<string>() };
    row.runs += 1;
    row.days.add(route.route_date);
    if (route.status === "closed") row.closed += 1;
    if (route.odometer_start_km != null && route.odometer_end_km != null) {
      row.km += Math.max(0, route.odometer_end_km - route.odometer_start_km);
    }
    byVehicle.set(name, row);
  }

  const span = Math.max(1, relativeDays(from, to) + 1);
  const rows = [...byVehicle.values()]
    .map((row) => ({ ...row, utilisation: Math.round((row.days.size / span) * 100) }))
    .sort((a, b) => b.runs - a.runs);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Active vehicles" value={number(fleet ?? 0)} />
        <Stat label="Vehicles used" value={number(rows.length)} />
        <Stat label="Days in range" value={number(span)} />
      </div>
      <Card title="Utilisation by vehicle">
        <DataTable
          rows={rows}
          empty={<EmptyState title="No vehicle was assigned to a route in this range" />}
          columns={[
            { header: "Vehicle", cell: (row) => row.vehicle },
            { header: "Runs", cell: (row) => number(row.runs), align: "right" },
            { header: "Closed", cell: (row) => number(row.closed), align: "right", hideBelow: "sm" },
            { header: "Days used", cell: (row) => number(row.days.size), align: "right" },
            { header: "Utilisation", cell: (row) => `${row.utilisation}%`, align: "right" },
            { header: "Distance", cell: (row) => (row.km ? `${number(row.km)} km` : "—"), align: "right", hideBelow: "lg" },
          ]}
        />
      </Card>
    </div>
  );
}

async function InventoryPosition() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("inventory_pools")
    .select("state, quantity, items(name, sku, replacement_cost)")
    .neq("quantity", 0)
    .returns<Array<{ state: string; quantity: number; items: { name: string; sku: string; replacement_cost: number } | null }>>();

  const byItem = new Map<string, { item: string; total: number; value: number; states: Record<string, number> }>();
  for (const pool of data ?? []) {
    const key = pool.items ? `${pool.items.name} (${pool.items.sku})` : "Unknown item";
    const row = byItem.get(key) ?? { item: key, total: 0, value: 0, states: {} };
    row.total += pool.quantity;
    row.value += pool.quantity * Number(pool.items?.replacement_cost ?? 0);
    row.states[pool.state] = (row.states[pool.state] ?? 0) + pool.quantity;
    byItem.set(key, row);
  }

  const rows = [...byItem.values()].sort((a, b) => b.total - a.total);
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Items tracked" value={number(rows.length)} />
        <Stat label="Replacement value" value={money(totalValue)} />
      </div>
      <Card title="Position by item">
        <DataTable
          rows={rows}
          empty={<EmptyState title="No stock recorded" />}
          columns={[
            { header: "Item", cell: (row) => row.item },
            { header: "At customer", cell: (row) => number(row.states.at_customer ?? 0), align: "right" },
            { header: "In transit", cell: (row) => number(row.states.in_transit ?? 0), align: "right", hideBelow: "sm" },
            { header: "At depot", cell: (row) => number(row.states.at_depot ?? 0), align: "right" },
            { header: "Total", cell: (row) => number(row.total), align: "right" },
            { header: "Value", cell: (row) => money(row.value), align: "right", hideBelow: "md" },
          ]}
        />
      </Card>
    </div>
  );
}

/**
 * Contract compliance: did each active agreement actually get the visits it
 * promised in the range? Planned counts come from the pattern, actuals from jobs.
 */
async function Compliance({ from, to }: { from: string; to: string }) {
  const supabase = await createClient();
  const [{ data: agreements }, { data: jobs }] = await Promise.all([
    supabase.from("service_agreements")
      .select("id, customer_id, start_date, end_date, pickup_pattern, holiday_rule, holiday_region, customers(business_name)")
      .eq("status", "active").is("deleted_at", null).lte("start_date", to)
      .returns<Array<{
        id: string; customer_id: string; start_date: string; end_date: string | null;
        pickup_pattern: unknown; holiday_rule: string; holiday_region: string;
        customers: { business_name: string } | null;
      }>>(),
    supabase.from("jobs").select("customer_id, status")
      .gte("scheduled_date", from).lte("scheduled_date", to)
      .returns<Array<{ customer_id: string; status: string }>>(),
  ]);

  const { data: holidayRows } = await supabase
    .from("public_holidays").select("holiday_date, region").gte("holiday_date", from).lte("holiday_date", to);

  const completedByCustomer = new Map<string, number>();
  for (const job of jobs ?? []) {
    if (job.status !== "completed") continue;
    completedByCustomer.set(job.customer_id, (completedByCustomer.get(job.customer_id) ?? 0) + 1);
  }

  const rows = (agreements ?? [])
    .filter((agreement) => !agreement.end_date || agreement.end_date >= from)
    .map((agreement) => {
      const planned = generateServiceDates({
        pattern: parsePattern(agreement.pickup_pattern),
        from, to,
        holidays: (holidayRows ?? [])
          .filter((row) => row.region === agreement.holiday_region)
          .map((row) => row.holiday_date as string),
        holidayRule: agreement.holiday_rule as HolidayRule,
        startDate: agreement.start_date,
        endDate: agreement.end_date,
      }).length;

      const actual = completedByCustomer.get(agreement.customer_id) ?? 0;
      return {
        customer: agreement.customers?.business_name ?? "Unknown",
        planned,
        actual,
        variance: actual - planned,
      };
    })
    .sort((a, b) => a.variance - b.variance);

  return (
    <Card title="Contract compliance"
          description="Planned visits come from each agreement's calendar; actuals are completed jobs.">
      <DataTable
        rows={rows}
        empty={<EmptyState title="No active agreements cover this range" />}
        columns={[
          { header: "Customer", cell: (row) => row.customer },
          { header: "Planned", cell: (row) => number(row.planned), align: "right" },
          { header: "Completed", cell: (row) => number(row.actual), align: "right" },
          {
            header: "Variance",
            cell: (row) => (
              <span className={row.variance < 0 ? "text-danger" : "text-success"}>
                {row.variance > 0 ? "+" : ""}{number(row.variance)}
              </span>
            ),
            align: "right",
          },
          {
            header: "Status",
            cell: (row) => humanise(row.variance < 0 ? "under_serviced" : "on_track"),
            hideBelow: "sm",
          },
        ]}
      />
    </Card>
  );
}
