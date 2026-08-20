import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { getAdelaideToday, formatAdelaideDate, isCalendarDate } from "@/lib/domain/timezone";
import { addDays } from "@/lib/domain/dates";
import { listActiveBoards, type RunBoard } from "@/lib/runs/my-runs";
import {
  Badge, ButtonLink, Card, EmptyState, Notice, PageHeader, Stat, cx,
} from "@/components/ui";
import { SequenceBoard, type SequenceStop } from "./sequence-board";
import { MoveToBoard } from "./move-to-board";

export const dynamic = "force-dynamic";

export const metadata = { title: "Runs" };

/**
 * Runs — a day, a board, and the order it drives in.
 *
 * **This is not the old run-management module.** Nobody creates a run, opens
 * one, or sees a run code: a job is given to a board and a date, and the
 * `daily_routes` row underneath is still found-or-created by the assignment
 * action. What this screen adds is the one decision the office was left unable
 * to make — *in what order?* — plus moving work between boards.
 *
 * Ordering is by **stop**, and each position lists the jobs at it. A stop is one
 * visit to one customer, so a customer with two jobs on the same day is one
 * position: the van goes there once, and ordering the two jobs apart would mean
 * driving to the same address twice.
 *
 * Gated on `routes.read` to look and `routes.write` to change, which is what
 * makes the client's rule true: a board sees the final sequence on My Runs and
 * cannot alter it, because the board role holds `routes.read` and not `write`.
 */

type Search = { date?: string; board?: string };

type StopRow = {
  id: string;
  sequence: number;
  status: string;
  progress_status: string;
  customers: { id: string; business_name: string } | null;
  customer_locations: {
    address_line1: string | null; suburb: string | null; state: string | null;
  } | null;
};

export default async function RunsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireCapability("routes.read");
  const params = await searchParams;
  const today = getAdelaideToday();
  const date = params.date && isCalendarDate(params.date) ? params.date : today;

  const supabase = await createClient();
  // Named rather than left to RLS (§23): every board id here is posted into a
  // write filtered to the laundry the person is working in.
  const boards = await listActiveBoards(supabase, session.tenantId);
  const board = boards.find((entry) => entry.id === params.board) ?? boards[0] ?? null;
  const canWrite = can(session.role, "routes.write");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Runs"
        description="What each board is delivering on a day, and the order it drives in."
      />

      <Card title="Day">
        <DayNav date={date} today={today} boardId={board?.id} />
      </Card>

      {boards.length === 0 ? (
        <EmptyState
          title="No boards yet"
          description="Work is assigned to a board — a standing delivery round with its own login. Create one per round to start planning a day."
          action={<ButtonLink href="/boards">Set up boards</ButtonLink>}
        />
      ) : (
        <>
          <BoardTabs boards={boards} current={board} date={date} />
          {board ? (
            <BoardDay
              tenantId={session.tenantId} board={board} date={date}
              boards={boards} canWrite={canWrite}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** Yesterday / today / tomorrow, as plain links so the page stays shareable. */
function DayNav({ date, today, boardId }: { date: string; today: string; boardId?: string }) {
  const href = (target: string) =>
    `/runs?date=${target}${boardId ? `&board=${boardId}` : ""}`;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex gap-2">
        <ButtonLink href={href(addDays(date, -1))} variant="secondary">Previous</ButtonLink>
        <ButtonLink href={href(today)} variant={date === today ? "primary" : "secondary"}>
          Today
        </ButtonLink>
        <ButtonLink href={href(addDays(date, 1))} variant="secondary">Next</ButtonLink>
      </div>
      <form method="get" action="/runs" className="flex items-end gap-2">
        {boardId ? <input type="hidden" name="board" value={boardId} /> : null}
        <div>
          <label htmlFor="runs-date" className="mb-1 block text-sm font-medium">Date</label>
          <input
            id="runs-date" name="date" type="date" defaultValue={date}
            className="min-h-11 rounded-lg border border-border bg-surface px-3"
          />
        </div>
        <button type="submit" className="sr-only">Show this day</button>
      </form>
      <p className="text-sm text-muted-foreground">{formatAdelaideDate(date, "long")}</p>
    </div>
  );
}

function BoardTabs({
  boards, current, date,
}: { boards: RunBoard[]; current: RunBoard | null; date: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Boards">
      {boards.map((board) => (
        <Link
          key={board.id}
          href={`/runs?date=${date}&board=${board.id}`}
          aria-current={board.id === current?.id ? "true" : undefined}
          className={cx(
            "inline-flex min-h-9 items-center rounded-lg border px-3 text-sm transition-colors",
            board.id === current?.id
              ? "border-action bg-action text-action-foreground"
              : "border-border bg-surface hover:border-strong",
          )}
        >
          {board.name}
        </Link>
      ))}
    </div>
  );
}

async function BoardDay({
  tenantId, board, date, boards, canWrite,
}: {
  tenantId: string; board: RunBoard; date: string; boards: RunBoard[]; canWrite: boolean;
}) {
  const supabase = await createClient();

  const { data: routes } = await supabase
    .from("daily_routes")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("board_id", board.id)
    .eq("route_date", date)
    .is("deleted_at", null)
    .not("status", "in", "(cancelled)")
    .returns<Array<{ id: string; status: string }>>();

  const routeIds = (routes ?? []).map((route) => route.id);

  const { data: stopRows } = routeIds.length
    ? await supabase
      .from("jobs")
      .select("id, sequence, status, progress_status, customers(id, business_name), " +
              "customer_locations(address_line1, suburb, state)")
      .eq("tenant_id", tenantId)
      .in("route_id", routeIds)
      .is("deleted_at", null)
      .order("sequence")
      .returns<StopRow[]>()
    : { data: [] as StopRow[] };

  const stops = stopRows ?? [];

  // One read for every stop's laundry rather than one per stop.
  const { data: jobRows } = stops.length
    ? await supabase
      .from("laundry_orders")
      .select("id, order_number, stop_id, laundry_order_items(id)")
      .eq("tenant_id", tenantId)
      .in("stop_id", stops.map((stop) => stop.id))
      .not("status", "in", "(cancelled)")
      .order("order_number")
      .returns<Array<{
        id: string; order_number: string; stop_id: string;
        laundry_order_items: Array<{ id: string }>;
      }>>()
    : { data: [] as Array<{ id: string; order_number: string; stop_id: string; laundry_order_items: Array<{ id: string }> }> };

  const jobsByStop = new Map<string, SequenceStop["jobs"]>();
  for (const job of jobRows ?? []) {
    const bucket = jobsByStop.get(job.stop_id) ?? [];
    bucket.push({
      id: job.id,
      orderNumber: job.order_number,
      itemCount: job.laundry_order_items?.length ?? 0,
    });
    jobsByStop.set(job.stop_id, bucket);
  }

  const sequenceStops: SequenceStop[] = stops.map((stop) => ({
    id: stop.id,
    status: stop.status,
    progressStatus: stop.progress_status,
    customerName: stop.customers?.business_name ?? "Unknown customer",
    address: [
      stop.customer_locations?.address_line1,
      stop.customer_locations?.suburb,
      stop.customer_locations?.state,
    ].filter(Boolean).join(", ") || null,
    jobs: jobsByStop.get(stop.id) ?? [],
  }));

  const jobCount = (jobRows ?? []).length;
  const worked = sequenceStops.filter((stop) => stop.progressStatus !== "not_started").length;

  if (sequenceStops.length === 0) {
    return (
      <Card title={board.name}>
        <EmptyState
          title={`Nothing on ${board.name} for ${formatAdelaideDate(date, "medium")}`}
          description="Assign jobs to this board from the Jobs screen, and they appear here in the order they were added."
          action={<ButtonLink href="/orders?assigned=unassigned" variant="secondary">Jobs to assign</ButtonLink>}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Stops" value={String(sequenceStops.length)} hint="Visits on this run" />
        <Stat label="Jobs" value={String(jobCount)} hint="Laundry to hand over" />
        <Stat label="Already worked" value={String(worked)}
              hint={worked > 0 ? "These cannot be moved" : "The whole run can be reordered"} />
      </div>

      {worked > 0 ? (
        <Notice tone="info" title="Part of this run has already been driven">
          A stop the round has arrived at, delivered or cancelled stays where it is —
          moving it would rewrite where work that has already happened happened.
        </Notice>
      ) : null}

      <Card
        title={`${board.name} — ${formatAdelaideDate(date, "medium")}`}
        description={canWrite
          ? "Drag a stop, or use the arrows. Nothing is saved until you press Save order."
          : "The order this board drives in. Only an owner or manager can change it."}
        actions={<Badge tone="neutral">{sequenceStops.length} stops</Badge>}
      >
        <SequenceBoard
          boardId={board.id} boardName={board.name} date={date}
          stops={sequenceStops} canWrite={canWrite}
        />
      </Card>

      {canWrite && boards.length > 1 ? (
        <MoveToBoard
          date={date} fromBoard={board} boards={boards}
          jobs={sequenceStops.flatMap((stop) =>
            stop.jobs.map((job) => ({ ...job, customerName: stop.customerName })))}
        />
      ) : null}
    </div>
  );
}
