import { Suspense } from "react";
import Link from "next/link";
import { requireSession, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date as formatDate, money, number, relativeDays, today } from "@/lib/format";
import {
  ButtonLink, Card, EmptyState, Eyebrow, FlashMessages, PageHeader, SkeletonRows,
  SkeletonStats, Stage, Stat, StatusBadge, cx, humanise,
} from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { parseExceptionNotes } from "@/lib/exceptions";
import { planToday } from "@/app/(app)/routes/daily/actions";
import {
  PLANT_STAGES, SEVERITY_RULE, SEVERITY_TEXT, sortDecisions, type Decision,
} from "./decisions";

export const metadata = { title: "Dashboard" };
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
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <FlashMessages error={params.error === "forbidden" ? FORBIDDEN : undefined} />
      <PageHeader
        eyebrow={`${session.tenantName} · ${formatDate(date)}`}
        title="Dashboard"
        description="What needs a decision today."
        actions={can(session.role, "routes.write") ? (
          // One click from the weekly templates to a planned day (design B3).
          // The action lands on the planner only when a choice is left to make.
          <form action={planToday}>
            <SubmitButton pendingLabel="Planning…">Plan my day</SubmitButton>
          </form>
        ) : null}
      />

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
          <Suspense fallback={<SkeletonRows rows={4} />}>
            <RunsToday date={date} canPlan={can(session.role, "routes.write")} />
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

  const [depots, customers, agreements, templates, routes] = await Promise.all([
    supabase.from("depots").select("id", head).is("deleted_at", null),
    supabase.from("customers").select("id", head).is("deleted_at", null),
    supabase.from("service_agreements").select("id", head).is("deleted_at", null),
    supabase.from("route_templates").select("id", head).is("deleted_at", null),
    supabase.from("daily_routes").select("id", head),
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
      label: "Set up the weekly run",
      detail: "The recurring week: which customers a driver visits, in what order.",
      href: "/routes/templates", action: "Set up a weekly run",
      done: (templates.count ?? 0) > 0,
    },
    {
      label: "Plan today's runs",
      detail: "Turn the weekly run into today's work and hand it to a driver.",
      href: "/routes/daily", action: "Plan today",
      done: (routes.count ?? 0) > 0,
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
      "grid gap-px border bg-border",
      seesMoney ? "sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-2 lg:grid-cols-4",
    )}>
      <Stat
        flush
        label="Stops today"
        value={<>{done}<span className="text-sm font-normal text-muted-foreground"> / {total}</span></>}
        hint={total === 0 ? "nothing scheduled" : `${remaining} remaining`}
        tone={total > 0 && remaining === 0 ? "success" : "default"}
      />
      <Stat flush label="In the plant" value={number(inPlant)} hint="washing through to ready" />
      <Stat
        flush
        label="Ready to dispatch"
        value={number(ready)}
        hint={ready > 0 ? "waiting on a truck" : "nothing staged"}
        tone={ready > 0 ? "success" : "default"}
      />
      <Stat
        flush
        label="Problems"
        value={String(late)}
        hint={late === 0 ? "none open" : "need a decision"}
        tone={late > 0 ? "danger" : "success"}
      />
      {seesMoney ? (
        <Stat
          flush
          label="Overdue"
          value={money(overdueTotal)}
          hint={`${overdueRows.length} invoice(s) past terms`}
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
        summary: `${daysOver} day(s) past terms`,
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
      {rows.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="Nothing needs a decision"
            description="No exceptions, no linen short, nothing past terms."
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="bg-surface-muted text-left">
              <tr>
                {["Reference", "Customer / issue", "State", "Size", "Since", "Action"].map((header, index) => (
                  <th key={header} scope="col"
                      className={cx(
                        "px-3 py-1.5 font-mono text-3xs font-normal uppercase",
                        "tracking-[0.08em] text-muted-foreground",
                        index === 3 && "text-right",
                      )}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.reference}-${row.when}-${index}`}
                    className={cx(
                      "border-t border-l-[3px] transition hover:bg-surface-muted",
                      SEVERITY_RULE[row.severity],
                    )}>
                  <td className="px-3 py-2 font-mono text-[11.5px] whitespace-nowrap">{row.reference}</td>
                  <td className="px-3 py-2">
                    <span className="font-semibold">{row.customer}</span>
                    <span className="text-muted-foreground"> — {row.summary}</span>
                  </td>
                  <td className={cx("px-3 py-2 text-[11.5px] whitespace-nowrap", SEVERITY_TEXT[row.severity])}>
                    {row.state}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11.5px] tabular-nums whitespace-nowrap">
                    {row.measure}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground whitespace-nowrap">
                    {formatDate(row.when)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Link href={row.href} className="font-medium text-primary hover:underline">{row.action}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
                 className={cx("border px-2.5 py-2", bottleneck && "border-warning/40 bg-warning/5")}>
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

type RunRow = {
  id: string; code: string; name: string; status: string;
  drivers: { full_name: string } | null;
  jobs: Array<{ status: string }>;
};

async function RunsToday({ date, canPlan }: { date: string; canPlan: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("daily_routes")
    .select("id, code, name, status, drivers(full_name), jobs(status)")
    .eq("route_date", date).order("code")
    .returns<RunRow[]>();

  const runs = data ?? [];

  return (
    <Card title="Runs today" className="[&>div]:p-0">
      {runs.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="No runs planned"
            description="One click builds today from your weekly runs."
            action={canPlan ? (
              <form action={planToday}>
                <SubmitButton pendingLabel="Planning…">Plan my day</SubmitButton>
              </form>
            ) : undefined}
          />
        </div>
      ) : (
        <ul>
          {runs.map((run) => {
            const total = run.jobs?.length ?? 0;
            const done = (run.jobs ?? []).filter((job) => job.status === "completed").length;
            const percent = total === 0 ? 0 : Math.round((done / total) * 100);
            const behind = percent < 100 && run.status === "in_progress";
            return (
              <li key={run.id} className="border-b last:border-b-0">
                <Link href={`/routes/daily/${run.id}`}
                      className="block px-4 py-2.5 transition hover:bg-surface-muted">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12.5px] font-semibold">{run.code} · {run.name}</span>
                    <span className={cx(
                      "font-mono text-[11px] tabular-nums",
                      percent === 100 ? "text-success" : behind ? "text-warning" : "text-muted-foreground",
                    )}>
                      {done} / {total}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="truncate text-[11.5px] text-muted-foreground">
                      {run.drivers?.full_name ?? "Unassigned"}
                    </span>
                    <StatusBadge status={run.status} />
                  </div>
                  <div aria-hidden className="mt-1.5 h-[5px] bg-surface-muted">
                    <div className={cx("h-full", percent === 100 ? "bg-success" : "bg-primary")}
                         style={{ width: `${percent}%` }} />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
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
          title="No driver profile linked to your account"
          description="A dispatcher needs to link your login to a driver record."
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
        <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
          <span className="font-semibold">{route.code} · {route.name}</span>
          <StatusBadge status={route.status} />
          <span className="font-mono text-[11.5px] text-muted-foreground">
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
