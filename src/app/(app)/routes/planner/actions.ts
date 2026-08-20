"use server";

import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, toObject } from "@/lib/actions";
import { UNASSIGNED, isMovable, isReceiving, parseDispatchPlan } from "./plan";

type Placement = { routeId: string | null; sequence: number };

export async function applyDispatchPlan(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");

  // The board arrives as one payload; the schema and this parse live in
  // `plan.ts` so the contract can be unit-tested. See the note there.
  const parsed = parseDispatchPlan(toObject(formData).plan);
  if (!parsed.ok) return fail("/routes/planner", parsed.problem);

  const { date, columns } = parsed.plan;
  const backTo = `/routes/planner?date=${date}`;
  const supabase = await createClient();

  /* --------------------------------------------------- what the board may touch */

  const { data: routes, error: routeError } = await supabase
    .from("daily_routes")
    .select("id, code, status, driver_id, vehicle_id")
    .eq("route_date", date).is("deleted_at", null)
    .returns<Array<{
      id: string; code: string; status: string;
      driver_id: string | null; vehicle_id: string | null;
    }>>();
  if (routeError) return fail(backTo, describeDbError(routeError));

  const routeById = new Map((routes ?? []).map((route) => [route.id, route]));

  const { data: jobs, error: jobError } = await supabase
    .from("jobs")
    .select("id, job_number, route_id, sequence, status, progress_status, driver_id, vehicle_id")
    .eq("scheduled_date", date).is("deleted_at", null)
    .returns<Array<{
      id: string; job_number: string; route_id: string | null; sequence: number;
      status: string; progress_status: string;
      driver_id: string | null; vehicle_id: string | null;
    }>>();
  if (jobError) return fail(backTo, describeDbError(jobError));

  const jobById = new Map((jobs ?? []).map((job) => [job.id, job]));

  /* --------------------------------------------------------------- validation */

  // Everything below re-checks on the server what the board already enforced in
  // the browser. The board is a convenience; this is the rule.

  const placements = new Map<string, Placement>();
  for (const column of columns) {
    const routeId = column.routeId === UNASSIGNED ? null : column.routeId;
    if (routeId && !routeById.has(routeId)) {
      return fail(backTo, "That plan refers to a run that is not on this date any more. Reload and try again.");
    }
    column.jobIds.forEach((jobId, index) => {
      if (placements.has(jobId)) return fail(backTo, "That plan lists the same stop twice.");
      placements.set(jobId, { routeId, sequence: index + 1 });
    });
  }

  for (const [jobId, placement] of placements) {
    const job = jobById.get(jobId);
    if (!job) {
      return fail(backTo, "That plan refers to a stop that is no longer scheduled for this date. Reload and try again.");
    }
    if (job.route_id === placement.routeId) continue;

    if (!isMovable(job)) {
      return fail(backTo, `${job.job_number} has already been started or finished and cannot be moved to another run.`);
    }
    // Both ends of the move have to be able to take the change: a closed run's
    // paperwork is done, and reopening it through the side door would let a
    // stop appear on a sheet the driver has already signed off.
    for (const id of [job.route_id, placement.routeId]) {
      const route = id ? routeById.get(id) : null;
      if (route && !isReceiving(route.status)) {
        return fail(backTo, `Run ${route.code} is ${route.status.replace(/_/g, " ")} and its stops can no longer be changed.`);
      }
    }
  }

  /* ------------------------------------------------------------------ crew */

  // Applied before the stops so each moved job inherits the crew the run is
  // about to have, not the one it is being replaced with.
  const crewByRoute = new Map<string, { driver_id: string | null; vehicle_id: string | null }>();
  let crewChanges = 0;

  for (const column of columns) {
    if (column.routeId === UNASSIGNED) continue;
    const route = routeById.get(column.routeId);
    if (!route) continue;

    const crew = {
      driver_id: column.driverId ? column.driverId : null,
      vehicle_id: column.vehicleId ? column.vehicleId : null,
    };
    crewByRoute.set(route.id, crew);
    if (crew.driver_id === route.driver_id && crew.vehicle_id === route.vehicle_id) continue;

    if (!isReceiving(route.status)) {
      return fail(backTo, `Run ${route.code} is ${route.status.replace(/_/g, " ")} and its crew can no longer be changed.`);
    }

    const { error } = await supabase
      .from("daily_routes").update(crew)
      .eq("id", route.id).eq("tenant_id", session.tenantId);
    if (error) return fail(backTo, describeDbError(error));
    crewChanges += 1;
  }

  /* ----------------------------------------------------------------- stops */

  let moved = 0;
  let resequenced = 0;

  for (const [jobId, placement] of placements) {
    const job = jobById.get(jobId)!;
    const crew = placement.routeId
      ? crewByRoute.get(placement.routeId) ?? {
          driver_id: routeById.get(placement.routeId)?.driver_id ?? null,
          vehicle_id: routeById.get(placement.routeId)?.vehicle_id ?? null,
        }
      : { driver_id: null, vehicle_id: null };

    const routeChanged = job.route_id !== placement.routeId;
    const crewChanged = isMovable(job)
      && (job.driver_id !== crew.driver_id || job.vehicle_id !== crew.vehicle_id);
    const sequenceChanged = job.sequence !== placement.sequence;

    if (!routeChanged && !crewChanged && !sequenceChanged) continue;

    // A stop the driver has already touched keeps its crew even if the run's
    // crew changed underneath it — the record has to say who actually did it.
    const update: Record<string, unknown> = { sequence: placement.sequence };
    if (routeChanged) update.route_id = placement.routeId;
    if (crewChanged) {
      update.driver_id = crew.driver_id;
      update.vehicle_id = crew.vehicle_id;
      // Only the two pre-execution states are derived from the assignment.
      // An exception stays an exception until somebody clears it.
      if (job.status === "scheduled" || job.status === "assigned") {
        update.status = crew.driver_id ? "assigned" : "scheduled";
      }
    }

    const { error } = await supabase
      .from("jobs").update(update)
      .eq("id", jobId).eq("tenant_id", session.tenantId);
    if (error) return fail(backTo, describeDbError(error));

    if (routeChanged) moved += 1;
    else resequenced += 1;
  }

  if (moved === 0 && resequenced === 0 && crewChanges === 0) {
    return done(backTo, "Nothing to apply — the plan matches what is already scheduled.");
  }

  await recordAudit(session, {
    // One row for the whole board rather than one per stop: the useful record of
    // a re-plan is the shape of the change, not thirty individual row updates.
    entity: "daily_route", action: "update",
    summary: `${moved} stop(s) moved, ${resequenced} resequenced, ${crewChanges} crew change(s) on ${date}`,
    metadata: { date, moved, resequenced, crewChanges },
  });

  revalidatePath("/routes/planner");
  revalidatePath("/routes/daily");

  const parts = [
    moved > 0 && `${moved} stop(s) moved`,
    resequenced > 0 && `${resequenced} resequenced`,
    crewChanges > 0 && `${crewChanges} crew change(s)`,
  ].filter(Boolean);
  return done(backTo, `Plan applied — ${parts.join(", ")}.`);
}
