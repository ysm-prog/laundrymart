import { Suspense } from "react";
import { PackageCheck } from "lucide-react";
import { requireCapability, requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import {
  Badge, Card, EmptyState, Notice, PageContainer, PageHeader, SkeletonRows,
} from "@/components/ui";
import { counted } from "@/lib/format";
import {
  OPERATIONS_TIMEZONE, formatAdelaideDate, getAdelaideNow, getAdelaideToday, isCalendarDate,
} from "@/lib/domain/timezone";
import { groupRunDay } from "@/lib/domain/run-assignment";
import { loadBoardDayJobs, resolveBoardScope } from "@/lib/runs/my-runs";
import { loadBoardSequence } from "@/lib/runs/sequence-stops";
import { SequenceBoard } from "@/app/(app)/runs/sequence-board";
import { DateNav } from "./date-nav";
import { DayWorkflow } from "./run-workflow";
import { DaySummary, JobCard, JobGroup } from "./run-view";

export const metadata = { title: "My Runs" };
export const dynamic = "force-dynamic";

type Search = { date?: string; board?: string };

/**
 * My Runs — a delivery round's whole workspace, and nothing else.
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
 * filed under. `?date=` and `?board=` carry the state, so the view is
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
  const boardParam = params.board ?? "me";

  const supabase = await createClient();
  const scope = await resolveBoardScope(supabase, session, boardParam);

  return (
    <PageContainer>
      <PageHeader
        title="My Runs"
        description={
          scope.board && scope.isSelf
            ? `${greeting()}. Here is ${scope.board.name}'s work for the day.`
            : scope.board
              ? `${scope.board.name}'s work for the day.`
              : "The deliveries assigned to you, for any day you choose."
        }
        eyebrow={formatAdelaideDate(date, "long")}
      />

      <DateNav
        date={date}
        boardParam={scope.board && !scope.isSelf ? scope.board.id : "me"}
        boards={scope.boards}
        canChooseBoard={scope.canChooseBoard}
      />

      {!scope.board ? (
        <NoBoard canChooseBoard={scope.canChooseBoard} />
      ) : (
        <Suspense key={`${date}:${scope.board.id}`} fallback={<SkeletonRows rows={5} />}>
          <Day
            boardId={scope.board.id}
            boardName={scope.board.name}
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
            // Adjust Run is the Owner's and the Office manager's alone. It is
            // not `canWork`: a dispatcher may work somebody's day on their
            // behalf and still may not decide what order it is driven in, which
            // is the whole of the client's rule and of 0036's guard trigger.
            canSequence={can(session.role, "routes.sequence")}
          />
        </Suspense>
      )}
    </PageContainer>
  );
}

/* ------------------------------------------------------------------- day */

async function Day({
  boardId, boardName, date, isSelf, canWork, canSequence,
}: {
  boardId: string; boardName: string; date: string; isSelf: boolean;
  canWork: boolean; canSequence: boolean;
}) {
  const session = await requireSession();
  const supabase = await createClient();
  const jobs = await loadBoardDayJobs(supabase, session.tenantId, boardId, date);
  const day = groupRunDay(jobs);
  const returnTo = `/my-runs?date=${date}${isSelf ? "" : `&board=${boardId}`}`;

  if (day.total === 0) {
    return (
      <EmptyState
        icon={<PackageCheck className="size-5" />}
        title="No jobs assigned"
        description={
          `${isSelf ? "You do not have" : `${boardName} does not have`} any delivery jobs `
          + `assigned for ${formatAdelaideDate(date, "long")}.`
        }
      />
    );
  }

  // Read only for the two roles that may act on it, and only once there is a day
  // to order — a round opening its own workspace pays for no extra query. It is
  // the same read the Runs screen and the save action both perform, so the
  // version drawn here is the version the save is checked against.
  const sequence = canSequence
    ? await loadBoardSequence(supabase, session.tenantId, boardId, date)
    : null;

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
        boardName={boardName}
        date={date}
        toDeliver={day.toDeliver.length}
        outForDelivery={day.outForDelivery.length}
        completed={day.completed.length}
      />

      {canWork ? (
        <DayWorkflow jobs={jobs} boardId={boardId} date={date} returnTo={returnTo} />
      ) : null}

      {sequence && sequence.stops.length > 0 ? (
        <Card
          title="Run order"
          description={
            "The order this round drives in. Press Adjust Run to move a stop, "
            + "then Save & Lock Run — the round sees the new order straight away."
          }
          actions={<Badge tone="neutral">{counted(sequence.stops.length, "stop")}</Badge>}
        >
          <SequenceBoard
            boardId={boardId}
            boardName={boardName}
            date={date}
            stops={sequence.stops}
            version={sequence.version}
            canSequence
            returnTo={returnTo}
          />
        </Card>
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

/**
 * The empty state that exists because the alternative reads as a broken app.
 *
 * A `board` membership with no `boards` row leaves `current_board_id()` null and
 * every board-scoped policy matching nothing — a login that works perfectly and
 * shows nothing at all. Saying so, and saying who fixes it, is the difference
 * between a missing link and a bug report.
 */
function NoBoard({ canChooseBoard }: { canChooseBoard: boolean }) {
  return (
    <Notice tone="warning" title="No board linked to your login">
      {canChooseBoard
        ? "Your own login is not linked to a board, so there is no round to show. "
          + "Choose a board above to see its work."
        : "A manager needs to link your account to a board before your jobs appear here."}
    </Notice>
  );
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
