import { Suspense } from "react";
import { requireSession, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { counted, date as formatDate, money, number, today } from "@/lib/format";
import {
  ButtonLink, Card, EmptyState, Eyebrow, FlashMessages, PageHeader, SkeletonRows,
  SkeletonStats, Stage, Stat, cx,
} from "@/components/ui";
import { QuickActions } from "@/components/quick-actions";
import { DEFAULT_AR_TRUSTED_FROM, arTrustedFrom, trustedReceivablesFilter } from "@/lib/domain/receivables";
import { PLANT_STAGES } from "./plant-stages";
import { parseOperations } from "@/lib/domain/operations-settings";
import { inboxSectionsFor, type InboxSection } from "@/lib/domain/inbox";
import { DraftsReady, NeedsDriver, NeedsPrice, Overdue, Problems } from "./inbox";

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
  const sections = inboxSectionsFor(session.role);
  const plant = await plantIsOn(session.tenantId);

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
        description="What is waiting on you, with the one thing to do about each."
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

      <Suspense fallback={<SkeletonStats count={4} />}>
        <Kpis date={date} seesMoney={seesMoney} tenantId={session.tenantId} plant={plant} />
      </Suspense>

      {/* Only a round or a driver has a run of their own. The owner and the
          office hold run.execute through TENANT_ALL, and were being told their
          login was "not linked to a driver" on every visit to the home screen. */}
      {(session.role === "driver" || session.role === "board") && can(session.role, "run.execute") ? (
        <Suspense fallback={<SkeletonRows rows={2} />}>
          <MyRun session={session} date={date} />
        </Suspense>
      ) : null}

      {/*
        The inbox (brief 3.2): five sections of things waiting on a person,
        each row with the one action that clears it. Drawn only for a role that
        can act on the section — see `inboxSectionsFor`.
      */}
      {sections.length > 0 ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {sections.map((section) => (
            <Suspense key={section} fallback={<SkeletonRows rows={3} />}>
              {INBOX[section]({ session })}
            </Suspense>
          ))}
        </div>
      ) : null}

      {/* The plant only while the laundry records batches (brief 3.9). */}
      {seesOperations && plant ? (
        <Suspense fallback={<SkeletonRows rows={2} />}>
          <PlantStages />
        </Suspense>
      ) : null}
    </div>
  );
}

/** The five sections, by key. Each is a server component reading its own rows. */
const INBOX: Record<InboxSection, (props: { session: Session }) => Promise<React.JSX.Element>> = {
  needs_price: NeedsPrice,
  needs_driver: NeedsDriver,
  problems: Problems,
  drafts_ready: DraftsReady,
  overdue: Overdue,
};

async function plantIsOn(tenantId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.from("tenants").select("settings").eq("id", tenantId)
    .maybeSingle<{ settings: unknown }>();
  return parseOperations(data?.settings).plantStages;
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

  const [depots, customers, prices, drivers, orders] = await Promise.all([
    supabase.from("depots").select("id", head).is("deleted_at", null),
    supabase.from("customers").select("id", head).is("deleted_at", null),
    supabase.from("laundry_prices").select("id", head),
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
      // Matches the form's required fields and its round and billing questions (brief 3.6).
      detail: "Their name, phone, invoice email and address — and which round calls and how you bill them.",
      href: "/customers/new", action: "Add a customer",
      done: (customers.count ?? 0) > 0,
    },
    {
      // A price list rather than a contract: ATS prices from its list, and
      // the contract model does not fit how it works (2026-09-08).
      label: "Set your prices",
      detail: "What each item costs. A customer with a price of their own can have it on their page.",
      href: "/invoices/prices", action: "Set prices",
      done: (prices.count ?? 0) > 0,
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
/**
 * The day from which an imported invoice counts on Today (brief 1.9). Read once
 * per render by both the tile and the list, so they cannot disagree.
 */
async function trustedFrom(tenantId: string): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.from("tenants").select("settings").eq("id", tenantId)
    .maybeSingle<{ settings: unknown }>();
  return arTrustedFrom(data?.settings);
}

async function Kpis({ date, seesMoney, tenantId, plant }: {
  date: string; seesMoney: boolean; tenantId: string;
  /** The plant tiles are drawn only while batches are recorded (brief 3.9). */
  plant: boolean;
}) {
  const supabase = await createClient();
  const head = { count: "exact" as const, head: true };
  const trusted = seesMoney ? await trustedFrom(tenantId) : DEFAULT_AR_TRUSTED_FROM;

  const [jobsTotal, jobsDone, exceptions, pools, overdue, staleDrafts] = await Promise.all([
    supabase.from("jobs").select("id", head).eq("scheduled_date", date),
    supabase.from("jobs").select("id", head).eq("scheduled_date", date).eq("status", "completed"),
    supabase.from("jobs").select("id", head).eq("status", "exception"),
    plant
      ? supabase.from("inventory_pools").select("state, quantity")
          .in("state", ["washing", "drying", "folding", "packing", "ready_for_dispatch"])
          .gt("quantity", 0)
          .returns<Array<{ state: string; quantity: number }>>()
      : Promise.resolve({ data: [] as Array<{ state: string; quantity: number }> }),
    seesMoney
      ? supabase.from("invoices").select("balance")
          .in("status", ["issued", "part_paid", "overdue"])
          // Money owed to us only: a credit or a settled-to-the-cent import is
          // not "past terms", and adding negatives in shrank the total.
          .gt("balance", 0.005).neq("invoice_type", "credit")
          .lt("due_date", date).is("deleted_at", null)
          .eq("tenant_id", tenantId)
          // Brief 1.9: MYOB history before the trusted day is not counted here.
          .or(trustedReceivablesFilter(trusted))
          .returns<Array<{ balance: number }>>()
      : Promise.resolve({ data: [] as Array<{ balance: number }> }),
    // Brief 1.4: drafts whose period has ended — work waiting on somebody to
    // press Issue. Counted, never issued: nothing here acts on them.
    seesMoney
      ? supabase.from("invoices").select("id", head)
          .eq("tenant_id", tenantId).eq("status", "draft")
          .not("period_end", "is", null).lt("period_end", date).is("deleted_at", null)
      : Promise.resolve({ count: 0 }),
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
  const drafts = staleDrafts.count ?? 0;

  return (
    <div className={cx(
      "grid gap-4 sm:grid-cols-2",
      (seesMoney ? 4 : 2) + (plant ? 2 : 0) > 4 ? "lg:grid-cols-6" : "lg:grid-cols-4",
    )}>
      <Stat
        label="Stops today"
        value={<>{done}<span className="text-sm font-normal text-muted-foreground"> / {total}</span></>}
        hint={total === 0 ? "nothing scheduled" : `${remaining} remaining`}
        tone={total > 0 && remaining === 0 ? "success" : "default"}
      />
      {plant ? (
        <>
          <Stat label="In the plant" value={number(inPlant)} hint="washing through to ready" />
          <Stat
            label="Ready to dispatch"
            value={number(ready)}
            hint={ready > 0 ? "waiting on a truck" : "nothing staged"}
            tone={ready > 0 ? "success" : "default"}
          />
        </>
      ) : null}
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
          hint={`${counted(overdueRows.length, "invoice")} past terms · MYOB history before ${formatDate(trusted)} not counted`}
          tone={overdueTotal > 0 ? "warning" : "success"}
        />
      ) : null}
      {seesMoney ? (
        <Stat
          label="Drafts from a finished period"
          value={String(drafts)}
          hint={drafts === 0 ? "nothing waiting to issue" : "waiting for you to issue them"}
          tone={drafts > 0 ? "warning" : "success"}
          href="/invoices/drafts"
        />
      ) : null}
    </div>
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
                "mt-0.5 text-lg font-semibold tabular-nums",
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

/* ------------------------------------------------------------------ my run */

async function MyRun({ session, date }: { session: Session; date: string }) {
  // Since boards (0031) a run is found by its round, not by daily_routes.driver_id
  // — runs are created with board_id and no driver, so the old driver lookup
  // always answered "No run assigned". My Runs already resolves the caller's
  // own work correctly, so this card points there rather than re-deriving it.
  void date;
  const supabase = await createClient();
  const { data: driver } = session.role === "driver"
    ? await supabase.from("drivers").select("id").eq("user_id", session.userId).maybeSingle()
    : { data: { id: "board" } };

  if (!driver) {
    return (
      <Card title="Today's run">
        <EmptyState
          title="Your login is not linked to a driver yet"
          description="Your deliveries will show here once it is. Ask whoever looks after the app to link it under Fleet › Drivers."
        />
      </Card>
    );
  }

  return (
    <Card title="Today's run" description="Your deliveries for today, in the order the office set.">
      <ButtonLink href="/my-runs" variant="primary">Open My Runs</ButtonLink>
    </Card>
  );
}
