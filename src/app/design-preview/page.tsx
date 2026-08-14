import { AppNav, BrandMark } from "@/components/app-nav";
import { Moon, Search } from "lucide-react";
import { Checkbox, Field, Input, Select, SubmitButton } from "@/components/form";
import {
  Badge, Button, ButtonLink, Card, DataTable, EmptyState, Eyebrow, Notice,
  PageHeader, Stage, Stat, StatusBadge, cx,
} from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { OverlayDemo } from "./overlay-demo";
import { CompleteJob } from "@/app/(app)/orders/complete-job";
import { NotificationBell } from "@/components/notification-bell";
import { NotificationList, type NotificationListItem } from "@/components/notification-list";
import { InspectionChecklist } from "@/app/(app)/run/inspection-checklist";
import { ExceptionCapture } from "@/components/offline-capture";
import { AgreementWizard } from "@/app/(app)/agreements/agreement-wizard";
import { CustomerEssentials, FormDisclosure } from "@/app/(app)/customers/customer-form";
import { EXCEPTION_REASONS } from "@/app/(app)/jobs/exception-reasons";
import { navigationFor, type NavItem } from "@/lib/nav";
import {
  ORDER_STATUSES, isOverdue, summariseItems,
} from "@/lib/domain/laundry-orders";
import { UNASSIGNED } from "@/app/(app)/routes/planner/plan";
import { DateNav } from "@/app/(app)/my-runs/date-nav";
import { StopCard, Summary } from "@/app/(app)/my-runs/run-view";
import { AssignForm } from "@/app/(app)/my-runs/assign-form";
import type { RunStop } from "@/lib/runs/my-runs";
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

/* The real rail, resolved for an owner. Rendering the production map rather
   than a fixture means this gallery cannot show a navigation the app no longer
   has — the previous fixture still showed the six-heading rail for two releases
   after it was replaced. */
const ITEMS: NavItem[] = navigationFor("super_admin");

const COUNTS = {
  routesToday: 3, exceptions: 4, batches: 12, unpaidInvoices: 9, overdueJobs: 2,
};

/* ---------------------------------------------------- laundry jobs fixture */

/** "Today" is fixed here so the overdue rule renders the same on every build. */
const JOBS_TODAY = "2026-08-13";

const PREVIEW_LAUNDRY = [
  {
    id: "1", order_number: "LJ00118", customer: "Quay Street Bistro",
    status: "in_progress", priority: "urgent", due_date: "2026-08-11",
    delivery_required: true,
    items: [{ item_type: "linen" as string, quantity_type: "exact", exact_quantity: 40 },
            { item_type: "pillowcases", quantity_type: "bulk_lot", bag_count: 2 }],
  },
  {
    id: "2", order_number: "LJ00121", customer: "Northshore Day Spa",
    status: "ready_for_delivery", priority: "normal", due_date: "2026-08-13",
    delivery_required: false,
    items: [{ item_type: "bath_towels", quantity_type: "exact", exact_quantity: 60 }],
  },
  {
    id: "3", order_number: "LJ00122", customer: "Harbourview Hotel",
    status: "out_for_delivery", priority: "normal", due_date: "2026-08-14",
    delivery_required: true,
    items: [{ item_type: "sheets", quantity_type: "bulk_lot", bag_count: 6, estimated_quantity: 90 }],
  },
] as const;

const PREVIEW_STAFF = [
  { id: "u1", label: "counter@harbourlaundry.com.au", role: "Customer Service" },
  { id: "u2", label: "kim@harbourlaundry.com.au", role: "Dispatcher" },
];

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

/* ------------------------------------------------------ notification fixture */

/** Two unread and one already read, so both weights are visible side by side. */
const PREVIEW_NOTIFICATIONS: NotificationListItem[] = [
  {
    id: "n1", kind: "invoice_overdue",
    title: "Invoice INV00042 for Harbourview Hotel has passed its payment terms.",
    href: "/invoices", created_at: "2026-08-05T21:02:00.000Z", read_at: null,
  },
  {
    id: "n2", kind: "run_not_started",
    title: "Run R-02 (Inner West morning) has not left the depot and is past its start time.",
    href: "/routes/daily", created_at: "2026-08-05T20:15:00.000Z", read_at: null,
  },
  {
    id: "n3", kind: "inspection_failed",
    title: "A driver failed a vehicle inspection and the vehicle is off the road. Reassign the run or clear the vehicle.",
    href: "/vehicles", created_at: "2026-08-04T19:40:00.000Z",
    read_at: "2026-08-04T19:55:00.000Z",
  },
];

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

/* ---------------------------------------------------------- wizard fixture */

const PREVIEW_WIZARD_CUSTOMERS = [
  { id: "c1", business_name: "Quay Street Bistro", customer_number: "CUST00001" },
  { id: "c2", business_name: "Northshore Day Spa", customer_number: "CUST00002" },
];

const PREVIEW_WIZARD_LOCATIONS = [
  { id: "l1", name: "Main kitchen", customer_id: "c1" },
  { id: "l2", name: "Treatment rooms", customer_id: "c2" },
];

const PREVIEW_WIZARD_ITEMS = [
  { id: "i1", name: "Bath Towel — White", sku: "TWL-W", rental_price: 2.4 },
  { id: "i2", name: "Chef Jacket", sku: "CHF-J", rental_price: 4.1 },
  { id: "i3", name: "Queen Sheet", sku: "SHT-Q", rental_price: 3.2 },
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

/* --------------------------------------------------------- my runs fixture */

/**
 * A driver's morning, fixed. The date is the day the redesign fixtures use, so
 * the screenshots are byte-stable across builds; the two stops are the two
 * shapes that matter — one customer with several jobs under a single stop, and
 * one already done.
 */
const PREVIEW_STOPS: RunStop[] = [
  {
    id: "s1", job_number: "JOB01041", sequence: 1, service_type: "delivery",
    status: "assigned", progress_status: "not_started",
    arrived_at: null, completed_at: null, notes: null,
    customers: {
      id: "c1", business_name: "ABC Fitness", phone: "08 1234 5678",
      special_instructions: "Use the rear loading entrance.",
    },
    customer_locations: {
      name: "Main Road", address_line1: "123 Main Road", suburb: "Adelaide",
      state: "SA", postcode: "5000", access_notes: null,
    },
    jobs: [
      {
        id: "j1", order_number: "LJ01041", status: "out_for_delivery", priority: "urgent",
        delivery_required: true, due_date: "2026-08-14", delivery_window: "morning",
        expected_delivery_time: null, delivery_address: "123 Main Road, Adelaide SA 5000",
        delivery_instructions: "Ring the bell at the roller door.",
        special_instructions: null, customer_id: "c1", stop_id: "s1",
        laundry_order_items: [
          { item_type: "towels", custom_description: null, quantity_type: "exact",
            exact_quantity: 250, bag_count: null, estimated_quantity: null, notes: null },
        ],
      },
      {
        id: "j2", order_number: "LJ01045", status: "out_for_delivery", priority: "normal",
        delivery_required: true, due_date: "2026-08-14", delivery_window: null,
        expected_delivery_time: null, delivery_address: null, delivery_instructions: null,
        special_instructions: null, customer_id: "c1", stop_id: "s1",
        laundry_order_items: [
          { item_type: "bath_mats", custom_description: null, quantity_type: "exact",
            exact_quantity: 80, bag_count: null, estimated_quantity: null, notes: null },
        ],
      },
    ],
  },
  {
    id: "s2", job_number: "JOB01042", sequence: 2, service_type: "both",
    status: "completed", progress_status: "completed",
    arrived_at: "2026-08-13T23:45:00Z", completed_at: "2026-08-14T00:05:00Z", notes: null,
    customers: { id: "c2", business_name: "XYZ Physio", phone: null, special_instructions: null },
    customer_locations: {
      name: "Clinic", address_line1: "8 Grote Street", suburb: "Adelaide",
      state: "SA", postcode: "5000", access_notes: null,
    },
    jobs: [
      {
        id: "j3", order_number: "LJ01052", status: "completed", priority: "normal",
        delivery_required: true, due_date: "2026-08-14", delivery_window: "afternoon",
        expected_delivery_time: null, delivery_address: null, delivery_instructions: null,
        special_instructions: null, customer_id: "c2", stop_id: "s2",
        laundry_order_items: [
          { item_type: "sheets", custom_description: null, quantity_type: "bulk_lot",
            exact_quantity: null, bag_count: 4, estimated_quantity: 60, notes: null },
        ],
      },
    ],
  },
];

/** The planner's driver fixture is `{value,label}`; My Runs wants real rows. */
const PREVIEW_RUN_DRIVERS = [
  { id: "d1", full_name: "John Smith", status: "active", phone: "0400 000 111" },
  { id: "d2", full_name: "Mel Nguyen", status: "active", phone: null },
];

export default function DesignPreviewPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      {/* The shell, mirrored from `AppShell`. Static here — the live one reads
          the pathname and a cookie, neither of which this gallery has. */}
      <aside className="hidden flex-col border-r bg-sidebar lg:flex">
        <div className="flex h-16 flex-none items-center border-b border-sidebar-border px-4">
          <span className="flex min-w-0 items-center gap-2.5">
            <BrandMark />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold leading-tight">
                Electro Services
              </span>
              <span className="block truncate text-2xs text-sidebar-muted">
                Harbour Commercial Laundry
              </span>
            </span>
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-3">
          <AppNav items={ITEMS} counts={COUNTS} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-16 flex-none items-center gap-2 border-b
                           bg-surface/90 px-5 backdrop-blur">
          <div className="relative hidden min-w-0 max-w-[26rem] flex-1 sm:block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2
                               text-muted-foreground" aria-hidden />
            <input placeholder="Search customers, jobs, invoices, stops…"
                   className="min-h-10 w-full rounded-lg border border-strong bg-surface-muted py-2
                              pl-9 pr-3 text-sm placeholder:text-muted-foreground" />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-1 hidden text-sm text-muted-foreground lg:inline">13/08/2026</span>
            <NotificationBell count={3} />
            <span className="flex size-10 items-center justify-center rounded-lg text-muted-foreground">
              <Moon className="size-[1.15rem]" aria-hidden />
            </span>
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/12
                             text-xs font-semibold text-primary">DA</span>
          </div>
        </header>

        <div className="flex-none border-b bg-surface">
          <nav className="flex gap-1 overflow-x-auto px-5">
            {["Today's runs", "Plan the day", "Weekly runs", "Drivers", "Vehicles"].map((tab, index) => (
              <span key={tab}
                    className={cx(
                      "-mb-px flex min-h-12 shrink-0 items-center border-b-2 px-3 text-sm",
                      index === 0
                        ? "border-b-primary font-semibold text-primary"
                        : "border-b-transparent font-medium text-muted-foreground",
                    )}>
                {tab}
              </span>
            ))}
          </nav>
        </div>

        <main className="min-w-0 flex-1 space-y-6 px-6 py-8">
          <PageHeader
            eyebrow="Harbour Commercial Laundry · 13/08/2026"
            title="Today"
            description="What needs a decision right now."
          />

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Stops today" value={<>7<span className="text-sm font-normal text-muted-foreground"> / 18</span></>} hint="11 remaining" />
            <Stat label="In the plant" value="621" hint="washing through to ready" />
            <Stat label="Ready to dispatch" value="120" hint="waiting on a truck" tone="success" />
            <Stat label="Exceptions" value="4" hint="need a decision" tone="danger" />
            <Stat label="Overdue" value="$14,280.00" hint="9 invoice(s) past terms" tone="warning" />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-4">
              <Card title="Needs a decision" description="4 open" className="[&>div]:p-0">
                {/* The real DataTable, so the gallery shows what a phone gets:
                    below `sm` these rows become labelled cards. */}
                <div className="p-4 sm:p-0">
                  <DataTable
                    bare
                    rows={DECISIONS}
                    label="Things needing a decision"
                    rowClassName={(d) => cx("border-l-[3px]", d.rule)}
                    empty={null}
                    columns={[
                      {
                        header: "Customer / issue",
                        cell: (d) => (
                          <>
                            <span className="font-semibold">{d.customer}</span>
                            <span className="text-muted-foreground"> — {d.issue}</span>
                          </>
                        ),
                      },
                      {
                        header: "State",
                        cell: (d) => (
                          <span className={cx("whitespace-nowrap text-xs", d.text)}>{d.state}</span>
                        ),
                      },
                      { header: "Size", align: "right", cell: (d) => d.size },
                      {
                        header: "Since", hideBelow: "md",
                        cell: (d) => (
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {d.since}
                          </span>
                        ),
                      },
                      {
                        header: "Reference", hideBelow: "lg",
                        cell: (d) => <span className="whitespace-nowrap text-xs">{d.ref}</span>,
                      },
                      {
                        header: "", align: "right",
                        cell: (d) => <span className="font-medium text-primary">{d.action}</span>,
                      },
                    ]}
                  />
                </div>
              </Card>

              <Card title="Plant stages now" description="Items currently held in each state.">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                  {STAGES.map(([label, qty]) => {
                    const peak = label === "Received";
                    return (
                      <div key={label} className={cx("rounded-lg border px-2.5 py-2", peak && "border-warning/40 bg-warning/5")}>
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
                      { header: "Number", cell: (r) => <span className="text-xs">{r.n}</span> },
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
                          <span className="truncate text-sm font-semibold">{run.c} · {run.n}</span>
                          <span className={cx("text-xs tabular-nums",
                            percent === 100 ? "text-success" : "text-warning")}>{run.done} / {run.total}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span className="truncate text-xs text-muted-foreground">{run.d}</span>
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
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Runs" value="3" hint="18 stops in total" />
              <Stat label="Unassigned stops" value="2" hint="waiting on a run" tone="warning" />
              <Stat label="Runs without a driver" value="1" hint="assign before the day starts" tone="warning" />
              <Stat label="Exceptions" value="1" hint="may need re-dispatching" tone="danger" />
            </div>
            <div className="rounded-lg mt-4 border bg-surface p-3">
              <PlannerBoard
                date="2026-08-14"
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
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Current", "$8,412.00", ""],
                ["1–30 days", "$3,120.00", "text-warning"],
                ["31–60 days", "$0.00", "text-warning"],
                ["60+ days", "$1,284.50", "text-danger"],
              ].map(([label, value, tone]) => (
                <div key={label} className="rounded-xl border bg-surface px-4 py-3 shadow-sm">
                  <Eyebrow>{label}</Eyebrow>
                  <div className={cx("mt-1 text-2xl font-semibold tabular-nums tracking-[-0.02em]",
                                     tone === "text-danger" && "text-danger")}>{value}</div>
                  <div className={cx("mt-0.5 text-xs", tone || "text-muted-foreground")}>
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
                          <span className="text-xs font-medium">{row.number}</span>
                          <span className="text-sm font-semibold tabular-nums">{row.balance}</span>
                        </div>
                        <div className="mt-0.5 flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-semibold">{row.customer}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">of {row.total}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <StatusBadge status={row.status} />
                          <span className={cx("text-xs",
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
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border bg-surface px-3 py-2">
                      <Eyebrow>Total</Eyebrow>
                      <div className="mt-0.5 text-[17px] font-semibold tabular-nums">$1,284.50</div>
                    </div>
                    <div className="rounded-lg border bg-surface px-3 py-2">
                      <Eyebrow>Balance</Eyebrow>
                      <div className="mt-0.5 text-[17px] font-semibold tabular-nums text-warning">$1,284.50</div>
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                    {[["Issued", "11/05/2026"], ["Due", "25/05/2026"],
                      ["Type", "Recurring"], ["Terms", "14 days"]].map(([label, value]) => (
                      <div key={label}>
                        <dt><Eyebrow>{label}</Eyebrow></dt>
                        <dd className="text-xs">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>

                <section className="border-t">
                  <h3 className="rounded-lg bg-surface-muted px-4 py-1.5 text-xs font-semibold text-muted-foreground">
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
                          <span className="block truncate text-sm">{description}</span>
                          <Eyebrow>{charge} · {qty}</Eyebrow>
                        </span>
                        <span className="shrink-0 text-sm tabular-nums">{amount}</span>
                      </li>
                    ))}
                    <li className="rounded-lg flex items-baseline justify-between gap-3 bg-surface-muted px-4 py-1.5">
                      <Eyebrow>Subtotal · GST $116.77</Eyebrow>
                      <span className="text-sm font-semibold tabular-nums">$1,167.73</span>
                    </li>
                  </ul>
                </section>

                <section className="border-t">
                  <h3 className="rounded-lg bg-surface-muted px-4 py-1.5 text-xs font-semibold text-muted-foreground">
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
                  <span className="text-sm font-medium text-primary">Open full invoice →</span>
                  <span className="text-sm font-medium text-primary">Download PDF</span>
                </div>
              </Card>
            </div>
          </div>

          <div className="border-t pt-5">
            <PageHeader
              eyebrow="Guidance"
              title="Stages, confirms and the toast"
              description="The run screen's staged pattern promoted app-wide, the inline confirm strip, and the flash toast."
            />
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <Card title="Getting started" description="Each step ticks itself off as soon as the thing exists.">
                <ol className="space-y-3">
                  <Stage index={1} label="Add your first site" done
                         detail="Sites own your routes, vehicles and stock. One is enough to start." />
                  <Stage index={2} label="Add a customer" done
                         detail="Just a name, a phone number and where they are." />
                  <Stage index={3} label="Create their contract"
                         detail="Which days you collect and deliver, and what you charge." done={false}>
                    <ButtonLink href="/design-preview" variant="primary">Create a contract</ButtonLink>
                  </Stage>
                  <Stage index={4} label="Set up the weekly run" done={false}
                         detail="The recurring week: which customers a driver visits, in what order." />
                  <Stage index={5} label="Plan today's runs" done={false}
                         detail="Turn the weekly run into today's work and hand it to a driver." />
                </ol>
              </Card>
              <div className="space-y-4">
                <Card title="Confirm strip" description="Final actions state their consequence in place — no modal.">
                  <form action={previewApply} className="space-y-4">
                    <ConfirmSubmit
                      label="Void invoice"
                      consequence="Voiding cancels INV00007 permanently. The number is kept for the audit trail and a replacement gets a new one."
                      reasonName="p_void_reason"
                      reasonLabel="Why is it being voided?"
                    />
                  </form>
                </Card>
                <Card title="Inspection checklist" description="Starts unchecked — ticking is an act, with a one-tap fast path.">
                  <form action={previewApply}>
                    <InspectionChecklist items={[
                      { name: "p_tyres", label: "Tyres and wheels" },
                      { name: "p_lights", label: "Lights and indicators" },
                      { name: "p_brakes", label: "Brakes" },
                      { name: "p_load", label: "Load area clean and secure" },
                    ]} />
                  </form>
                </Card>
                <Card title="Flash toast" description="Success dismisses itself in 5 s; an error stays until closed. A prerequisite failure links the screen that fixes it.">
                  <div className="space-y-2">
                    <div className="rounded-lg flex max-w-[440px] items-start gap-2.5 border border-l-[5px] border-success/40 border-l-success bg-surface px-3 py-2 text-sm text-success shadow-sm">
                      <p className="min-w-0 flex-1">Invoice INV00008 emailed to accounts@dayspa.example.</p>
                      <span aria-hidden className="shrink-0 px-1 leading-none">×</span>
                    </div>
                    <div className="rounded-lg flex max-w-[440px] items-start gap-2.5 border border-l-[5px] border-danger/40 border-l-danger bg-surface px-3 py-2 text-sm text-danger shadow-sm">
                      <div className="min-w-0 flex-1">
                        <p>This customer has no billing email. Add one, or type an address to send to.</p>
                        <span className="mt-0.5 inline-block font-medium underline underline-offset-2">
                          Add their billing email →
                        </span>
                      </div>
                      <span aria-hidden className="shrink-0 px-1 leading-none">×</span>
                    </div>
                  </div>
                </Card>
              </div>
            </div>
          </div>

          <div className="border-t pt-5">
            <PageHeader
              eyebrow="Phase B"
              title="Wizards, quick-create and in-run problems"
              description="The contract wizard's three steps, the four-field customer quick-create, and the driver's exception capture."
            />
            <div className="space-y-4">
              <AgreementWizard
                action={previewApply}
                customerAction={previewApply}
                customers={PREVIEW_WIZARD_CUSTOMERS}
                locations={PREVIEW_WIZARD_LOCATIONS}
                depots={[{ id: "d1", name: "Alexandria plant" }]}
                items={PREVIEW_WIZARD_ITEMS}
              />
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <Card title="Customer quick-create"
                      description="Four fields create a routable customer; everything else is a default behind a disclosure.">
                  <form action={previewApply} className="space-y-4">
                    <CustomerEssentials />
                    <FormDisclosure summary="Billing details" hint="ABN, billing address, payment terms">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="ABN" name="pv_abn" hint="11 digits — validated before saving, optional">
                          <Input name="pv_abn" placeholder="51 824 753 556" />
                        </Field>
                        <Field label="Payment terms (days)" name="pv_terms">
                          <Input name="pv_terms" type="number" defaultValue={14} />
                        </Field>
                      </div>
                    </FormDisclosure>
                    <SubmitButton>Create customer</SubmitButton>
                  </form>
                </Card>
                <Card title="Something's wrong at this stop"
                      description="Inline on the run screen's capture card, through the offline outbox — the driver never leaves the run.">
                  <ExceptionCapture jobId="preview" reasons={EXCEPTION_REASONS} preview />
                </Card>
              </div>
            </div>
          </div>

          <div className="border-t pt-5">
            <PageHeader
              eyebrow="Notifications"
              title="The bell, and what is behind it"
              description="Read/unread is carried by weight and a marker, never by colour — colour still means status and nothing else. Each row is a form, not a link, so Next's prefetch cannot mark things read on hover."
            />
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
              <Card title="Needs your attention" description="Newest first. Opening one goes where it gets handled.">
                <NotificationList
                  items={PREVIEW_NOTIFICATIONS}
                  action={previewApply}
                  emptyTitle="You're all caught up."
                />
              </Card>
              <Card title="Bell states" description="Zero renders no badge at all — the badge exists to pull attention.">
                <div className="flex items-center gap-3">
                  <NotificationBell />
                  <NotificationBell count={3} />
                  <NotificationBell count={128} />
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Resolved once per request beside the nav counts — a head-only count,
                  no realtime. Past 99 it stops counting and says so.
                </p>
              </Card>
            </div>
          </div>
          <div className="border-t pt-5">
            <PageHeader
              eyebrow="Laundry jobs"
              title="The counter's job, drop-off to hand-back"
              description="Six statuses and no more — overdue is worked out from today's date, never stored, so a job clears the flag by being finished rather than by anyone editing it."
            />

            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {([["New", 6, false], ["In progress", 11, false], ["Ready", 4, false],
                 ["Out for delivery", 2, false], ["Completed today", 9, false],
                 ["Overdue", 2, true]] as const).map(([label, value, danger]) => (
                <Stat key={label} label={label} value={value}
                      tone={danger ? "danger" : "default"} />
              ))}
            </div>

            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
              <Card title="Jobs" description="The overdue row carries a leading rule as well as a badge — colour is never the only signal.">
                <DataTable
                  label="Jobs"
                  rows={PREVIEW_LAUNDRY}
                  rowClassName={(row) => (isOverdue(row, JOBS_TODAY) ? "border-l-[3px] border-l-danger" : "")}
                  empty={<EmptyState title="No jobs yet" />}
                  columns={[
                    { header: "Job", cell: (row) => row.order_number },
                    { header: "Customer", cell: (row) => row.customer },
                    { header: "Laundry", cell: (row) => summariseItems([...row.items]), hideBelow: "lg" },
                    {
                      header: "Due",
                      cell: (row) => (
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span>{row.due_date}</span>
                          {isOverdue(row, JOBS_TODAY) ? <Badge tone="danger">Late</Badge> : null}
                          {!row.delivery_required ? <Badge>Pickup</Badge> : null}
                        </span>
                      ),
                    },
                    {
                      header: "Priority",
                      cell: (row) => (row.priority === "urgent"
                        ? <Badge tone="warning">Urgent</Badge>
                        : <span className="text-muted-foreground">Normal</span>),
                      hideBelow: "md",
                    },
                    { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
                  ]}
                />
              </Card>

              <div className="space-y-4">
                <Card title="The six statuses" description="Nothing else is allowed anywhere in the stack.">
                  <div className="flex flex-wrap gap-1.5">
                    {ORDER_STATUSES.map((status) => <StatusBadge key={status} status={status} />)}
                  </div>
                </Card>

                <Card title="Handing it back"
                      description="Inline rather than a modal: date, time and who did it, defaulted to now.">
                  <CompleteJob action={previewApply} orderId="preview" delivered
                               staff={PREVIEW_STAFF} defaultStaffId="u1" />
                </Card>

                <Card title="Overlays"
                      description="The app has no modals by design — entry is a page, confirmation is inline. This is the one overlay shape, for a genuine detour.">
                  <OverlayDemo />
                </Card>

                <Card title="Cancelling"
                      description="The one action with an optional reason — demanding one only teaches people to type n/a.">
                  <form action={previewApply}>
                    <ConfirmSubmit
                      label="Cancel job"
                      eyebrow="Are you sure?"
                      consequence="Are you sure you want to cancel this job? Nothing is deleted — the job, its laundry list and its history all stay."
                      reasonName="cancellation_reason"
                      reasonRequired={false}
                    />
                  </form>
                </Card>
              </div>
            </div>
          </div>

          {/* ------------------------------------------------------ my runs --- */}
          <section className="space-y-4 border-t pt-8">
            <PageHeader
              eyebrow="Friday, 14 August 2026"
              title="My runs"
              description="Good morning, John. Here is your work for the day."
            />

            <DateNav
              date="2026-08-14"
              driverParam="me"
              drivers={PREVIEW_RUN_DRIVERS}
              canChooseDriver
            />

            <Summary
              driverName="John Smith"
              date="2026-08-14"
              runs={2}
              stops={{ total: 8, done: 3 }}
              jobs={{ total: 12, done: 5 }}
            />

            <Card
              title="RUN00024 · Morning"
              description="On the road · 3 of 8 stops completed · started 14 Aug 2026, 7:45 am"
              actions={<StatusBadge status="in_progress" />}
            >
              <ol className="space-y-4">
                {PREVIEW_STOPS.map((stop) => (
                  <StopCard
                    key={stop.id}
                    stop={stop}
                    runStatus="in_progress"
                    returnTo="/my-runs"
                    canDeliver
                    dispatches
                    showCapture={false}
                  />
                ))}
              </ol>
            </Card>

            <Card
              title="Ready for delivery, on nobody's run"
              description="Customer pickups are not listed — they never go on a delivery run."
            >
              <AssignForm
                orderId="preview"
                defaultDriverId="d1"
                defaultDriverName="John Smith"
                defaultDate="2026-08-14"
                dueDate="2026-08-14"
                drivers={PREVIEW_RUN_DRIVERS}
                runs={[
                  { id: "r1", code: "RUN00024", name: "Morning" },
                  { id: "r2", code: "RUN00025", name: "Afternoon" },
                ]}
                returnTo="/design-preview"
              />
            </Card>
          </section>
        </main>
      </div>
    </div>
  );
}
