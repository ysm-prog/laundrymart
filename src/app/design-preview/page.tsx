import { AppNav } from "@/components/app-nav";
import { Checkbox, Field, Input, Select, SubmitButton } from "@/components/form";
import {
  Badge, Button, ButtonLink, Card, DataTable, EmptyState, Eyebrow, Notice,
  PageHeader, Stat, StatusBadge, cx,
} from "@/components/ui";
import type { NavSection } from "@/lib/nav";

/**
 * Design review harness — a component gallery, not part of the product.
 *
 * Every real screen is an async server component that reads Supabase, so none
 * of them render without a session and a reachable project. That makes the
 * design language impossible to actually look at from a build box, which is how
 * a doubled hairline in the KPI row and an invisible sidebar edge in dark mode
 * both survived a green `verify`. This page renders the same leaf components
 * against fixed data so they can be seen.
 *
 * It reads nothing and holds no data. It is still withheld in production —
 * unauthenticated routes on a customer's domain should earn their place.
 */

import { notFound } from "next/navigation";

export const metadata = { title: "Design preview" };

const SECTIONS: NavSection[] = [
  {
    label: "Today",
    items: [
      { label: "Dashboard", href: "/design-preview", capability: "reports.read" },
      { label: "Daily routes", href: "/x1", capability: "routes.read", count: "routesToday" },
      { label: "Jobs", href: "/x2", capability: "routes.read" },
      { label: "My run", href: "/x3", capability: "run.execute" },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Pickups", href: "/x4", capability: "operations.read" },
      { label: "Deliveries", href: "/x5", capability: "operations.read" },
      { label: "Exceptions", href: "/x6", capability: "operations.read", count: "exceptions" },
    ],
  },
  {
    label: "Plant",
    items: [
      { label: "Warehouse", href: "/x7", capability: "warehouse.read", count: "batches" },
      { label: "Inventory", href: "/x8", capability: "inventory.read" },
    ],
  },
  {
    label: "Accounts",
    items: [
      { label: "Customers", href: "/x9", capability: "customers.read" },
      { label: "Service agreements", href: "/x10", capability: "agreements.read" },
      { label: "Invoices", href: "/x11", capability: "invoices.read", count: "unpaidInvoices" },
      { label: "Reports", href: "/x12", capability: "reports.read" },
    ],
  },
];

const COUNTS = { routesToday: 3, exceptions: 4, batches: 12, unpaidInvoices: 9 };

const DECISIONS = [
  { ref: "JOB00042", customer: "Quay Street Bistro", issue: "no access — gate locked, no answer on the intercom",
    state: "No Access", size: "—", since: "05/08/2026", action: "Resolve", rule: "border-l-danger", text: "text-danger" },
  { ref: "MISSING", customer: "Northshore Day Spa", issue: "3 × Bath Towel — White short at collection",
    state: "Missing", size: "3", since: "04/08/2026", action: "Investigate", rule: "border-l-warning", text: "text-warning" },
  { ref: "INV00007", customer: "Quay Street Bistro", issue: "72 day(s) past terms",
    state: "Overdue", size: "$1,284.50", since: "25/05/2026", action: "Chase", rule: "border-l-danger", text: "text-danger" },
  { ref: "CJ72QM", customer: "Fleet", issue: "off the road — reassign anything planned on it",
    state: "Out Of Service", size: "—", since: "05/08/2026", action: "Open", rule: "border-l-warning", text: "text-warning" },
];

const STAGES = [
  ["Received", 400], ["Washing", 150], ["Drying", 44], ["Folding", 268],
  ["Packing", 39], ["Ready", 120], ["Dispatched", 32],
] as const;

export default function DesignPreviewPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[212px_1fr]">
      <aside className="hidden bg-[#14171a] pb-3 pt-3.5 lg:flex lg:flex-col">
        <div className="border-b border-[#262c31] px-4 pb-3.5">
          <span className="block text-sm font-semibold tracking-[-0.01em] text-white">LaundryMart</span>
          <span className="mt-0.5 block truncate font-mono text-3xs text-[#7d8791]">
            Harbour Commercial Laundry
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <AppNav sections={SECTIONS} counts={COUNTS} />
        </div>
        <div className="mt-auto border-t border-[#262c31] px-4 pt-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center bg-[#3a444d] text-2xs font-semibold text-white">DA</span>
            <span className="min-w-0">
              <span className="block truncate text-xs text-white">darshan@ctnorwood.com.au</span>
              <span className="block font-mono text-3xs text-[#7d8791]">Super Admin</span>
            </span>
          </div>
          <div className="mt-2.5">
            <button className="w-full border border-[#3a444d] px-2 py-1 text-left text-xs text-[#c7ced4]">Sign out</button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-[52px] flex-none items-center gap-2.5 border-b bg-surface/95 px-4 backdrop-blur">
          <div className="hidden min-w-0 flex-1 sm:block">
            <input placeholder="Search customers…"
                   className="w-full max-w-[420px] border border-strong bg-surface-muted px-2.5 py-1.5 text-[12.5px] placeholder:text-muted-foreground" />
          </div>
          <span className="ml-auto border border-border px-2 py-1 font-mono text-2xs text-muted-foreground">2026-08-05</span>
          <span className="border border-strong px-2 py-1.5 font-mono text-2xs">☾</span>
        </header>

        <main className="min-w-0 flex-1 space-y-4 p-5">
          <PageHeader
            eyebrow="Harbour Commercial Laundry · 05/08/2026"
            title="Dashboard"
            description="What needs a decision today."
          />

          <div className="grid gap-px border bg-border sm:grid-cols-3 lg:grid-cols-5">
            <Stat flush label="Stops today" value={<>7<span className="text-sm font-normal text-muted-foreground"> / 18</span></>} hint="11 remaining" />
            <Stat flush label="In the plant" value="621" hint="washing through to ready" />
            <Stat flush label="Ready to dispatch" value="120" hint="waiting on a truck" tone="success" />
            <Stat flush label="Exceptions" value="4" hint="need a decision" tone="danger" />
            <Stat flush label="Overdue" value="$14,280.00" hint="9 invoice(s) past terms" tone="warning" />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-4">
              <Card title="Needs a decision" description="4 open" className="[&>div]:p-0">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12.5px]">
                    <thead className="bg-surface-muted text-left">
                      <tr>
                        {["Reference", "Customer / issue", "State", "Size", "Since", "Action"].map((h, i) => (
                          <th key={h} className={cx(
                            "px-3 py-1.5 font-mono text-3xs font-normal uppercase tracking-[0.08em] text-muted-foreground",
                            i === 3 && "text-right")}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {DECISIONS.map((d) => (
                        <tr key={d.ref} className={cx("border-t border-l-[3px]", d.rule)}>
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-[11.5px]">{d.ref}</td>
                          <td className="px-3 py-2">
                            <span className="font-semibold">{d.customer}</span>
                            <span className="text-muted-foreground"> — {d.issue}</span>
                          </td>
                          <td className={cx("whitespace-nowrap px-3 py-2 text-[11.5px]", d.text)}>{d.state}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[11.5px] tabular-nums">{d.size}</td>
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{d.since}</td>
                          <td className="whitespace-nowrap px-3 py-2"><span className="font-medium text-primary">{d.action}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title="Plant stages now" description="Items currently held in each state.">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                  {STAGES.map(([label, qty]) => {
                    const peak = label === "Received";
                    return (
                      <div key={label} className={cx("border px-2.5 py-2", peak && "border-warning/40 bg-warning/5")}>
                        <Eyebrow className={peak ? "text-warning" : undefined}>{label}</Eyebrow>
                        <div className={cx("mt-0.5 text-[17px] font-semibold tabular-nums", peak && "text-warning")}>{qty}</div>
                      </div>
                    );
                  })}
                </div>
              </Card>

              <Card title="Component vocabulary">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary">Primary action</Button>
                    <Button variant="secondary">Secondary</Button>
                    <Button variant="danger">Danger</Button>
                    <Button variant="ghost">Ghost link</Button>
                    <ButtonLink href="/design-preview">Button link</ButtonLink>
                    <SubmitButton>Save</SubmitButton>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status="active" /><StatusBadge status="in_progress" />
                    <StatusBadge status="overdue" /><StatusBadge status="draft" />
                    <StatusBadge status="part_paid" /><Badge tone="info">info</Badge>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Customer" name="p_customer"><Input name="p_customer" placeholder="Quay Street Bistro" /></Field>
                    <Field label="Status" name="p_status">
                      <Select name="p_status" options={[{ value: "a", label: "Active" }, { value: "b", label: "On hold" }]} />
                    </Field>
                    <Field label="Terms" name="p_terms" hint="Days from issue."><Input name="p_terms" defaultValue="14" /></Field>
                  </div>
                  <Checkbox name="p_check" label="Emergency service" defaultChecked />
                  <div className="space-y-2">
                    <Notice tone="info" title="Information">A neutral message.</Notice>
                    <Notice tone="warning" title="Warning">Something needs attention.</Notice>
                    <Notice tone="danger" title="Something went wrong">That email and password combination was not recognised.</Notice>
                    <Notice tone="success">Invoice emailed to accounts@quaybistro.example.</Notice>
                  </div>
                  <DataTable
                    rows={[
                      { n: "CUST00001", c: "Quay Street Bistro", s: "active", t: 14 },
                      { n: "CUST00002", c: "Northshore Day Spa", s: "on_hold", t: 30 },
                    ]}
                    empty={<EmptyState title="Nothing here" />}
                    columns={[
                      { header: "Number", cell: (r) => <span className="font-mono text-[11.5px]">{r.n}</span> },
                      { header: "Customer", cell: (r) => r.c },
                      { header: "Status", cell: (r) => <StatusBadge status={r.s} /> },
                      { header: "Terms", cell: (r) => r.t, align: "right" },
                    ]}
                  />
                  <EmptyState title="No runs planned" description="Generate today's routes from a template." />
                </div>
              </Card>
            </div>

            <Card title="Runs today" className="[&>div]:p-0">
              <ul>
                {[
                  { c: "CITY-AM", n: "City morning", d: "Sam Okoye", done: 7, total: 9, s: "in_progress" },
                  { c: "REG-PM", n: "Regional", d: "Unassigned", done: 3, total: 6, s: "planned" },
                  { c: "LATE", n: "Afternoon", d: "Sam Okoye", done: 4, total: 4, s: "closed" },
                ].map((run) => {
                  const percent = Math.round((run.done / run.total) * 100);
                  return (
                    <li key={run.c} className="border-b last:border-b-0">
                      <div className="block px-4 py-2.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[12.5px] font-semibold">{run.c} · {run.n}</span>
                          <span className={cx("font-mono text-[11px] tabular-nums",
                            percent === 100 ? "text-success" : "text-warning")}>{run.done} / {run.total}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span className="truncate text-[11.5px] text-muted-foreground">{run.d}</span>
                          <StatusBadge status={run.s} />
                        </div>
                        <div aria-hidden className="mt-1.5 h-[5px] bg-surface-muted">
                          <div className={cx("h-full", percent === 100 ? "bg-success" : "bg-primary")} style={{ width: `${percent}%` }} />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
