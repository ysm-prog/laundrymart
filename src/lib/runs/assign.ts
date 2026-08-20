import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { describeDbError } from "@/lib/actions";
import { recordAudit } from "@/lib/audit";
import { getAdelaideNow } from "@/lib/domain/timezone";

/**
 * Putting one job on one board's day — the write itself, shared.
 *
 * Two screens perform this: the job page's Assign / Reassign, and the Runs
 * screen's bulk **Move to board**. They must mean exactly the same thing, for
 * the reason `lib/orders/complete.ts` and `lib/routes/unload.ts` exist — when
 * "assign" has two implementations, the screens eventually disagree and a job
 * ends up on somebody's route sheet and nobody's phone.
 *
 * What lives here is the bookkeeping **no user ever sees**: finding or opening
 * the board's run for the day, finding or adding the stop for that customer, the
 * guarded update, and retiring a stop the job has just emptied. What stays in
 * the actions is everything a person is told — eligibility sentences, the flash
 * message, the audit summary — because those differ between one job and forty.
 *
 * It is a plain module rather than part of a `"use server"` file so both callers
 * can import it and a test can reach it.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * The caller. The full session rather than a narrowed shape, because opening a
 * run writes an audit row and `recordAudit` reads the whole of it — and both
 * call sites hold one anyway.
 */
export type AssigningSession = Session;


export type AssignOutcome =
  | { ok: true; runId: string; stopId: string; previousStopId: string | null; reassigned: boolean }
  | { ok: false; error: string };

/**
 * Move a job onto a board for a date.
 *
 * The caller has already decided the job is eligible and the board is real; this
 * performs the change and reports what it did.
 *
 * **The conditional filter is the race guard.** Two people pressing Assign on
 * the same job at the same moment cannot both win, because the second one's
 * UPDATE matches no row and comes back empty — which is a different outcome from
 * an error and gets its own sentence at the call site.
 */
export async function assignOneJobToBoard(
  supabase: Supabase,
  session: AssigningSession,
  input: {
    orderId: string;
    boardId: string;
    deliveryDate: string;
    /** The job's current state, if the caller has already read it. */
    current?: {
      status: string;
      assigned_board_id: string | null;
      stop_id: string | null;
      customer_id: string;
    };
  },
): Promise<AssignOutcome> {
  let current = input.current;
  if (!current) {
    const { data } = await supabase
      .from("laundry_orders")
      .select("status, assigned_board_id, stop_id, customer_id")
      .eq("tenant_id", session.tenantId)
      .eq("id", input.orderId)
      .maybeSingle<{
        status: string; assigned_board_id: string | null;
        stop_id: string | null; customer_id: string;
      }>();
    if (!data) return { ok: false, error: "that job is not in this laundry" };
    current = data;
  }

  const reassigned = !!current.assigned_board_id;

  const run = await resolveRun(supabase, session, {
    boardId: input.boardId, runDate: input.deliveryDate,
  });
  if ("error" in run) return { ok: false, error: run.error };

  const stop = await findOrCreateStop(supabase, session, {
    run, customerId: current.customer_id,
  });
  if ("error" in stop) return { ok: false, error: stop.error };

  const base = supabase
    .from("laundry_orders")
    .update({
      assigned_board_id: input.boardId,
      assigned_delivery_date: input.deliveryDate,
      assigned_at: getAdelaideNow().toISOString(),
      assigned_by: session.userId,
      stop_id: stop.id,
      // A job that changes hands has not been loaded onto the new van.
      load_confirmed_at: null,
      load_confirmed_by: null,
      // Only a fresh assignment moves the status; a reassignment of a job that
      // is already out keeps it out.
      ...(current.status === "ready_for_delivery" ? { status: "assigned" as const } : {}),
    })
    .eq("id", input.orderId)
    .eq("tenant_id", session.tenantId);

  const { data: updated, error } = await (
    reassigned
      ? base.eq("assigned_board_id", current.assigned_board_id as string)
      : base.is("assigned_board_id", null)
  ).select("id");
  if (error) return { ok: false, error: describeDbError(error) };
  if (!updated?.length) {
    return {
      ok: false,
      error: "somebody else changed this job's board a moment ago",
    };
  }

  const previousStopId = current.stop_id;
  if (previousStopId && previousStopId !== stop.id) {
    await retireStopIfEmpty(supabase, session, previousStopId);
  }

  return { ok: true, runId: run.id, stopId: stop.id, previousStopId, reassigned };
}

type ResolvedRun = {
  id: string; code: string; route_date: string; depot_id: string | null;
  board_id: string | null; vehicle_id: string | null;
};

/**
 * The internal run for a board on a date — reused if one is open, opened if not.
 *
 * **Nobody is ever asked about this.** The run used to be a choice put to the
 * dispatcher when a round had more than one open on a day; under the simplified
 * model there is no run in the user's vocabulary to choose between, so the
 * earliest open one wins deterministically. A round working a morning and an
 * afternoon van still has both runs — the day's work simply gathers on the first
 * of them, which is the same answer the old screen defaulted to when there was
 * only one.
 */
async function resolveRun(
  supabase: Supabase, session: AssigningSession,
  { boardId, runDate }: { boardId: string; runDate: string },
): Promise<ResolvedRun | { error: string }> {
  const { data: open } = await supabase
    .from("daily_routes")
    .select("id, code, route_date, depot_id, board_id, vehicle_id")
    .eq("tenant_id", session.tenantId)
    .eq("board_id", boardId).eq("route_date", runDate)
    .is("deleted_at", null)
    .not("status", "in", "(closed,cancelled)")
    .order("code")
    .limit(1)
    .returns<ResolvedRun[]>();

  if (open?.length) return open[0]!;
  return createRun(supabase, session, boardId, runDate);
}

async function createRun(
  supabase: Supabase, session: AssigningSession, boardId: string, runDate: string,
): Promise<ResolvedRun | { error: string }> {
  // Numbered by the same atomic sequence every other number in this app uses,
  // so two people assigning at the same moment cannot collide on
  // `uq_daily_routes_day`. The code is internal — it is never shown.
  const { data: code, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "run", p: "RUN" });
  if (numberError) return { error: describeDbError(numberError) };

  const { data: board } = await supabase
    .from("boards").select("depot_id, default_vehicle_id")
    .eq("tenant_id", session.tenantId).eq("id", boardId)
    .maybeSingle<{ depot_id: string | null; default_vehicle_id: string | null }>();

  const { data: run, error } = await supabase
    .from("daily_routes")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      route_date: runDate,
      code: code as string,
      name: "Deliveries",
      board_id: boardId,
      // The round's usual van, as a default. The run still carries whatever was
      // actually driven, and nothing here books a vehicle.
      vehicle_id: board?.default_vehicle_id ?? null,
      depot_id: board?.depot_id ?? session.depotId,
      status: "planned",
    })
    .select("id, code, route_date, depot_id, board_id, vehicle_id")
    .single<ResolvedRun>();
  if (error) return { error: describeDbError(error) };

  await recordAudit(session, {
    entity: "daily_route", entityId: run.id, action: "create",
    summary: `${run.code} for ${runDate} (created automatically on assignment)`,
  });
  return run;
}

/**
 * The stop this customer is visited at on this run — reused if the run already
 * calls there, added at the end of the route if it does not.
 *
 * Several jobs for one business gather under one visit rather than producing a
 * duplicate call each. The lookup is by customer, because a stop is a visit to a
 * business and the round knocks once.
 */
async function findOrCreateStop(
  supabase: Supabase, session: AssigningSession,
  { run, customerId }: { run: ResolvedRun; customerId: string },
): Promise<{ id: string; job_number: string } | { error: string }> {
  const { data: existing } = await supabase
    .from("jobs")
    .select("id, job_number")
    .eq("tenant_id", session.tenantId)
    .eq("route_id", run.id).eq("customer_id", customerId)
    .is("deleted_at", null)
    .not("status", "in", "(cancelled)")
    .order("sequence")
    .limit(1)
    .returns<Array<{ id: string; job_number: string }>>();

  if (existing?.length) return existing[0]!;

  const { data: number, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "job", p: "JOB" });
  if (numberError) return { error: describeDbError(numberError) };

  // Where the run currently ends. A new call goes on the end rather than being
  // slotted into the middle.
  const { data: last } = await supabase
    .from("jobs").select("sequence")
    .eq("tenant_id", session.tenantId)
    .eq("route_id", run.id).is("deleted_at", null)
    .order("sequence", { ascending: false }).limit(1)
    .maybeSingle<{ sequence: number }>();

  const { data: location } = await supabase
    .from("customer_locations")
    .select("id")
    .eq("tenant_id", session.tenantId)
    .eq("customer_id", customerId).eq("is_delivery", true)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();

  const { data: stop, error } = await supabase
    .from("jobs")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      route_id: run.id,
      depot_id: run.depot_id,
      customer_id: customerId,
      location_id: location?.id ?? null,
      vehicle_id: run.vehicle_id,
      job_number: number as string,
      scheduled_date: run.route_date,
      sequence: (last?.sequence ?? 0) + 1,
      service_type: "delivery",
      status: run.board_id ? "assigned" : "scheduled",
    })
    .select("id, job_number")
    .single<{ id: string; job_number: string }>();
  if (error) return { error: describeDbError(error) };

  return stop;
}

/**
 * Soft-delete a stop a job has just left, but only if it is demonstrably empty.
 *
 * "Empty" is strict on purpose: no other laundry order points at it, the round
 * has not started it, and no paperwork has been recorded against it. Anything
 * else is a real visit with a real history, and it stays. A failure here is
 * cosmetic — a stale empty stop is untidy, a lost one is not recoverable — so it
 * is logged rather than surfaced.
 */
export async function retireStopIfEmpty(
  supabase: Supabase, session: AssigningSession, stopId: string,
): Promise<void> {
  const { count: remaining } = await supabase
    .from("laundry_orders")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenantId)
    .eq("stop_id", stopId);
  if ((remaining ?? 0) > 0) return;

  const { data: stop } = await supabase
    .from("jobs")
    .select("id, status, progress_status, arrived_at, completed_at, service_type")
    .eq("tenant_id", session.tenantId)
    .eq("id", stopId).is("deleted_at", null)
    .maybeSingle<{
      id: string; status: string; progress_status: string;
      arrived_at: string | null; completed_at: string | null; service_type: string;
    }>();
  if (!stop) return;
  // Only the stops this feature creates, and only untouched ones.
  if (stop.service_type !== "delivery") return;
  if (stop.progress_status !== "not_started") return;
  if (stop.arrived_at || stop.completed_at) return;
  if (!["scheduled", "assigned"].includes(stop.status)) return;

  const { count: paperwork } = await supabase
    .from("deliveries")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenantId)
    .eq("job_id", stopId);
  if ((paperwork ?? 0) > 0) return;

  const { error } = await supabase
    .from("jobs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", stopId).eq("tenant_id", session.tenantId);
  if (error) console.error("retiring an emptied stop failed", { stopId, error: error.message });
}

