import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { isoWeekday } from "@/lib/domain/dates";
import {
  collectionDueState, collectionsToRaise, type CollectionDueState,
} from "@/lib/domain/collections";
import { resolveRun, findOrCreateCollectionStop } from "./assign";

/**
 * The standing weekly collection, read for a day and turned into stops.
 *
 * The office answers one question here — *who should we be collecting from
 * today, and is anyone missing off a van?* — and presses one button. Everything
 * that decides is in `lib/domain/collections.ts`; this module is the reads and
 * the write, which is the half no unit test can reach.
 *
 * **Why a stop and not a laundry order.** The owner's choice, and the database
 * agrees with it: a laundry order that has not been taken in yet has no items,
 * and `chk_laundry_orders_assignment_delivery` refuses an assignee on a job that
 * is not a delivery — so a pre-created collection job would sit on no round and
 * appear on nobody's screen. A `jobs` row with `service_type = 'pickup'` is the
 * shape the app already has for this: `/run` offers the collection capture for
 * it, works with no signal, and the counter raises the laundry job from what
 * actually came back. What is collected is still what is billed.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type DueCollection = {
  customerId: string;
  customerNumber: string;
  businessName: string;
  status: string | null;
  boardId: string | null;
  boardName: string | null;
  /** The stop already on that board's run for this day, if there is one. */
  stopId: string | null;
  stopNumber: string | null;
  state: CollectionDueState;
};

/**
 * Everyone whose standing collection falls on `date`, and what stands in the way.
 *
 * **The tenant is named rather than left to RLS** (§23): every customer id here
 * is posted straight back into a write, and `is_member()` is true of every
 * laundry for a platform admin — so an unfiltered read would offer one business's
 * customers to a press scoped to another's.
 */
export async function dueCollections(
  supabase: Supabase, tenantId: string, date: string,
): Promise<DueCollection[]> {
  const weekday = isoWeekday(date);

  const { data: customers } = await supabase
    .from("customers")
    .select("id, customer_number, business_name, status, collection_board_id, boards(name)")
    .eq("tenant_id", tenantId)
    .eq("collection_weekday", weekday)
    .is("deleted_at", null)
    .order("business_name")
    .returns<Array<{
      id: string; customer_number: string; business_name: string; status: string | null;
      collection_board_id: string | null; boards: { name: string } | null;
    }>>();

  const rows = customers ?? [];
  if (rows.length === 0) return [];

  // One read for every stop on this date, rather than one per customer: the
  // question is "does this run already call there?", and the answer for all of
  // them is a single filtered select. A cancelled stop does not count — it is a
  // call the office deliberately took off the van.
  const { data: stops } = await supabase
    .from("jobs")
    .select("id, job_number, customer_id, daily_routes!inner(board_id)")
    .eq("tenant_id", tenantId)
    .eq("scheduled_date", date)
    .in("customer_id", rows.map((row) => row.id))
    .is("deleted_at", null)
    .neq("status", "cancelled")
    .returns<Array<{
      id: string; job_number: string; customer_id: string;
      daily_routes: { board_id: string | null } | null;
    }>>();

  // Keyed on customer *and* board: a customer already being delivered to by
  // Board 2 that day is not evidence that Board 1's collection is booked.
  const byCustomerAndBoard = new Map<string, { id: string; job_number: string }>();
  for (const stop of stops ?? []) {
    const key = `${stop.customer_id}:${stop.daily_routes?.board_id ?? ""}`;
    if (!byCustomerAndBoard.has(key)) {
      byCustomerAndBoard.set(key, { id: stop.id, job_number: stop.job_number });
    }
  }

  return rows.map((row) => {
    const stop = row.collection_board_id
      ? byCustomerAndBoard.get(`${row.id}:${row.collection_board_id}`) ?? null
      : null;
    return {
      customerId: row.id,
      customerNumber: row.customer_number,
      businessName: row.business_name,
      status: row.status,
      boardId: row.collection_board_id,
      boardName: row.boards?.name ?? null,
      stopId: stop?.id ?? null,
      stopNumber: stop?.job_number ?? null,
      state: collectionDueState({
        status: row.status, boardId: row.collection_board_id, hasStop: !!stop,
      }),
    };
  });
}

export type RaiseOutcome = {
  created: number;
  /** Named rather than counted: an operator who sees "3 of 5" asks which two. */
  failures: Array<{ businessName: string; reason: string }>;
};

/**
 * Put every customer whose collection is due on `date` onto their round.
 *
 * **Idempotent by construction, not by a flag.** `findOrCreateCollectionStop`
 * keys on (tenant, run, customer), so a second press finds the stop the first
 * one made — and `dueCollections` reports those as already on the run, so the
 * button says how many are left rather than offering to do it again.
 *
 * A customer who cannot be raised is *skipped and named*, never silently
 * dropped: this is the same call `describeUnpriced` makes about laundry with no
 * rate, and for the same reason — a partial batch reported as a success is how
 * the missing half is never found.
 */
export async function raiseCollectionStops(
  supabase: Supabase, session: Session, date: string,
): Promise<RaiseOutcome | { error: string }> {
  const due = await dueCollections(supabase, session.tenantId, date);
  const ready = collectionsToRaise(
    due.map((entry) => ({ ...entry, hasStop: !!entry.stopId })),
  );
  if (ready.length === 0) return { created: 0, failures: [] };

  const failures: RaiseOutcome["failures"] = [];
  let created = 0;

  // Runs are resolved once per board rather than once per customer: twenty
  // customers on one round is one run, and asking for it twenty times is twenty
  // chances to open a second one.
  const runs = new Map<string, Awaited<ReturnType<typeof resolveRun>>>();

  for (const entry of ready) {
    const boardId = entry.boardId as string;
    if (!runs.has(boardId)) {
      runs.set(boardId, await resolveRun(supabase, session, { boardId, runDate: date }));
    }
    const run = runs.get(boardId)!;
    if ("error" in run) {
      failures.push({ businessName: entry.businessName, reason: run.error });
      continue;
    }

    const stop = await findOrCreateCollectionStop(supabase, session, {
      run, customerId: entry.customerId,
    });
    if ("error" in stop) {
      failures.push({ businessName: entry.businessName, reason: stop.error });
      continue;
    }
    created += 1;
  }

  return { created, failures };
}
