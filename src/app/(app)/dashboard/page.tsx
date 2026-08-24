import { Suspense } from "react";
import Link from "next/link";
import { requireSession, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { counted, date as formatDate, money, number, relativeDays, today } from "@/lib/format";
import {
  ButtonLink, Card, DataTable, EmptyState, Eyebrow, FlashMessages, PageHeader, SkeletonRows,
  SkeletonStats, Stage, Stat, StatusBadge, cx, humanise,
} from "@/components/ui";
import { QuickActions } from "@/components/quick-actions";
import { parseExceptionNotes } from "@/lib/exceptions";
import { addDays, businessToday, toInstant } from "@/lib/domain/timezone";
import {
  PLANT_STAGES, SEVERITY_RULE, SEVERITY_TEXT, sortDecisions, type Decision,
} from "./decisions";

export const metadata = { title: "Today" };
export const dynamic = "force-dynamic";

const FORBIDDEN = "You do not have access to that area.";

/**
 * The control tower (design pack, screen 02).
 *
 * Exceptions are the work surface — the pack is emphatic that this screen is a
 * list of things needing a decision, not a wall of charts. Everything else here
 * exists to give them context: the KPI row says how the day is going, the stage
 * strip says where the linen is, the right rail says where the trucks are.
 *
 * Role gating is not cosmetic. The pack states that floor staff and drivers see
 * no dollar figures anywhere, so every money surface sits behind
 * `invoices.read` rather than being dimmed or truncated.
 */
export default async function DashboardPage({
  searchParams,
}: {
  // The auth gate redirects here during render, where a cookie cannot be set —
  // so this one message still travels as a query parameter, unlike the toasts.
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession();
  const date = today();
  const seesMoney = can(session.role, "invoices.read");
  const seesOperations = can(session.role, "operations.read");

  // The person doing first-time setup needs admin.read (sites live there).
  const setup = can(session.role, "admin.read") ? await setupSteps() : null;

  // A brand-new account gets the checklist and nothing else: one obvious thing
  // to do, rather than a wall of empty panels saying "nothing yet".
  if (setup && setup.fresh) {
    return (
      <div className="space-y-4">
        <PageHeader
          eyebrow={session.tenantName}
          title="Welcome"
          description="Five steps from an empty account to a planned day."
        />
        <GettingStarted steps={setup.steps} />
        {/* Below the checklist here, not above it: on a brand-new account the
            five setup steps genuinely are the thing to do first, and offering
            "Take in laundry" before a customer exists leads straight to a dead
            end. Reading comfort still has to be reachable, though, and this is
            the only screen that exists yet. */}
        <QuickActions role={session.role} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <FlashMessages error={params.error === "forbidden" ? FORBIDDEN : undefined} />
      <PageHeader
        eyebrow={`${session.tenantName} · ${formatDate(date)}`}
        title="Today"
        description="What needs doing, and what needs a decision."
      />

      {/*
        First on the page, above the numbers.

        The dashboard below is a control tower: it answers "how is the day
        going?" for somebody who already knows what the day is. It is the wrong
        first thing for somebody who has been shown this app once and has a bag
        of towels in front of them, because none of it is a way *in* — the KPI
        row, the decisions table and the plant strip are all readings, and the
        only way to start a piece of work from here is to find the right word in
        a rail of twelve. This card is the way in, and it is deliberately the
        first thing the eye lands on.
      */}
      <QuickActions role={session.role} />

      {setup && !setup.complete ? <GettingStarted steps={setup.steps} /> : null}

      <Suspense fallback={<SkeletonStats count={seesMoney ? 5 : 4} />}>
        <Kpis date={date} seesMoney={seesMoney} />
      </Suspense>

      {can(session.role, "run.execute") ? (
        <Suspense fallback={<SkeletonRows rows={2} />}>
          <MyRun session={session} date={date} />
        </Suspense>
      ) : null}

      {seesOperations ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4">
            <Suspense fallback={<SkeletonRows rows={6} />}>
              <NeedsDecision seesMoney={seesMoney} />
            </Suspense>
            <Suspense fallback={<SkeletonRows rows={2} />}>
              <PlantStages />
            </Suspense>
          </div>
          <Suspense fallback={<SkeletonRows rows={6} />}>
            <JobBoard />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------- getting started */

type SetupStep = { label: string; detail: string; href: string; action: string; done: boolean };

/**
 * The five row-counts that mean "this account can run a day". Head-only
 * queries, same trick as the nav badges. Any query failure counts as not done —
 * an unticked step is honest, a wrongly ticked one hides the next action.
 */
async function setupSteps(): Promise<{ steps: SetupStep[]; complete: boolean; fresh: boolean }> {
  const supabase = await createClient();
  const head = { count: "exact" as const, head: true };

  const [depots, customers, agreements, drivers, orders] = await Promise.all([
    supabase.from("depots").select("id", head).is("deleted_at", null),
    supabase.from("customers").select("id", head).is("deleted_at", null),
    supabase.from("service_agreements").select("id", head).is("deleted_at", null),
    supabase.from("drivers").select("id", head).is("deleted_at", null),
    supabase.from("laundry_orders").select("id", head),
  ]);

  const steps: SetupStep[] = [
    {
      label: "Add your first site",
      detail: "Sites own your routes, vehicles and stock. One is enough to start.",
      href: "/admin/depots", action: "Add a site",
      done: (depots.count ?? 0) > 0,
    },
    {
      label: "Add a customer",
      detail: "Just a name, a phone number and where they are.",
      href: "/customers/new", action: "Add a customer",
      done: (customers.count ?? 0) > 0,
    },
    {
      label: "Create their contract",
      detail: "Which days you collect and deliver, and what you charge.",
      href: "/agreements/new", action: "Create a contract",
      done: (agreements.count ?? 0) > 0,
    },
    {
      // Replaces "set up the weekly run" and "plan today's runs". A driver is
      // the only setup a delivery now needs: the run is created behind the
      // scenes the moment a job is assigned to one.
      label: "Add a driver",
      detail: "Who delivers, and the login they sign in with.",
      href: "/drivers", action: "Add a driver",
      done: (drivers.count ?? 0) > 0,
    },
    {
      label: "Take in your first job",
      detail: "The laundry, when it is due back, and who is delivering it.",
      href: "/orders/new", action: "Create a job",
      done: (orders.count ?? 0) > 0,
    },
  ];

  return {
    steps,
    complete: steps.every((step) => step.done),
    fresh: (customers.count ?? 0) === 0,
  };
}

function GettingStarted({ steps }: { steps: SetupStep[] }) {
  const firstOpen = steps.findIndex((step) => !step.done);
  return (
    <Card
      title="Getting started"
      description="Each step ticks itself off as soon as the thing exists."
    >
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <Stage key={step.label} index={index + 1} label={step.label}
                 detail={step.detail} done={step.done}>
            {index === firstOpen ? (
              <ButtonLink href={step.href} variant="primary">{step.action}</ButtonLink>
            ) : null}
          </Stage>
        ))}
      </ol>
    </Card>
  );
}

/* ------------------------------------------------------------------- KPIs */

/**
 * The pack's third KPI is average turnaround against a promised time. Nothing
 * in this schema records a promise per customer, so rather than invent a number
 * the row shows what is ready to leave — something the data can stand behind.
 */
async function Kpis({ date, seesMoney }: { date: string; seesMoney: boolean }) {
  const supabase = await createClient();
  const head = { count: "exact" as const, head: true };

  const [jobsTotal, jobsDone, exceptions, pools, overdue] = await Promise.all([
    supabase.from("jobs").select("id", head).eq("scheduled_date", date),
    supabase.from("jobs").select("id", head).eq("scheduled_date", date).eq("status", "completed"),
    supabase.from("jobs").select("id", head).eq("status", "exception"),
    supabase.from("inventory_pools").select("state, quantity")
      .in("state", ["washing", "drying", "folding", "packing", "ready_for_dispatch"])
      .gt("quantity", 0)
      .returns<Array<{ state: string; quantity: number }>>(),
    seesMoney
      ? supabase.from("invoices").select("balance")
          .in("status", ["issued", "part_paid", "overdue"])
          .lt("due_date", date).is("deleted_at", null)
          .returns<Array<{ balance: number }>>()
      : Promise.resolve({ data: [] as Array<{ balance: number }> }),
  ]);

  const total = jobsTotal.count ?? 0;
  const done = jobsDone.count ?? 0;
  const remaining = Math.max(0, total - done);
  const rows = pools.data ?? [];
  const inPlant = rows.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);
  const ready = rows.filter((row) => row.state === "ready_for_dispatch")
    .reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);
  const overdueRows = overdue.data ?? [];
  const overdueTotal = overdueRows.reduce((sum, row) => sum + Number(row.balance ?? 0), 0);
  const late = exceptions.count ?? 0;

  return (
    <div className={cx(
      "grid gap-4",
      seesMoney ? "sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-2 lg:grid-cols-4",
    )}>
      <Stat
        label="Stops today"
        value={<>{done}<span className="text-sm font-normal text-muted-foreground"> / {total}</span></>}
        hint={total === 0 ? "nothing scheduled" : `${remaining} remaining`}
        tone={total > 0 && remaining === 0 ? "success" : "default"}
      />
      <Stat label="In the plant" value={number(inPlant)} hint="washing through to ready" />
      <Stat
        label="Ready to dispatch"
        value={number(ready)}
        hint={ready > 0 ? "waiting on a truck" : "nothing staged"}
        tone={ready > 0 ? "success" : "default"}
      />
      <Stat
        label="Problems"
        value={String(late)}
        hint={late === 0 ? "none open" : "need a decision"}
        tone={late > 0 ? "danger" : "success"}
      />
      {seesMoney ? (
        <Stat
          label="Overdue"
          value={money(overdueTotal)}
          hint={`${counted(overdueRows.length, "invoice")} past terms`}
          tone={overdueTotal > 0 ? "warning" : "success"}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- needs a decision */

type ExceptionJob = {
  id: string; job_number: string; scheduled_date: string;
  exception_reason: string | null; exception_notes: string | null;
  customers: { business_name: string } | null;
};

type MissingLine = {
  missing_quantity: number;
  pickups: {
    pickup_date: string; job_id: string; customers: { business_name: string } | null;
  } | null;
  items: { name: string } | null;
};

type OverdueInvoice = {
  id: string; invoice_number: string; due_date: string | null; balance: number;
  customers: { business_name: string } | null;
};

/**
 * Merged from the places the system already records trouble — exception jobs,
 * linen short at collection, invoices past terms, vehicles off the road. No new
 * "exceptions" table: a second record of a problem is a second thing to keep
 * in step with the first.
 */
async function NeedsDecision({ seesMoney }: { seesMoney: boolean }) {
  const supabase = await createClient();
  const date = today();

  const [jobs, missing, invoices, vehicles] = await Promise.all([
    supabase.from("jobs")
      .select("id, job_number, scheduled_date, exception_reason, exception_notes, customers(business_name)")
      .eq("status", "exception").order("scheduled_date", { ascending: true }).limit(15)
      .returns<ExceptionJob[]>(),
    supabase.from("pickup_lines")
      .select("missing_quantity, pickups!inner(pickup_date, job_id, customers(business_name)), items(name)")
      .gt("missing_quantity", 0).order("created_at", { ascending: false }).limit(10)
      .returns<MissingLine[]>(),
    seesMoney
      ? supabase.from("invoices")
          .select("id, invoice_number, due_date, balance, customers(business_name)")
          .in("status", ["issued", "part_paid", "overdue"])
          .lt("due_date", date).is("deleted_at", null)
          .order("due_date", { ascending: true }).limit(10)
          .returns<OverdueInvoice[]>()
      : Promise.resolve({ data: [] as OverdueInvoice[] }),
    supabase.from("vehicles")
      .select("id, registration, maintenance_status")
      .in("maintenance_status", ["out_of_service", "overdue"]).is("deleted_at", null).limit(5)
      .returns<Array<{ id: string; registration: string; maintenance_status: string }>>(),
  ]);

  const decisions: Decision[] = [
    ...(jobs.data ?? []).map((job): Decision => ({
      reference: job.job_number,
      severity: "late",
      customer: job.customers?.business_name ?? "Unknown customer",
      // Photo markers ride inside exception_notes; the list shows only the words.
      summary: parseExceptionNotes(job.exception_notes).note
        || humanise(job.exception_reason).toLowerCase(),
      state: humanise(job.exception_reason),
      measure: "—",
      when: job.scheduled_date,
      action: "Resolve",
      href: `/jobs/${job.id}`,
    })),
    ...(missing.data ?? []).flatMap((line): Decision[] => {
      const pickup = line.pickups;
      if (!pickup) return [];
      return [{
        reference: "MISSING",
        severity: "warning",
        customer: pickup.customers?.business_name ?? "Unknown customer",
        summary: `${line.missing_quantity} × ${line.items?.name ?? "item"} short at collection`,
        state: "Missing",
        measure: String(line.missing_quantity),
        when: pickup.pickup_date,
        action: "Investigate",
        href: `/jobs/${pickup.job_id}`,
      }];
    }),
    ...(invoices.data ?? []).map((invoice): Decision => {
      const daysOver = relativeDays(invoice.due_date ?? date, date);
      return {
        reference: invoice.invoice_number,
        severity: daysOver > 60 ? "late" : "warning",
        customer: invoice.customers?.business_name ?? "Unknown customer",
        summary: `${counted(daysOver, "day")} past terms`,
        state: "Overdue",
        measure: money(invoice.balance),
        when: invoice.due_date ?? date,
        action: "Chase",
        href: `/invoices/${invoice.id}`,
      };
    }),
    ...(vehicles.data ?? []).map((vehicle): Decision => ({
      reference: vehicle.registration,
      severity: vehicle.maintenance_status === "out_of_service" ? "late" : "warning",
      customer: "Fleet",
      summary: vehicle.maintenance_status === "out_of_service"
        ? "off the road — reassign anything planned on it"
        : "service overdue",
      state: humanise(vehicle.maintenance_status),
      measure: "—",
      when: date,
      action: "Open",
      href: "/vehicles",
    })),
  ];

  const rows = sortDecisions(decisions);

  return (
    <Card
      title="Needs a decision"
      description={rows.length === 0 ? undefined : `${rows.length} open`}
      className="[&>div]:p-0"
    >
      {/* Cards need their own gutter on a phone; the table is flush to the card
          edge on a desktop, and so is the empty state's dashed frame. */}
      <div className={rows.length ? "p-4 sm:p-0" : "p-4"}>
        <DataTable
                    bare
          rows={rows}
          label="Things needing a decision"
          rowClassName={(row) => cx("border-l-[3px]", SEVERITY_RULE[row.severity])}
          empty={
            <EmptyState
              title="Nothing needs a decision"
              description="No exceptions, no linen short, nothing past terms."
            />
          }
          columns={[
            {
              header: "Customer / issue",
              cell: (row) => (
                <>
                  <span className="font-semibold">{row.customer}</span>
                  <span className="text-muted-foreground"> — {row.summary}</span>
                </>
              ),
            },
            {
              header: "State",
              cell: (row) => (
                <span className={cx("whitespace-nowrap text-xs", SEVERITY_TEXT[row.severity])}>
                  {row.state}
                </span>
              ),
            },
            { header: "Size", align: "right", cell: (row) => row.measure },
            {
              header: "Since", hideBelow: "md",
              cell: (row) => (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDate(row.when)}
                </span>
              ),
            },
            {
              header: "Reference", hideBelow: "lg",
              cell: (row) => (
                <span className="whitespace-nowrap text-xs">{row.reference}</span>
              ),
            },
            {
              header: "",
              align: "right",
              cell: (row) => (
                <Link href={row.href} className="font-medium text-primary hover:underline">
                  {row.action}
                </Link>
              ),
            },
          ]}
        />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ plant stages */

async function PlantStages() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("inventory_pools").select("state, quantity").gt("quantity", 0)
    .returns<Array<{ state: string; quantity: number }>>();

  const byState = new Map<string, number>();
  for (const row of data ?? []) {
    byState.set(row.state, (byState.get(row.state) ?? 0) + Number(row.quantity ?? 0));
  }

  // The pack highlights whichever stage has backed up. Derived rather than
  // hard-coded to folding, so the highlight follows the actual bottleneck.
  const peak = Math.max(...PLANT_STAGES.map((stage) => byState.get(stage.state) ?? 0), 0);

  return (
    <Card title="Plant stages now" description="Items currently held in each state.">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {PLANT_STAGES.map((stage) => {
          const quantity = byState.get(stage.state) ?? 0;
          const bottleneck = quantity > 0 && quantity === peak && stage.state !== "at_depot";
          return (
            <div key={stage.state}
                 className={cx("rounded-lg border px-2.5 py-2", bottleneck && "border-warning/40 bg-warning/5")}>
              <Eyebrow className={bottleneck ? "text-warning" : undefined}>{stage.label}</Eyebrow>
              <div className={cx(
                "mt-0.5 text-[17px] font-semibold tabular-nums",
                bottleneck && "text-warning",
              )}>
                {number(quantity)}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------- runs today */

/* ------------------------------------------------------------- job board */

/**
 * Where the counter's work has got to, as counts.
 *
 * This panel used to be "Runs today" — a list of RUN-001, RUN-002 and a "Plan my
 * day" button. Runs are no longer something anybody opens or manages, so the
 * slot now answers the question the office actually has at a glance: how much
 * work is at each stage, and how much of it has a driver.
 *
 * Every figure is a head-only count against the database rather than a tally of
 * some page's rows, and every one links to the Jobs list already filtered to
 * exactly what it counted — so the number and the rows behind it cannot disagree.
 */
async function JobBoard() {
  const supabase = await createClient();
  const head = { count: "exact" as const, head: true };
  const today = businessToday();

  const [fresh, working, ready, assigned, out, completedToday] = await Promise.all([
    supabase.from("laundry_orders").select("id", head).eq("status", "new"),
    supabase.from("laundry_orders").select("id", head).eq("status", "in_progress"),
    supabase.from("laundry_orders").select("id", head).eq("status", "ready_for_delivery"),
    supabase.from("laundry_orders").select("id", head).eq("status", "assigned"),
    supabase.from("laundry_orders").select("id", head).eq("status", "out_for_delivery"),
    supabase.from("laundry_orders").select("id", head)
      .eq("status", "completed")
      .gte("completed_at", toInstant(today, "00:00"))
      .lt("completed_at", toInstant(addDays(today, 1), "00:00")),
  ]);

  const rows = [
    { label: "New", value: fresh.count, href: "/orders?status=new" },
    { label: "In progress", value: working.count, href: "/orders?status=in_progress" },
    {
      label: "Ready for delivery", value: ready.count,
      href: "/orders?status=ready_for_delivery",
      // The one row that is a call to action rather than a statement: ready
      // work with no driver is the thing that quietly does not go out.
      hint: "Needs a driver",
    },
    { label: "Assigned", value: assigned.count, href: "/orders?status=assigned" },
    { label: "Out for delivery", value: out.count, href: "/orders?status=out_for_delivery" },
    { label: "Completed today", value: completedToday.count, href: "/orders?status=completed" },
  ];

  return (
    <Card title="Jobs" description="Where the day's laundry has got to." className="[&>div]:p-0">
      <ul>
        {rows.map((row) => (
          <li key={row.label} className="border-b last:border-b-0">
            <Link href={row.href}
                  className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5
                             transition hover:bg-surface-muted">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{row.label}</span>
                {row.hint && (row.value ?? 0) > 0 ? (
                  <span className="block text-xs text-muted-foreground">{row.hint}</span>
                ) : null}
              </span>
              <span className="text-lg font-semibold tabular-nums">{row.value ?? 0}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------------ my run */

async function MyRun({ session, date }: { session: Session; date: string }) {
  const supabase = await createClient();
  const { data: driver } = await supabase
    .from("drivers").select("id, full_name").eq("user_id", session.userId).maybeSingle();

  if (!driver) {
    return (
      <Card title="Today's run">
        <EmptyState
          title="Your login is not linked to a driver yet"
          description={"Your deliveries will show here once it is. Whoever looks after the app " +
                       "can link it under Fleet \u203a Drivers."}
          action={<ButtonLink href="/drivers" variant="primary">Go to Drivers</ButtonLink>}
        />
      </Card>
    );
  }

  const [{ data: route }, { count: stops }, { count: doneStops }] = await Promise.all([
    supabase.from("daily_routes").select("id, code, name, status")
      .eq("driver_id", driver.id).eq("route_date", date).maybeSingle(),
    supabase.from("jobs").select("id", { count: "exact", head: true })
      .eq("driver_id", driver.id).eq("scheduled_date", date),
    supabase.from("jobs").select("id", { count: "exact", head: true })
      .eq("driver_id", driver.id).eq("scheduled_date", date).eq("status", "completed"),
  ]);

  return (
    <Card title="Today's run" description={driver.full_name}>
      {route ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-semibold">{route.code} · {route.name}</span>
          <StatusBadge status={route.status} />
          <span className="text-xs text-muted-foreground">
            {doneStops ?? 0} / {stops ?? 0} stops
          </span>
          <Link href="/run" className="font-medium text-primary hover:underline">Open my run →</Link>
        </div>
      ) : (
        <EmptyState title="No run assigned for today" />
      )}
    </Card>
  );
}
