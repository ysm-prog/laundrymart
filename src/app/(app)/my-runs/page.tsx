import { Suspense } from "react";
import { PackageCheck } from "lucide-react";
import { requireCapability, requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import {
  EmptyState, Notice, PageContainer, PageHeader, SkeletonRows,
} from "@/components/ui";
import {
  OPERATIONS_TIMEZONE, formatAdelaideDate, getAdelaideNow, getAdelaideToday, isCalendarDate,
} from "@/lib/domain/timezone";
import { groupDriverDay } from "@/lib/domain/run-assignment";
import { loadDriverDayJobs, resolveDriverScope } from "@/lib/runs/my-runs";
import { DateNav } from "./date-nav";
import { DayWorkflow } from "./run-workflow";
import { DaySummary, JobCard, JobGroup } from "./run-view";

export const metadata = { title: "My Runs" };
export const dynamic = "force-dynamic";

type Search = { date?: string; driver?: string };

/**
 * My Runs — the driver's whole workspace, and nothing else.
 *
 * The screen answers one question: **what am I delivering on this day?** It used
 * to answer that by showing runs, each with its code, its own five-stage
 * workflow and its stops, with the laundry nested two levels down. A driver had
 * to understand RUN-001 and the difference between a Stop and a Job before they
 * could find out where to drive.
 *
 * Now it is a list of jobs assigned to them for the chosen date, grouped by how
 * far along each one is, with two day-level buttons in front of it. No run code
 * appears anywhere on it; the `daily_routes` row underneath still exists and is
 * still maintained, but it has stopped being the driver's problem.
 *
 * The date is Adelaide's throughout — the default, the arrows, the day a job is
 * filed under. `?date=` and `?driver=` carry the state, so the view is
 * bookmarkable, survives a round trip into a job and back, and a dispatcher can
 * send someone a link to it.
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

  return (
    <PageContainer>
      <PageHeader
        title="My Runs"
        description={
          scope.driver && scope.isSelf
            ? `${greeting()}, ${firstName(scope.driver.full_name)}. Here is your work for the day.`
            : scope.driver
              ? `${scope.driver.full_name}'s work for the day.`
              : "The deliveries assigned to you, for any day you choose."
        }
        eyebrow={formatAdelaideDate(date, "long")}
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
        <Suspense key={`${date}:${scope.driver.id}`} fallback={<SkeletonRows rows={5} />}>
          <Day
            driverId={scope.driver.id}
            driverName={scope.driver.full_name}
            date={date}
            isSelf={scope.isSelf}
            // Working the day — Confirm Load, Start Route, Mark Delivered — is
            // the driver's own. Dispatch and management may do it on their
            // behalf, which is the existing convention for looking at somebody
            // else's day; the action re-derives the same answer from the
            // database, so this only decides what is drawn.
            canWork={
              (scope.isSelf && can(session.role, "run.execute"))
              || can(session.role, "routes.write")
            }
          />
        </Suspense>
      )}
    </PageContainer>
  );
}

/* ------------------------------------------------------------------- day */

async function Day({
  driverId, driverName, date, isSelf, canWork,
}: {
  driverId: string; driverName: string; date: string; isSelf: boolean; canWork: boolean;
}) {
  const session = await requireSession();
  const supabase = await createClient();
  const jobs = await loadDriverDayJobs(supabase, session.tenantId, driverId, date);
  const day = groupDriverDay(jobs);
  const returnTo = `/my-runs?date=${date}${isSelf ? "" : `&driver=${driverId}`}`;

  if (day.total === 0) {
    return (
      <EmptyState
        icon={<PackageCheck className="size-5" />}
        title="No jobs assigned"
        description={
          `${isSelf ? "You do not have" : `${driverName} does not have`} any delivery jobs `
          + `assigned for ${formatAdelaideDate(date, "long")}.`
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* The phone's running total. Sticky so it survives a long scroll, and
          short enough that it never covers the content it is summarising. */}
      <div className="sticky top-0 z-10 -mx-4 border-b bg-surface/95 px-4 py-2 backdrop-blur
                      supports-[backdrop-filter]:bg-surface/80 sm:hidden">
        <p className="text-sm font-semibold">
          {formatAdelaideDate(date, "short")} ·{" "}
          {day.outstanding === 0
            ? "all delivered"
            : `${day.outstanding} to go`}
        </p>
      </div>

      <DaySummary
        driverName={driverName}
        date={date}
        toDeliver={day.toDeliver.length}
        outForDelivery={day.outForDelivery.length}
        completed={day.completed.length}
      />

      {canWork ? (
        <DayWorkflow jobs={jobs} driverId={driverId} date={date} returnTo={returnTo} />
      ) : null}

      <JobGroup title="To deliver" count={day.toDeliver.length}>
        {day.toDeliver.map((job) => (
          <JobCard key={job.id} job={job} actionable={canWork} />
        ))}
      </JobGroup>

      <JobGroup title="Out for delivery" count={day.outForDelivery.length}>
        {day.outForDelivery.map((job) => (
          <JobCard key={job.id} job={job} actionable={canWork} />
        ))}
      </JobGroup>

      {/* Completed work stays on the day it was done, so coming back to an
          earlier date still shows what happened on it. */}
      <JobGroup title="Completed" count={day.completed.length}>
        {day.completed.map((job) => (
          <JobCard key={job.id} job={job} actionable={canWork} />
        ))}
      </JobGroup>
    </div>
  );
}

/* ----------------------------------------------------------------- bits */

function NoDriver({ canChooseDriver }: { canChooseDriver: boolean }) {
  return (
    <Notice tone="warning" title="No driver profile linked to your login">
      {canChooseDriver
        ? "Your own login is not linked to a driver record, so there is no personal day to show. "
          + "Choose a driver above to see their work."
        : "A manager needs to link your account to a driver record before your jobs appear here."}
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
