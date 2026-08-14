import { Suspense } from "react";
import Link from "next/link";
import { MapPin, Truck } from "lucide-react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import {
  ButtonLink, Card, EmptyState, Notice, PageContainer, PageHeader,
  SkeletonRows, StatusBadge, cx,
} from "@/components/ui";
import {
  OPERATIONS_TIMEZONE, formatAdelaideDate, formatAdelaideDateTime,
  getAdelaideNow, getAdelaideToday, isCalendarDate,
} from "@/lib/domain/timezone";
import { summariseItems } from "@/lib/domain/laundry-orders";
import {
  RUN_STAGE_LABELS, describeProgress, jobProgress, runStage, stopProgress,
} from "@/lib/domain/run-assignment";
import {
  loadOpenRuns, loadRuns, loadUnassignedDeliveryJobs, resolveDriverScope,
  type Run, type UnassignedJob,
} from "@/lib/runs/my-runs";
import { DateNav } from "./date-nav";
import { RunWorkflow } from "./run-workflow";
import { AssignForm } from "./assign-form";
import { StopCard, Summary } from "./run-view";

export const metadata = { title: "My runs" };
export const dynamic = "force-dynamic";

type Search = { date?: string; driver?: string };

/**
 * My Runs — the operational, personal view of a day's assigned work.
 *
 * Not a second Runs module. `/routes/daily` remains the management view of
 * every run, `/routes/planner` remains where a day is composed, and the run
 * sheet remains the printable record. What this screen answers is the driver's
 * four questions and nothing else: what am I delivering, where, in what order,
 * and what is left.
 *
 * The date is Adelaide's throughout — the default, the arrows, the day boundary
 * a timestamp is rendered against. `?date=` and `?driver=` carry the state so
 * the view is bookmarkable and a dispatcher can send someone a link to it.
 */
export default async function MyRunsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireCapability("routes.read");

  // A bad `?date=` is corrected to today rather than shown as an error: it can
  // only get there by hand, and an operator staring at a validation message on a
  // screen they open every morning is worse than a screen that just works.
  const date = params.date && isCalendarDate(params.date) ? params.date : getAdelaideToday();
  const driverParam = params.driver ?? "me";

  const supabase = await createClient();
  const scope = await resolveDriverScope(supabase, session, driverParam);
  const dispatches = can(session.role, "routes.write");

  return (
    <PageContainer>
      <PageHeader
        title="My runs"
        description={
          scope.driver && scope.isSelf
            ? `${greeting()}, ${firstName(scope.driver.full_name)}. Here is your work for the day.`
            : scope.driver
              ? `${scope.driver.full_name}'s work for the day.`
              : "The work assigned to you, for any day you choose."
        }
        eyebrow={formatAdelaideDate(date, "long")}
        actions={
          scope.driver && dispatches
            ? <ButtonLink href={`/routes/daily?date=${date}`}>Manage all runs</ButtonLink>
            : null
        }
      />

      <DateNav
        date={date}
        driverParam={scope.driver && !scope.isSelf ? scope.driver.id : "me"}
        drivers={scope.drivers}
        canChooseDriver={scope.canChooseDriver}
      />

      {!scope.driver ? (
        <NoDriver canChooseDriver={scope.canChooseDriver} />
      ) : (
        <Suspense key={`${date}:${scope.driver.id}`} fallback={<SkeletonRows rows={6} />}>
          <Day
            driverId={scope.driver.id}
            driverName={scope.driver.full_name}
            date={date}
            isSelf={scope.isSelf}
            canRunWorkflow={scope.isSelf && can(session.role, "run.execute")}
            canDeliver={scope.isSelf ? can(session.role, "run.execute") : false}
            dispatches={dispatches}
            hasOrdersStatus={can(session.role, "orders.status")}
          />
        </Suspense>
      )}

      {dispatches ? (
        <Suspense fallback={null}>
          <UnassignedQueue
            date={date}
            driverId={scope.driver?.id ?? null}
            driverName={scope.driver?.full_name ?? null}
            drivers={scope.drivers}
          />
        </Suspense>
      ) : null}
    </PageContainer>
  );
}

/* ------------------------------------------------------------------- day */

async function Day({
  driverId, driverName, date, isSelf, canRunWorkflow, canDeliver, dispatches, hasOrdersStatus,
}: {
  driverId: string; driverName: string; date: string; isSelf: boolean;
  canRunWorkflow: boolean; canDeliver: boolean; dispatches: boolean; hasOrdersStatus: boolean;
}) {
  const supabase = await createClient();
  const runs = await loadRuns(supabase, driverId, date);

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<Truck className="size-5" />}
        title={isSelf ? "No runs assigned for today" : `No runs for ${driverName}`}
        description={
          `There is currently no delivery work assigned ${isSelf ? "to you" : `to ${driverName}`}`
          + ` for ${formatAdelaideDate(date, "long")}.`
          + (dispatches ? " Anything ready to go out is listed below." : "")
        }
        action={
          dispatches
            ? <ButtonLink href={`/routes/planner?date=${date}`} variant="primary">Plan the day</ButtonLink>
            : null
        }
      />
    );
  }

  const stops = runs.flatMap((run) => run.stops);
  const jobs = stops.flatMap((stop) => stop.jobs);
  const stopsDone = stopProgress(stops);
  const jobsDone = jobProgress(jobs);

  return (
    <div className="space-y-5">
      {/* The phone's running total. Sticky so it survives a long scroll through
          twelve stops, and short enough that it never covers the content it is
          summarising. */}
      <div className="sticky top-0 z-10 -mx-4 border-b bg-surface/95 px-4 py-2 backdrop-blur
                      supports-[backdrop-filter]:bg-surface/80 sm:hidden">
        <p className="text-sm font-semibold">
          {formatAdelaideDate(date, "short")} · {describeProgress(stopsDone, "stop")}
        </p>
      </div>

      <Summary
        driverName={driverName}
        date={date}
        runs={runs.length}
        stops={stopsDone}
        jobs={jobsDone}
      />

      {runs.map((run) => (
        <RunPanel
          key={run.id}
          run={run}
          date={date}
          canRunWorkflow={canRunWorkflow}
          canDeliver={canDeliver}
          dispatches={dispatches}
          hasOrdersStatus={hasOrdersStatus}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ runs */

function RunPanel({
  run, date, canRunWorkflow, canDeliver, dispatches, hasOrdersStatus,
}: {
  run: Run; date: string; canRunWorkflow: boolean; canDeliver: boolean;
  dispatches: boolean; hasOrdersStatus: boolean;
}) {
  const stage = runStage(run.status);
  const progress = stopProgress(run.stops);
  const returnTo = `/my-runs?date=${date}`;

  return (
    <Card
      title={`${run.code} · ${run.name}`}
      description={
        `${RUN_STAGE_LABELS[stage]} · ${describeProgress(progress, "stop")}`
        + (run.started_at ? ` · started ${formatAdelaideDateTime(run.started_at)}` : "")
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={run.status} />
          {dispatches ? (
            <ButtonLink href={`/routes/daily/${run.id}`} size="sm">Manage run</ButtonLink>
          ) : null}
        </div>
      }
    >
      {canRunWorkflow ? <RunWorkflow run={run} returnTo={returnTo} /> : null}

      {run.stops.length === 0 ? (
        <EmptyState
          icon={<MapPin className="size-5" />}
          title="This run has no stops yet"
          description={
            dispatches
              ? "Assign a job to this driver and date below, or plan the day to add stops."
              : "Your dispatcher has not added any stops to this run."
          }
        />
      ) : (
        <ol className={cx("space-y-4", canRunWorkflow && "mt-5")}>
          {run.stops.map((stop) => (
            <StopCard
              key={stop.id}
              stop={stop}
              runStatus={run.status}
              returnTo={returnTo}
              canDeliver={canDeliver || hasOrdersStatus}
              dispatches={dispatches}
              showCapture={canRunWorkflow}
            />
          ))}
        </ol>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ unassigned */

async function UnassignedQueue({
  date, driverId, driverName, drivers,
}: {
  date: string; driverId: string | null; driverName: string | null;
  drivers: Array<{ id: string; full_name: string }>;
}) {
  const supabase = await createClient();
  const [jobs, openRuns] = await Promise.all([
    loadUnassignedDeliveryJobs(supabase, { onOrBefore: date }),
    // Only needed for the "which run?" case, and only answerable because this
    // screen already knows the driver and the date.
    driverId ? loadOpenRuns(supabase, driverId, date) : Promise.resolve([]),
  ]);

  return (
    <Card
      className="mt-6"
      title="Ready for delivery, on nobody's run"
      description={
        `Delivery work due on or before ${formatAdelaideDate(date, "medium")} that has not been `
        + "given to a driver. Customer pickups are not listed — they never go on a delivery run."
      }
    >
      {jobs.length === 0 ? (
        <Notice tone="success">
          Everything ready to go out is on a run. Nothing is waiting for a driver.
        </Notice>
      ) : (
        <ul className="space-y-3">
          {jobs.map((job) => (
            <UnassignedRow
              key={job.id}
              job={job}
              date={date}
              driverId={driverId}
              driverName={driverName}
              drivers={drivers}
              runs={openRuns}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function UnassignedRow({
  job, date, driverId, driverName, drivers, runs,
}: {
  job: UnassignedJob; date: string; driverId: string | null;
  driverName: string | null; drivers: Array<{ id: string; full_name: string }>;
  runs: Array<{ id: string; code: string; name: string }>;
}) {
  return (
    <li className="rounded-xl border p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            <Link href={`/orders/${job.id}`} className="hover:underline">{job.order_number}</Link>
            {" · "}
            {job.customers?.business_name ?? "Unknown customer"}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {summariseItems(job.laundry_order_items, 3)}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Due {formatAdelaideDate(job.due_date, "medium")}
            {job.delivery_address ? ` · ${job.delivery_address}` : ""}
          </p>
        </div>
        <div className="lg:w-[26rem] lg:shrink-0">
          <AssignForm
            orderId={job.id}
            defaultDriverId={driverId}
            defaultDriverName={driverName}
            defaultDate={date}
            dueDate={job.due_date}
            drivers={drivers}
            runs={runs}
            returnTo={`/my-runs?date=${date}${driverId ? `&driver=${driverId}` : ""}`}
          />
        </div>
      </div>
    </li>
  );
}

/* ----------------------------------------------------------------- bits */

function NoDriver({ canChooseDriver }: { canChooseDriver: boolean }) {
  return (
    <Notice tone="warning" title="No driver profile linked to your login">
      {canChooseDriver
        ? "Your own login is not linked to a driver record, so there is no personal run to show. "
          + "Choose a driver above to see their day."
        : "A dispatcher needs to link your account to a driver record before your runs appear here."}
    </Notice>
  );
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/** Morning / afternoon / evening, decided in Adelaide rather than on the server. */
function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: OPERATIONS_TIMEZONE, hour: "2-digit", hour12: false,
    }).format(getAdelaideNow()),
  ) % 24;
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}
