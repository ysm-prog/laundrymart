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
import { ExceptionCapture } from "@/components/offline-capture";
import { AgreementWizard } from "@/app/(app)/agreements/agreement-wizard";
import { CustomerEssentials, FormDisclosure } from "@/app/(app)/customers/customer-form";
import { EXCEPTION_REASONS } from "@/app/(app)/jobs/exception-reasons";
import { navigationFor, type NavItem } from "@/lib/nav";
import {
  ORDER_STATUSES, buildStatusTrack, isOverdue, summariseItems,
} from "@/lib/domain/laundry-orders";
import { UNASSIGNED } from "@/app/(app)/routes/planner/plan";
import { DateNav } from "@/app/(app)/my-runs/date-nav";
import { DaySummary, JobCard, JobGroup } from "@/app/(app)/my-runs/run-view";
import { BillingQueue, type QueueRow } from "@/app/(app)/invoices/awaiting/billing-queue";
import { JobChargesEditor, type EditableCharge } from "@/app/(app)/orders/[id]/job-charges-editor";
import { ItemPickerPreview } from "./item-picker-preview";
import {
  InvoiceLineForm, type LineFormAccount, type LineFormItem,
} from "@/app/(app)/invoices/[id]/line-form";
import {
  InvoiceSelection, type SelectableInvoice,
} from "@/app/(app)/invoices/invoice-selection";
import { PriceTable } from "@/app/(app)/invoices/prices/price-table";
import { StatusTrack } from "@/app/(app)/orders/[id]/status-track";
import {
  defaultPriceList, priceListFor, type LaundryPriceRow,
} from "@/lib/domain/laundry-billing";
import { AssignForm } from "@/app/(app)/my-runs/assign-form";
import type { DayJob } from "@/lib/runs/my-runs";
import {
  PlannerBoard, type Option, type PlannerColumn, type PlannerJob,
} from "@/app/(app)/routes/planner/planner-board";
import { CountRow } from "@/app/(app)/warehouse/count-row";

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
import { SequenceBoard, type SequenceStop } from "@/app/(app)/runs/sequence-board";
import { MoveToBoard } from "@/app/(app)/runs/move-to-board";
import { consolidateChargeLines } from "@/lib/domain/invoice-consolidation";
import { FilterChips, FilterSummary, PeriodFilter, ToggleChips } from "@/components/filters";
import { ListControls } from "@/components/list-controls";
import { ACTIVITY_PERIOD_PRESETS, BILLING_PERIOD_PRESETS, resolvePeriod } from "@/lib/domain/dates";
import { money } from "@/lib/format";
import { QuickActions } from "@/components/quick-actions";
import { DraftCard } from "@/app/(app)/invoices/drafts/draft-card";
import type { DraftSummary } from "@/lib/invoices/open-draft";

export const metadata = { title: "Design preview" };

/* The real rail, resolved for an owner. Rendering the production map rather
   than a fixture means this gallery cannot show a navigation the app no longer
   has — the previous fixture still showed the six-heading rail for two releases
   after it was replaced. */
const ITEMS: NavItem[] = navigationFor("super_admin");

const COUNTS = {
  exceptions: 4, batches: 12, unpaidInvoices: 9, overdueJobs: 2,
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

// People, not addresses. Every picker in the app labels somebody by their name
// since 0030; the fixture showed two email addresses, which is exactly what the
// change was made to stop.
const PREVIEW_STAFF = [
  { id: "u1", label: "Priya Nair", role: "Customer Service" },
  { id: "u2", label: "Kim Alvarez", role: "Dispatcher" },
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
 * A round's morning, fixed. The date is the day the redesign fixtures use, so
 * the screenshots are byte-stable across builds; the two stops are the two
 * shapes that matter — one customer with several jobs under a single stop, and
 * one already done.
 */
const PREVIEW_DAY_JOBS: DayJob[] = [
  {
    id: "j1", order_number: "LJ01041", status: "assigned", priority: "urgent",
    delivery_required: true, due_date: "2026-08-16", expected_delivery_date: "2026-08-16",
    assigned_delivery_date: "2026-08-16", assigned_board_id: "d1",
    load_confirmed_at: null, completed_at: null,
    delivery_window: "morning", expected_delivery_time: null,
    delivery_address: "123 Main Street, Adelaide SA 5000",
    delivery_instructions: "Ring the bell at the roller door.",
    special_instructions: null, customer_id: "c1",
    stop_id: "s1", jobs: { sequence: 1 },
    customers: { id: "c1", business_name: "ABC Fitness", phone: "08 1234 5678" },
    laundry_order_items: [
      { item_type: "towels", custom_description: null, quantity_type: "exact",
        exact_quantity: 250, bag_count: null, estimated_quantity: null, notes: null },
    ],
  },
  {
    id: "j2", order_number: "LJ01045", status: "out_for_delivery", priority: "normal",
    delivery_required: true, due_date: "2026-08-16", expected_delivery_date: "2026-08-16",
    assigned_delivery_date: "2026-08-16", assigned_board_id: "d1",
    load_confirmed_at: "2026-08-15T22:10:00Z", completed_at: null,
    delivery_window: null, expected_delivery_time: null,
    delivery_address: "55 North Terrace, Adelaide SA 5000",
    delivery_instructions: null, special_instructions: null, customer_id: "c2",
    stop_id: "s2", jobs: { sequence: 2 },
    customers: { id: "c2", business_name: "XYZ Medical", phone: "08 8888 1010" },
    laundry_order_items: [
      { item_type: "sheets", custom_description: null, quantity_type: "bulk_lot",
        exact_quantity: null, bag_count: 5, estimated_quantity: 60, notes: null },
    ],
  },
  {
    id: "j3", order_number: "LJ01051", status: "completed", priority: "normal",
    delivery_required: true, due_date: "2026-08-16", expected_delivery_date: "2026-08-16",
    assigned_delivery_date: "2026-08-16", assigned_board_id: "d1",
    load_confirmed_at: "2026-08-15T22:10:00Z", completed_at: "2026-08-16T01:12:00Z",
    delivery_window: null, expected_delivery_time: null,
    delivery_address: "19 King William Street, Adelaide SA 5000",
    delivery_instructions: null, special_instructions: null, customer_id: "c3",
    stop_id: "s3", jobs: { sequence: 3 },
    customers: { id: "c3", business_name: "City Gym", phone: null },
    laundry_order_items: [
      { item_type: "bath_towels", custom_description: null, quantity_type: "exact",
        exact_quantity: 80, bag_count: null, estimated_quantity: null, notes: null },
    ],
  },
];

/** The planner's fixture is `{value,label}`; My Runs wants real board rows. */
const PREVIEW_RUN_BOARDS = [
  { id: "d1", code: "BOARD1", name: "Board 1", status: "active" },
  { id: "d2", code: "BOARD2", name: "Board 2", status: "active" },
];

/**
 * A price list, resolved the way the real screens resolve one: the customer's
 * own rows for the fields, the tenant default for the hint under each label —
 * so this gallery shows an override and an inherited price side by side, which
 * is the layout worth looking at.
 */
const PREVIEW_PRICE_ROWS: LaundryPriceRow[] = [
  { customer_id: null, item_type: "towels", unit_price: 2, bag_price: 15, taxable: true },
  { customer_id: null, item_type: "sheets", unit_price: 4.5, bag_price: null, taxable: true },
  { customer_id: null, item_type: "uniforms", unit_price: 6, bag_price: null, taxable: true },
  { customer_id: "preview", item_type: "towels", unit_price: 1.75, bag_price: 12, taxable: true },
];
const toPriceValues = (source: ReturnType<typeof priceListFor>) =>
  new Map([...source].map(([itemType, price]) => [itemType, {
    unitPrice: price.unitPrice, bagPrice: price.bagPrice, taxable: price.taxable,
  }]));
const PREVIEW_CUSTOMER_PRICES = toPriceValues(
  priceListFor("preview", PREVIEW_PRICE_ROWS.filter((row) => row.customer_id === "preview")),
);
const PREVIEW_DEFAULT_PRICES = toPriceValues(defaultPriceList(PREVIEW_PRICE_ROWS));

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

              <Card
                title="Depot count"
                description="Pre-filled from the driver's numbers — only the disagreements get touched."
              >
                <div className="-mx-4 -mb-4 border-t border-border">
                  <CountRow itemId="p1" name="Bath Towel" sku="TOW-01" driverQuantity={40} />
                  <CountRow itemId="p2" name="Flat Sheet Queen" sku="SHT-02" driverQuantity={25} />
                  <CountRow itemId="p3" name="Chef Jacket" sku="UNI-07" driverQuantity={12} />
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
                    {/* The third verb in a row that already has two — the
                        People screen's "Email sign-in link" beside Save and
                        Remove. Present without competing with them. */}
                    <SubmitButton variant="ghost">Ghost submit</SubmitButton>
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

                <Card title="Handing it back, with nobody to name"
                      description="A laundry whose only members are platform administrators has no staff to pick. A required select with no options is a form that cannot be submitted and does not say why, so it says why.">
                  <CompleteJob action={previewApply} orderId="preview" delivered staff={[]} />
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
          <section id="my-runs-preview" className="space-y-4 border-t pt-8">
            <PageHeader
              eyebrow="Sunday, 16 August 2026"
              title="My Runs"
              description="Good morning. Here is Board 1&apos;s work for the day."
            />

            <DateNav
              date="2026-08-16"
              boardParam="me"
              boards={PREVIEW_RUN_BOARDS}
              canChooseBoard
            />

            <DaySummary
              boardName="John Smith"
              date="2026-08-16"
              toDeliver={1}
              outForDelivery={1}
              completed={1}
            />

            <JobGroup title="To deliver" count={1}>
              {PREVIEW_DAY_JOBS.filter((job) => job.status === "assigned").map((job) => (
                <JobCard key={job.id} job={job} actionable />
              ))}
            </JobGroup>

            <JobGroup title="Out for delivery" count={1}>
              {PREVIEW_DAY_JOBS.filter((job) => job.status === "out_for_delivery").map((job) => (
                <JobCard key={job.id} job={job} actionable />
              ))}
            </JobGroup>

            <JobGroup title="Completed" count={1}>
              {PREVIEW_DAY_JOBS.filter((job) => job.status === "completed").map((job) => (
                <JobCard key={job.id} job={job} actionable />
              ))}
            </JobGroup>

            {/* Adjust Run, where the manager is actually standing.

                The round's own day is the screen somebody is looking at when
                they notice the van should call at the school before the hotel,
                so the ordering board is drawn here too — the same component the
                Runs screen uses, so there is one answer to "how is a run
                ordered". It renders for the Owner and the Office manager alone:
                a board holds `routes.read` and not `routes.sequence`, and gets
                no card at all rather than a disabled button. */}
            <div id="my-runs-run-order">
              <Card
                title="Run order"
                description="The order this round drives in. Press Adjust Run to move a stop, then Save &amp; Lock Run — the round sees the new order straight away."
                actions={<Badge tone="neutral">3 stops</Badge>}
              >
                <SequenceBoard
                  boardId="b1" boardName="Board 1" date="2026-08-16"
                  stops={PREVIEW_RUN_STOPS} version={1} canSequence
                  returnTo="/design-preview"
                />
              </Card>
            </div>

            <Card
              title="Ready for delivery, assigned to nobody"
              description="Customer pickups are not listed — they are never assigned for delivery."
            >
              <AssignForm
                orderId="preview"
                defaultBoardId="d1"
                defaultDate="2026-08-16"
                expectedDeliveryDate="2026-08-16"
                boards={PREVIEW_RUN_BOARDS}
                returnTo="/design-preview"
              />
            </Card>
          </section>

          {/* ------------------------------------------------ laundry prices --- */}
          {/* Nine rows of three inputs is the widest form in the app on a phone,
              and it is a real screen behind the auth gate — which means this
              gallery is the only place its layout can be looked at. */}
          <section id="laundry-prices-preview" className="space-y-4 border-t pt-8">
            <PageHeader
              title="Laundry prices"
              description="What each kind of laundry costs. Used to bill the jobs you take in at the counter."
            />
            <PriceTable
              title="Prices for Harbourview Hotel"
              description="Blank means the usual price, shown under each kind of laundry."
              values={PREVIEW_CUSTOMER_PRICES}
              defaults={PREVIEW_DEFAULT_PRICES}
              customerId="preview"
              writable
              submitLabel="Save their prices"
            />
          </section>

          {/* --------------------------------------------- billing review ----- */}
          {/* The two screens the rate-card adoption added, and the reason they
              are here: both are **compose-locally-commit-once** client
              components, which is the class that has shipped broken twice in
              this repo behind a green `verify` — the job form's items and the
              planner's whole board. The pages that host them are async server
              components reading Supabase, so this gallery is the only place
              their layout and their empty states can be looked at at all. */}
          {/* The running draft. Laid out as it is on the board — two columns from
              `sm`, so twelve customers read as a grid rather than as twelve
              screens of scrolling. */}
          <section id="open-drafts-preview" className="space-y-4 border-t pt-8">
            <PageHeader
              title="Open drafts"
              description="One invoice per customer per billing period, collecting each job as it is approved. Issue one whenever you are ready."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              {PREVIEW_OPEN_DRAFTS.map(({ draft, stage }) => (
                <DraftCard key={draft.id} draft={draft} stage={stage} mayIssue
                           issueAction={async () => { "use server"; }}
                           returnTo="/invoices/drafts" />
              ))}
            </div>
          </section>

          <section id="billing-review-preview" className="space-y-6 border-t pt-8">
            <PageHeader
              title="Awaiting invoice"
              description="Finished work that has not been billed. Approve the charges and they join the customer's draft."
            />

            <Card title="Price and approve"
                  description="Two verbs over one selection. An unpriced job is selectable because Price Selected is the verb that applies to it; approving one is refused by name.">
              <BillingQueue rows={PREVIEW_QUEUE} mode="approve" canAct canPrice />
            </Card>

            <Card title="Add to draft"
                  description="Approved jobs that reached no draft, grouped by each customer's billing method. Nothing here creates an invoice — a draft is issued from the drafts board.">
              <BillingQueue rows={PREVIEW_QUEUE_APPROVED} mode="place" canAct />
            </Card>

            <Card title="Nothing waiting" description="The state the queue is in most of the time.">
              <BillingQueue rows={[]} mode="approve" canAct canPrice />
            </Card>

            {/* The rung between generating and sending, and the reason it is
                worth looking at: the same component carries both verbs, so a
                change to the tap targets or the running total has to be right
                for the issue list and the send list at once. */}
            <Card title="Issue drafts"
                  description="Generating writes drafts; this turns them into documents. It emails nobody.">
              <InvoiceSelection
                invoices={PREVIEW_DRAFTS}
                returnTo="/invoices?tool=issue"
                action={async () => { "use server"; }}
                verb="Issue selected"
                pendingLabel="Issuing…"
                selectAllLabel="Select every draft listed"
              />
            </Card>

            <Card title="Send invoices"
                  description="Issued invoices with a billing email. Re-sending is legitimate and simply labelled.">
              <InvoiceSelection
                invoices={PREVIEW_SENDABLE}
                returnTo="/invoices?tool=send"
                action={async () => { "use server"; }}
                verb="Send selected"
                pendingLabel="Sending…"
                selectAllLabel="Select every invoice listed"
              />
            </Card>

            {/* The charge lines, named from the item master. Typing a code into
                the description finds the item; the item field under each row is
                the same choice made deliberately. **No account code is shown**:
                it travels from the item, the way MYOB's Category follows its
                Item ID, so it is never a question asked here. */}
            <div id="job-charges-preview" className="space-y-6">
            <Card title="A job's charges"
                  description="Editable right up until approval, and frozen the moment it is given. Type an item code in the description to name the line — its rate, GST answer and account come with it.">
              <JobChargesEditor orderId="preview" initial={PREVIEW_CHARGES}
                                items={PREVIEW_LINE_ITEMS} accounts={PREVIEW_CHART}
                                action={async () => { "use server"; }} />
            </Card>

            {/* A laundry whose item master has not arrived. The description is
                a plain box, because there is nothing to suggest — no dead
                type-ahead, and nothing said about codes either way. */}
            <Card title="A job's charges · no item list"
                  description="No items on file yet. The description is plain text and the charge is priced by hand.">
              <JobChargesEditor orderId="preview-noitems" initial={PREVIEW_CHARGES}
                                items={[]} accounts={PREVIEW_CHART}
                                action={async () => { "use server"; }} />
            </Card>
            </div>

            {/* **The one way an item is chosen, in the two things it is chosen
                for.** Until 2026-08-26 the job form picked an item from a plain
                `<select>` while the invoice and the charges used this type-ahead
                — two ways to name the same thing, and the dropdown became
                unusable the moment a real master list arrived (Adelaide's is 254
                rows). One picker now serves both, and `purpose` is the only
                difference.

                Worth looking at rather than reading, because what differs is a
                *state*: type "tow" into each and the coding one prices the
                result while the laundry one does not. That is deliberate — a
                job's rate comes from `laundry_prices`, and with 252 of 254 items
                carrying no sell price, "no price set" beside a bag of towels
                would read as "this job will not be billed". */}
            <div id="item-picker-preview" className="space-y-6">
            <Card title="Naming an item on a job's laundry"
                  description="What the counter sees. The kind of laundry comes with the item; no price is shown, because the rate is the customer's, not the item's.">
              <div className="grid gap-4 sm:grid-cols-2">
                {/* Two of them, because the job form draws one per laundry row
                    and every row must carry its own ids — the defect the charges
                    editor shipped and only a rendered page could show. */}
                <ItemPickerPreview items={PREVIEW_LINE_ITEMS} idPrefix="laundry-row-1" purpose="laundry" />
                <ItemPickerPreview items={PREVIEW_LINE_ITEMS} idPrefix="laundry-row-2" purpose="laundry" />
              </div>
            </Card>

            <Card title="Naming an item on an invoice line or a job charge"
                  description="The same picker, coding a line. Here the item really does bring its price, its GST answer and its account, so the results say so.">
              <ItemPickerPreview items={PREVIEW_LINE_ITEMS} idPrefix="coding-row-1" purpose="coding" />
            </Card>
            </div>

            {/* Adding a line, three ways. The client keeps their books against a
                chart of accounts and every sale has to land on one, so a line can
                be filled in from an item, from the code, or typed out. Worth
                looking at rather than reading, because the three routes share one
                set of fields and the failure this component exists to prevent —
                an item with no account producing a silently uncoded line — is a
                *state*, not a layout: pick TT001 and the account picker appears
                with the reason above it. */}
            <div id="invoice-line-composer-preview" className="space-y-6">
            <Card title="Add a line to an invoice"
                  description="An item, an account code, or free text. The code follows the item; a line with no code is legal and counted.">
              <InvoiceLineForm
                invoiceId="preview" items={PREVIEW_LINE_ITEMS} accounts={PREVIEW_CHART}
                action={async () => { "use server"; }}
              />
            </Card>

            <Card title="No chart of accounts yet"
                  description="A laundry that has not imported one. Nothing is blocked — items and free text still work.">
              <InvoiceLineForm
                invoiceId="preview-empty" items={PREVIEW_LINE_ITEMS} accounts={[]}
                action={async () => { "use server"; }}
              />
            </Card>

            <Card title="No items yet"
                  description="The real laundry's state today — 268 accounts, no item list. It opens on the code, because that is the route that still produces a coded line.">
              <InvoiceLineForm
                invoiceId="preview-no-items" items={[]} accounts={PREVIEW_CHART}
                action={async () => { "use server"; }}
              />
            </Card>
            </div>
          </section>

          {/* ------------------------------------------------- period billing --- */}
          {/* The month-end screen. Its three parts are computed from one set of
              charges in one pass, so the summary can never disagree with the
              history above it — which is the whole point of building the roll-up
              and the breakdown together. */}
          <section id="period-billing-preview" className="space-y-4 border-t pt-8">
            <PageHeader
              eyebrow="Money"
              title="ABC Hotel"
              description="1 August to 31 August 2026"
            />

            <Card title="Billing period"
                  description="Quick filters, defaulting to last month — the month you are standing in bills nothing on the 1st and says so in a way that reads as “all done”.">
              <PeriodFilter
                basePath="/design-preview"
                params={{ period: "last_month" }}
                period={resolvePeriod({ period: "last_month" }, "2026-09-03", "last_month")}
                presets={BILLING_PERIOD_PRESETS}
                today="2026-09-03"
                label="Billing period"
              />
            </Card>

            <Card title="Invoice summary"
                  description="What the invoice carries. Identical items are added together; a rate that changed mid-period stays two lines, at the two rates actually charged.">
              <DataTable
                bare
                label="Consolidated invoice lines"
                empty="No lines"
                rows={PREVIEW_CONSOLIDATED}
                columns={[
                  {
                    header: "Description",
                    cell: (line) => (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{line.description}</span>
                        {line.merged ? (
                          <Badge tone="info">{line.contributions.length} jobs</Badge>
                        ) : null}
                      </div>
                    ),
                  },
                  { header: "Quantity", align: "right",
                    cell: (line) => line.quantity.toLocaleString("en-AU") },
                  { header: "Unit price", align: "right", cell: (line) => money(line.unit_price) },
                  { header: "Amount", align: "right", cell: (line) => money(line.amount) },
                ]}
              />
            </Card>
          </section>

          {/* ------------------------------------------------------ the run --- */}
          {/* Both of these are compose-locally-commit-once components, which is
              the class that has shipped broken here three times behind a green
              `verify` — the job form's items, the planner's whole board, and the
              planner's payload again. They are in the gallery so they can be
              looked at without a live database. */}
          <section id="run-sequence-preview" className="space-y-4 border-t pt-8">
            <PageHeader
              title="Runs"
              description="What each board is delivering on a day, and the order it drives in."
            />

            {/* Locked is the resting state, and it is the one a manager meets
                first. Worth having in the gallery in its own right: the thing to
                look at is that there is no arrow, no handle and no Save on
                screen at all — a disabled control would still invite a press. */}
            <Card title="Board 1 — Friday, 21 August 2026"
                  description="The run is locked. Press Adjust Run to change the order, then Save & Lock Run.">
              <SequenceBoard boardId="b1" boardName="Board 1" date="2026-08-21"
                             stops={PREVIEW_RUN_STOPS} version={1} canSequence />
            </Card>

            <Card title="Part of the run has been driven"
                  description="A stop the round has already worked stays where it is, and says so — moving anything past it would rewrite where work that has already happened happened.">
              <SequenceBoard boardId="b1" boardName="Board 1" date="2026-08-21"
                             stops={PREVIEW_RUN_STOPS_WORKED} version={4} canSequence />
            </Card>

            <Card title="What a board sees"
                  description="The final sequence, read-only. A board holds routes.read and not routes.sequence, so Adjust Run is simply not there.">
              <SequenceBoard boardId="b1" boardName="Board 1" date="2026-08-21"
                             stops={PREVIEW_RUN_STOPS} version={1} canSequence={false} />
            </Card>

            <MoveToBoard
              date="2026-08-21"
              fromBoard={PREVIEW_RUN_BOARDS[0]!}
              boards={PREVIEW_RUN_BOARDS}
              jobs={PREVIEW_RUN_STOPS.flatMap((stop) =>
                stop.jobs.map((job) => ({ ...job, customerName: stop.customerName })))}
            />
          </section>

          {/*
            The guided home card and the reading-comfort control.

            Both are new in the 2026-08-24 accessibility pass and both are the
            kind of thing that can only be checked by looking: the card is a
            responsive grid that has to stay one column on a phone, and the
            reading control changes the size of the entire page — including
            itself — which is exactly the interaction a unit test cannot see.

            Rendered for two roles on purpose. `super_admin` gets every card;
            `board` gets three, and the point of showing it is that a narrow
            role must not be left with an empty card or a lonely single tile.
          */}

          {/* --------------------------------------------------------------
            The filter language, which is the one thing every list page shares.

            Here because it is a *composition*: `ListControls` renders chips,
            fields and a summary together, and the three go wrong in ways only
            a rendered page shows — a chip row that wraps into six rows on a
            phone, a Clear link that disappears when it is needed, a count that
            says "1 batchs". Every real list page is an async server component
            reading Supabase, so none of them render here.

            Four states, because the interesting ones are the edges: filtered
            (Clear showing, "showing 3 of 47"), unfiltered (no Clear, a plain
            count), a multi-select group mid-selection, and the period picker
            with Custom open.
          */}
          <section id="filters-preview" className="space-y-4 border-t pt-8">
            <PageHeader
              title="Filtering a list"
              description="Chips for the one or two questions a list is usually narrowed by, fields for the long tail, and a line saying how much is hidden."
            />

            <Card title="Filtered" description="Two chips pressed and a search term typed: Clear appears, and the summary says how much of the list is hidden.">
              <ListControls
                action="/design-preview"
                q="towel"
                params={{ q: "towel", status: "active", period: "this_month" }}
                filterKeys={["q", "status", "period", "from", "to"]}
                placeholder="Business name or customer number…"
                chips={
                  <>
                    <FilterChips
                      basePath="/design-preview"
                      params={{ q: "towel", status: "active", period: "this_month" }}
                      name="status" label="Customer status" allLabel="All customers"
                      allCount={47}
                      options={[
                        { value: "active", label: "Active", count: 31 },
                        { value: "prospect", label: "Prospect", count: 4 },
                        { value: "on_hold", label: "On hold", count: 2 },
                        { value: "inactive", label: "Inactive", count: 10 },
                      ]}
                    />
                    <PeriodFilter
                      basePath="/design-preview"
                      params={{ q: "towel", status: "active", period: "this_month" }}
                      period={resolvePeriod({ period: "this_month" }, "2026-08-26", "all")}
                      presets={ACTIVITY_PERIOD_PRESETS} today="2026-08-26"
                      label="Taken in" hideCustomWhenPreset
                    />
                  </>
                }
                summary={
                  <FilterSummary basePath="/design-preview" shown={3} total={47}
                                 noun="customer" filtered />
                }
              />
            </Card>

            <Card title="Nothing filtered" description="No Clear link, because there is nothing to clear — and a plain count rather than “showing 47 of 47”.">
              <ListControls
                action="/design-preview"
                params={{}}
                filterKeys={["q", "status"]}
                placeholder="Business name or customer number…"
                chips={
                  <FilterChips
                    basePath="/design-preview" params={{}} name="status"
                    label="Customer status" allLabel="All customers" allCount={47}
                    options={[
                      { value: "active", label: "Active", count: 31 },
                      { value: "prospect", label: "Prospect", count: 4 },
                    ]}
                  />
                }
                summary={
                  <FilterSummary basePath="/design-preview" shown={47} noun="customer"
                                 filtered={false} />
                }
              />
            </Card>

            <Card title="Several at once"
                  description="A multi-select group, for the questions a single choice cannot ask — “what is still wet?” is washing and drying together.">
              <ToggleChips
                basePath="/design-preview" params={{ stage: "washing,drying" }}
                name="stage" label="Batch stage" allLabel="Every stage" allCount={18}
                options={[
                  { value: "received", label: "Counted in", count: 2 },
                  { value: "washing", label: "Washing", count: 5 },
                  { value: "drying", label: "Drying", count: 3 },
                  { value: "folding", label: "Folding", count: 4 },
                  { value: "packing", label: "Packing", count: 1 },
                  { value: "ready_for_dispatch", label: "Ready to go out", count: 3 },
                ]}
              />
              <p className="mt-3 text-2xs text-muted-foreground">
                A stage nothing is in is left off rather than drawn as a chip promising zero rows.
              </p>
            </Card>

            <Card title="A period, with Custom open"
                  description="The escape hatch is always last, and the resolved window is printed beside the chips — “This financial year” is a claim a reader should not have to take on trust.">
              <PeriodFilter
                basePath="/design-preview"
                params={{ period: "custom", from: "2026-08-03", to: "2026-08-19" }}
                period={resolvePeriod(
                  { period: "custom", from: "2026-08-03", to: "2026-08-19" }, "2026-08-26", "all")}
                presets={ACTIVITY_PERIOD_PRESETS} today="2026-08-26" label="Completed in"
              />
            </Card>
          </section>

          {/* The job status track — the whole reason `/orders/:id` is worth
              looking at from a build box. Every state below is built by the
              real `buildStatusTrack` against a different capability set, so
              what is drawn here is what the screen will draw. */}
          <section id="status-track-preview" className="space-y-4 border-t pt-8">
            <PageHeader
              title="Where this job is up to"
              description="A job's stages, and the way to move between them — including backwards."
            />

            <Card title="A delivery job, mid-plant"
                  description="Two stages behind it, both pressable: that is what makes it a control and not a progress bar. Assigned and Completed are drawn and explained rather than left inert.">
              <StatusTrack
                steps={buildStatusTrack(
                  { status: "ready_for_delivery", deliveryRequired: true }, () => true,
                )}
                orderId="preview" action={async () => { "use server"; }}
              />
            </Card>

            <Card title="A customer pickup"
                  description="Four stages, not six. A step that can never apply is left off rather than drawn dead — the rule §29 already settles for a filter chip nothing matches.">
              <StatusTrack
                steps={buildStatusTrack(
                  { status: "in_progress", deliveryRequired: false }, () => true,
                )}
                orderId="preview" action={async () => { "use server"; }}
              />
            </Card>

            <Card title="On a round, seen by the counter"
                  description="Holds orders.status and nothing else, so the send-out override and the way back off the round are both drawn with a reason instead of being pressable."
            >
              <StatusTrack
                steps={buildStatusTrack(
                  { status: "assigned", deliveryRequired: true },
                  (capability) => capability === "orders.status",
                )}
                orderId="preview" action={async () => { "use server"; }}
              />
            </Card>

            <Card title="Finished"
                  description="Terminal, so the whole track is history and nothing on it can be pressed.">
              <StatusTrack
                steps={buildStatusTrack(
                  { status: "completed", deliveryRequired: true }, () => true,
                )}
                orderId="preview" action={async () => { "use server"; }}
              />
            </Card>

            <Card title="Cancelled"
                  description="Not a stage of the work, so the job has no position on the track at all. The banner above it on the real page is what says what happened."
            >
              <StatusTrack
                steps={buildStatusTrack(
                  { status: "cancelled", deliveryRequired: true }, () => true,
                )}
                orderId="preview" action={async () => { "use server"; }}
              />
            </Card>
          </section>

          <section id="quick-actions-preview" className="space-y-4 border-t pt-8">
            <PageHeader
              title="What do you want to do?"
              description="The way in to the app for somebody who has been shown it once."
            />
            <QuickActions role="super_admin" />
            <QuickActions role="board" />
          </section>
        </main>
      </div>
    </div>
  );
}

/**
 * A month of one customer's jobs, rolled up.
 *
 * Built by the real rule rather than hand-written, so the gallery shows what the
 * screen will show: three jobs of towels become one line carrying 460, and the
 * fuel levy on each delivery stays three lines because a levy is an event and
 * not a quantity.
 */
const PREVIEW_CONSOLIDATED = consolidateChargeLines(
  [
    { job: "LJ01041", date: "2026-08-02", qty: 150, amount: 225 },
    { job: "LJ01045", date: "2026-08-09", qty: 130, amount: 195 },
    { job: "LJ01051", date: "2026-08-16", qty: 180, amount: 270 },
  ].flatMap((entry, index) => [
    {
      job: { id: `job-${index}`, orderNumber: entry.job, date: entry.date },
      charge: {
        description: "TOW001 — Bath Towel", charge_type: "wash_only",
        quantity: entry.qty, unit_price: 1.5, amount: entry.amount, taxable: true,
        source_item_id: "item-tow001", source_agreement_id: null,
        source_laundry_item_type: "bath_towels",
      },
    },
    {
      job: { id: `job-${index}`, orderNumber: entry.job, date: entry.date },
      charge: {
        description: "Fuel levy", charge_type: "fuel_levy",
        quantity: 1, unit_price: 6.5, amount: 6.5, taxable: true,
        source_item_id: null, source_agreement_id: null, source_laundry_item_type: null,
      },
    },
  ]),
);

/**
 * A board's day, fixed.
 *
 * Three stops, because three is the smallest number that shows an order worth
 * changing, and one of them carries two jobs — the case the whole
 * order-by-stop decision turns on: one customer, one visit, two lots of laundry.
 */
const PREVIEW_RUN_STOPS: SequenceStop[] = [
  {
    id: "s1", status: "assigned", progress_status: "not_started",
    customerName: "ABC Hotel", address: "123 Main Street, Adelaide, SA",
    jobs: [
      { id: "j1", orderNumber: "LJ01041", itemCount: 3 },
      { id: "j2", orderNumber: "LJ01042", itemCount: 1 },
    ],
  },
  {
    id: "s2", status: "assigned", progress_status: "not_started",
    customerName: "XYZ Medical", address: "55 North Terrace, Adelaide, SA",
    jobs: [{ id: "j3", orderNumber: "LJ01045", itemCount: 2 }],
  },
  {
    id: "s3", status: "assigned", progress_status: "not_started",
    customerName: "City Gym", address: "19 King William Street, Adelaide, SA",
    jobs: [{ id: "j4", orderNumber: "LJ01051", itemCount: 1 }],
  },
];

/** The same day, with the first call already made. */
const PREVIEW_RUN_STOPS_WORKED: SequenceStop[] = [
  { ...PREVIEW_RUN_STOPS[0]!, status: "completed", progress_status: "delivery_completed" },
  PREVIEW_RUN_STOPS[1]!,
  { ...PREVIEW_RUN_STOPS[2]!, progress_status: "at_customer" },
];

/**
 * Fixtures for the billing review screens.
 *
 * `chargeCount: 0` on one row is deliberate and is the case worth looking at:
 * that job cannot be approved, so the queue must render it unselectable with a
 * reason beside it rather than offering a tick that would half-fail.
 */
/* -------------------------------------------------- invoice line composer --- */
/* Real rows from the client's own chart of accounts and item list, codes and tax
   codes included. The two that matter are deliberate: `TT001` has **no** income
   account, which is the state that would otherwise produce an uncoded line in
   silence; and the chart carries `5-1000 Towel Purchases`, the wrong side of the
   books, so the ranking can be seen doing its job on a real name collision. */
/* The selling unit and the price basis (0043's columns, first read by 0044) are
   deliberately spread across these four so all four states can be *seen*:
   TOW001 is priced per carton and tax-inclusive, TOW010 carries a unit on a
   non-taxable line (so no basis sentence is true and none is shown), TT001 is
   exclusive with no unit, and the laundry bag has neither — which is every one
   of Adelaide's 254 imported items today. */
const PREVIEW_LINE_ITEMS: LineFormItem[] = [
  { id: "i1", item_code: "TOW001", name: "Bath Towel — Black", description: "Commercial, black",
    laundry_category: "bath_towels", sell_price: 3.20, tax_code: "GST", income_account_id: "g2",
    selling_unit: "ctn", sell_price_basis: "inclusive" },
  { id: "i2", item_code: "TOW010", name: "Hand Towel — White", description: null,
    laundry_category: "hand_towels", sell_price: 1.80, tax_code: "N-T", income_account_id: "g3",
    selling_unit: "doz", sell_price_basis: "inclusive" },
  { id: "i3", item_code: "TT001", name: "Tea Towel", description: "Cotton, checked",
    laundry_category: "towels", sell_price: 0.95, tax_code: "GST", income_account_id: null,
    selling_unit: null, sell_price_basis: "exclusive" },
  { id: "i4", item_code: "LB-STD-01", name: "Laundry Bag", description: "Container, not laundry",
    laundry_category: null, sell_price: 0, tax_code: "GST", income_account_id: null,
    selling_unit: null, sell_price_basis: null },
];

const PREVIEW_CHART: LineFormAccount[] = [
  { id: "g1", code: "4-1000", name: "Sales of Towels", account_type: "Income", tax_code: "GST" },
  { id: "g2", code: "4-1100", name: "Towels - Black", account_type: "Income", tax_code: "GST" },
  { id: "g3", code: "4-1150", name: "Towels - White", account_type: "Income", tax_code: "N-T" },
  { id: "g4", code: "4-1400", name: "Tea Towels", account_type: "Income", tax_code: "GST" },
  { id: "g5", code: "4-2000", name: "Delivery Fees Collected", account_type: "Income", tax_code: "GST" },
  { id: "g6", code: "4-7000", name: "Sundry Income", account_type: "Income", tax_code: "GST" },
  { id: "g7", code: "5-1000", name: "Towel Purchases", account_type: "Cost of sales", tax_code: "GST" },
  { id: "g8", code: "8-9000", name: "Rebates", account_type: "Other income", tax_code: "N-T" },
];

const PREVIEW_QUEUE: QueueRow[] = [
  {
    id: "job-1", orderNumber: "LJ00042", customerId: "cust-1",
    customerName: "Harbourview Hotel",
    billingMethod: "Monthly consolidated", billingMethodValue: "monthly_consolidated",
    completedAt: "2026-08-14T04:20:00Z", chargeCount: 3, subtotal: 184.5,
    hasRateCard: true,
  },
  {
    id: "job-2", orderNumber: "LJ00043", customerId: "cust-2",
    customerName: "Bondi Surf Club",
    billingMethod: "One invoice per job", billingMethodValue: "invoice_per_job",
    completedAt: "2026-08-15T22:10:00Z", chargeCount: 1, subtotal: 42,
    hasRateCard: false,
  },
  {
    id: "job-3", orderNumber: "LJ00044", customerId: "cust-3",
    customerName: "City Gym — Alexandria",
    billingMethod: "Monthly consolidated", billingMethodValue: "monthly_consolidated",
    completedAt: "2026-08-16T01:05:00Z", chargeCount: 0, subtotal: 0,
    hasRateCard: false,
  },
];

/**
 * Drafts waiting to be issued, and issued invoices waiting to be sent.
 *
 * Two fixtures rather than one, because the two lists differ in exactly the
 * detail worth looking at: a draft can legitimately total nothing, and a
 * sendable invoice can carry the "already sent" label.
 */
/**
 * The open-drafts board, in the three states that matter.
 *
 * The one worth looking at is **Collecting**: it is the ordinary state of a
 * running draft for most of a month, it is the only card that says a number
 * which is not final, and it is the state the reader has no other way to
 * recognise — a draft that is still filling up looks exactly like one that is
 * finished and waiting to be issued.
 */
const PREVIEW_OPEN_DRAFTS: Array<{
  draft: DraftSummary; stage: "ready" | "collecting" | "none";
}> = [
  {
    stage: "collecting",
    draft: {
      id: "draft-1", invoiceNumber: "INV00341", customerId: "c1",
      customerName: "Harbourview Hotel",
      periodStart: "2026-08-01", periodEnd: "2026-08-31",
      jobCount: 7, lineCount: 5, total: 1284.5,
      createdAt: "2026-08-03T09:00:00Z", updatedAt: "2026-08-24T04:10:00Z",
    },
  },
  {
    stage: "ready",
    draft: {
      id: "draft-2", invoiceNumber: "INV00338", customerId: "c2",
      customerName: "Bondi Surf Club",
      periodStart: "2026-07-01", periodEnd: "2026-07-31",
      jobCount: 3, lineCount: 4, total: 462,
      createdAt: "2026-07-04T09:00:00Z", updatedAt: "2026-07-30T22:15:00Z",
    },
  },
  {
    // Opened by an approval and then emptied — the job was taken back off. It
    // keeps its number rather than being deleted, and says there is nothing to
    // issue instead of offering a button that could only be refused.
    stage: "collecting",
    draft: {
      id: "draft-3", invoiceNumber: "INV00342", customerId: "c3",
      customerName: "City Gym — Alexandria",
      periodStart: "2026-08-01", periodEnd: "2026-08-31",
      jobCount: 0, lineCount: 0, total: 0,
      createdAt: "2026-08-19T02:00:00Z", updatedAt: null,
    },
  },
  {
    stage: "none",
    draft: {
      id: "draft-4", invoiceNumber: "INV00340", customerId: "c4",
      customerName: "Quay Bistro",
      periodStart: null, periodEnd: null,
      jobCount: 1, lineCount: 2, total: 88.4,
      createdAt: "2026-08-22T01:00:00Z", updatedAt: null,
    },
  },
];

const PREVIEW_DRAFTS: SelectableInvoice[] = [
  { id: "inv-1", invoiceNumber: "INV00311", customerName: "Harbourview Hotel", total: 1284.5, status: "draft" },
  { id: "inv-2", invoiceNumber: "INV00312", customerName: "Bondi Surf Club", total: 42, status: "draft" },
  { id: "inv-3", invoiceNumber: "INV00313", customerName: "City Gym — Alexandria", total: 0, status: "draft" },
];

const PREVIEW_SENDABLE: SelectableInvoice[] = [
  {
    id: "inv-4", invoiceNumber: "INV00308", customerName: "Harbourview Hotel",
    total: 1190.25, status: "issued",
  },
  {
    id: "inv-5", invoiceNumber: "INV00309", customerName: "Parkside Aged Care",
    total: 763.4, status: "overdue", alreadyEmailed: true,
  },
];

const PREVIEW_QUEUE_APPROVED: QueueRow[] = PREVIEW_QUEUE
  .filter((row) => row.chargeCount > 0)
  .map((row) => ({ ...row }));

const PREVIEW_CHARGES: EditableCharge[] = [
  {
    key: "c1", description: "Bath towels — 120", charge_type: "wash_only",
    quantity: 120, unit_price: 1.1, taxable: true,
    source_agreement_id: "agr-1", source_agreement_line_id: "line-1",
    source_item_id: "i1", source_laundry_item_type: "bath_towels",
    pricing_model: "per_item",
    gl_account_id: "g2",
  },
  {
    key: "c2", description: "Sheets — 40 (price list)", charge_type: "wash_only",
    quantity: 40, unit_price: 2.4, taxable: true,
    source_agreement_id: null, source_agreement_line_id: null,
    source_item_id: null, source_laundry_item_type: "sheets",
    pricing_model: "per_item",
    gl_account_id: "g6",
  },
  {
    key: "c3", description: "Fuel levy (5%)", charge_type: "fuel_levy",
    quantity: 1, unit_price: 11.4, taxable: true,
    source_agreement_id: "agr-1", source_agreement_line_id: null,
    source_item_id: null, source_laundry_item_type: null,
    pricing_model: "percentage",
    gl_account_id: null,
  },
];
