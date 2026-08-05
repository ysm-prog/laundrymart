import { AppNav } from "@/components/app-nav";
import { Checkbox, Field, Input, Select, SubmitButton } from "@/components/form";
import {
  Badge, Button, ButtonLink, Card, DataTable, EmptyState, Eyebrow, Notice,
  PageHeader, Stat, StatusBadge, cx,
} from "@/components/ui";
import type { NavSection } from "@/lib/nav";
import { UNASSIGNED } from "@/app/(app)/routes/planner/plan";
import {
  PlannerBoard, type Option, type PlannerColumn, type PlannerJob,
} from "@/app/(app)/routes/planner/planner-board";

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

/* ------------------------------------------------- dispatch planner fixture */

/** The board is interactive here; there is nothing behind it to apply to. */
async function previewApply(): Promise<void> {
  "use server";
}

const PREVIEW_JOBS: Record<string, PlannerJob> = Object.fromEntries(([
  ["j1", "JOB00031", "Quay Street Bistro", "Main kitchen · Circular Quay", "both", "assigned", null, 96],
  ["j2", "JOB00032", "Northshore Day Spa", "Treatment rooms · Neutral Bay", "delivery", "assigned", null, 142],
  ["j3", "JOB00033", "Harbourview Hotel", "Loading dock · The Rocks", "both", "completed", "Completed", 310],
  ["j4", "JOB00034", "Wentworth Aged Care", "Level 2 linen room · Randwick", "both", "assigned", null, null],
  ["j5", "JOB00035", "Pier One Function Centre", "Service lane · Walsh Bay", "pickup", "exception", null, 78],
  ["j6", "JOB00036", "Glebe Point Cafe", "Rear entry · Glebe", "both", "scheduled", null, 41],
  ["j7", "JOB00037", "Bondi Surf Club", "Kiosk · Bondi Beach", "delivery", "scheduled", null, null],
] as const).map(([id, jobNumber, customer, site, serviceType, status, lockedBecause, estimateKg]) => [
  id,
  { id, jobNumber, customer, site, serviceType, status, lockedBecause, estimateKg } satisfies PlannerJob,
]));

const PREVIEW_COLUMNS: PlannerColumn[] = [
  {
    id: UNASSIGNED, code: "Unassigned", name: "No run yet", status: null, open: true,
    driverId: "", vehicleId: "", capacityKg: null, jobIds: ["j6", "j7"],
  },
  {
    id: "r1", code: "CITY-AM", name: "City morning", status: "in_progress", open: true,
    driverId: "d1", vehicleId: "v1", capacityKg: 800, jobIds: ["j3", "j1", "j5"],
  },
  {
    id: "r2", code: "REG-PM", name: "Regional afternoon", status: "planned", open: true,
    driverId: "", vehicleId: "v2", capacityKg: 250, jobIds: ["j2", "j4"],
  },
];

const PREVIEW_DRIVERS: Option[] = [
  { value: "d1", label: "Sam Okoye" },
  { value: "d2", label: "Priya Raman" },
];

const PREVIEW_VEHICLES: Option[] = [
  { value: "v1", label: "CJ72QM · 800 kg", capacityKg: 800 },
  { value: "v2", label: "BK09YT · 250 kg", capacityKg: 250 },
];

/* --------------------------------------------------------- billing fixture */

const PREVIEW_REGISTER = [
  { number: "INV00009", customer: "Harbourview Hotel", balance: "$0.00", total: "$4,930.00",
    status: "paid", when: "due 12/08/2026", chasing: false, selected: false },
  { number: "INV00008", customer: "Northshore Day Spa", balance: "$3,120.00", total: "$3,120.00",
    status: "issued", when: "14 day(s) past terms", chasing: true, selected: false },
  { number: "INV00007", customer: "Quay Street Bistro", balance: "$1,284.50", total: "$1,284.50",
    status: "overdue", when: "72 day(s) past terms", chasing: true, selected: true },
  { number: "INV00006", customer: "Wentworth Aged Care", balance: "$8,412.00", total: "$8,412.00",
    status: "draft", when: "issued 01/08/2026", chasing: false, selected: false },
];

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
          <div className="border-t pt-5">
            <PageHeader
              eyebrow="05/08/2026"
              title="Dispatch planner"
              description="Arrange the whole day, then apply it in one go."
            />
            <div className="grid gap-px border bg-border sm:grid-cols-2 lg:grid-cols-4">
              <Stat flush label="Runs" value="3" hint="18 stops in total" />
              <Stat flush label="Unassigned stops" value="2" hint="waiting on a run" tone="warning" />
              <Stat flush label="Runs without a driver" value="1" hint="assign before the day starts" tone="warning" />
              <Stat flush label="Exceptions" value="1" hint="may need re-dispatching" tone="danger" />
            </div>
            <div className="mt-4 border bg-surface p-3">
              <PlannerBoard
                columns={PREVIEW_COLUMNS}
                jobs={PREVIEW_JOBS}
                drivers={PREVIEW_DRIVERS}
                vehicles={PREVIEW_VEHICLES}
                action={previewApply}
              />
            </div>
          </div>

          <div className="border-t pt-5">
            <PageHeader
              eyebrow="Billing"
              title="Invoices"
              description="The register is the chase list; the pane is where the chase happens."
            />
            <div className="grid gap-px border bg-border sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Current", "$8,412.00", ""],
                ["1–30 days", "$3,120.00", "text-warning"],
                ["31–60 days", "$0.00", "text-warning"],
                ["60+ days", "$1,284.50", "text-danger"],
              ].map(([label, value, tone]) => (
                <div key={label} className="bg-surface px-4 py-3">
                  <Eyebrow>{label}</Eyebrow>
                  <div className={cx("mt-1 text-2xl font-semibold tabular-nums tracking-[-0.02em]",
                                     tone === "text-danger" && "text-danger")}>{value}</div>
                  <div className={cx("mt-0.5 text-[11px]", tone || "text-muted-foreground")}>
                    {value === "$0.00" ? "nothing outstanding" : "outstanding"}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
              <Card title="Register" description="4 invoice(s)" className="[&>div]:p-0">
                <ul>
                  {PREVIEW_REGISTER.map((row) => (
                    <li key={row.number} className="border-b last:border-b-0">
                      <div className={cx(
                        "block border-l-[3px] px-3 py-2",
                        row.selected ? "border-l-primary bg-surface-muted"
                          : row.chasing ? "border-l-warning" : "border-l-transparent",
                      )}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[11.5px] font-medium">{row.number}</span>
                          <span className="font-mono text-[12.5px] font-semibold tabular-nums">{row.balance}</span>
                        </div>
                        <div className="mt-0.5 flex items-baseline justify-between gap-2">
                          <span className="truncate text-[12.5px] font-semibold">{row.customer}</span>
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">of {row.total}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <StatusBadge status={row.status} />
                          <span className={cx("font-mono text-[11px]",
                                              row.chasing ? "text-warning" : "text-muted-foreground")}>
                            {row.when}
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card
                title="INV00007"
                description="Quay Street Bistro"
                actions={<StatusBadge status="overdue" />}
                className="[&>div]:p-0"
              >
                <div className="space-y-3 p-4">
                  <Notice tone="warning">72 day(s) past terms · $1,284.50 outstanding.</Notice>
                  <div className="grid grid-cols-2 gap-px border bg-border">
                    <div className="bg-surface px-3 py-2">
                      <Eyebrow>Total</Eyebrow>
                      <div className="mt-0.5 text-[17px] font-semibold tabular-nums">$1,284.50</div>
                    </div>
                    <div className="bg-surface px-3 py-2">
                      <Eyebrow>Balance</Eyebrow>
                      <div className="mt-0.5 text-[17px] font-semibold tabular-nums text-warning">$1,284.50</div>
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                    {[["Issued", "11/05/2026"], ["Due", "25/05/2026"],
                      ["Type", "Recurring"], ["Terms", "14 days"]].map(([label, value]) => (
                      <div key={label}>
                        <dt><Eyebrow>{label}</Eyebrow></dt>
                        <dd className="font-mono text-[11.5px]">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>

                <section className="border-t">
                  <h3 className="bg-surface-muted px-4 py-1.5 font-mono text-3xs uppercase tracking-[0.08em] text-muted-foreground">
                    Lines · 3
                  </h3>
                  <ul className="divide-y">
                    {[
                      ["Bath Towel — White — 9 collection(s)", "Linen rental", "108 × $2.40", "$259.20"],
                      ["Chef Jacket — 9 collection(s)", "Wash only", "54 × $4.10", "$221.40"],
                      ["Fuel levy", "Fuel levy", "1 × $28.80", "$28.80"],
                    ].map(([description, charge, qty, amount]) => (
                      <li key={description} className="flex items-baseline justify-between gap-3 px-4 py-1.5">
                        <span className="min-w-0">
                          <span className="block truncate text-[12.5px]">{description}</span>
                          <Eyebrow>{charge} · {qty}</Eyebrow>
                        </span>
                        <span className="shrink-0 font-mono text-[12px] tabular-nums">{amount}</span>
                      </li>
                    ))}
                    <li className="flex items-baseline justify-between gap-3 bg-surface-muted px-4 py-1.5">
                      <Eyebrow>Subtotal · GST $116.77</Eyebrow>
                      <span className="font-mono text-[12px] font-semibold tabular-nums">$1,167.73</span>
                    </li>
                  </ul>
                </section>

                <section className="border-t">
                  <h3 className="bg-surface-muted px-4 py-1.5 font-mono text-3xs uppercase tracking-[0.08em] text-muted-foreground">
                    Do next
                  </h3>
                  <div className="space-y-3 px-4 py-3">
                    <div>
                      <div className="flex flex-wrap items-end gap-2">
                        <Field label="Email to" name="p_to" className="min-w-[12rem] flex-1">
                          <Input name="p_to" placeholder="accounts@quaybistro.example" />
                        </Field>
                        <SubmitButton>Send</SubmitButton>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Blank uses the customer&rsquo;s billing email.
                      </p>
                    </div>
                    <div className="grid gap-2 border-t pt-3 sm:grid-cols-2">
                      <Field label="Paid on" name="p_paid"><Input name="p_paid" defaultValue="2026-08-05" /></Field>
                      <Field label="Amount" name="p_amount"><Input name="p_amount" defaultValue="1284.50" /></Field>
                      <Field label="Method" name="p_method">
                        <Select name="p_method" options={[{ value: "a", label: "Bank transfer" }]} />
                      </Field>
                      <Field label="Reference" name="p_ref"><Input name="p_ref" /></Field>
                      <div className="sm:col-span-2"><SubmitButton>Record payment</SubmitButton></div>
                    </div>
                  </div>
                </section>

                <div className="flex flex-wrap items-center gap-3 border-t px-4 py-2.5">
                  <span className="text-[12.5px] font-medium text-primary">Open full invoice →</span>
                  <span className="text-[12.5px] font-medium text-primary">Download PDF</span>
                </div>
              </Card>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
