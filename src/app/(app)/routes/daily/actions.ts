"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { isoWeekday } from "@/lib/domain/dates";
import { today } from "@/lib/format";
import { sweepVehicleToDepot } from "@/lib/routes/unload";
import {
  describeDbError, done, fail, firstIssue, optionalText, optionalUuid, requiredDate, toObject,
} from "@/lib/actions";

/**
 * Instantiate daily routes for a date from every active template that runs on
 * that weekday, one job per template stop, crew pre-filled from the template's
 * defaults. Shared by the routes screen's explicit generate and the dashboard's
 * one-click "Plan my day".
 *
 * Re-running for the same date is safe: templates that already have a route for
 * the date are skipped rather than duplicated.
 */
async function instantiateRoutes(
  session: Session, routeDate: string,
): Promise<{ due: number; routesCreated: number; jobsCreated: number } | { error: string }> {
  const weekday = isoWeekday(routeDate);
  const supabase = await createClient();

  const { data: templates, error: templateError } = await supabase
    .from("route_templates")
    .select("id, code, name, depot_id, default_driver_id, default_vehicle_id, weekdays")
    .eq("status", "active").is("deleted_at", null);
  if (templateError) return { error: describeDbError(templateError) };

  const due = (templates ?? []).filter((template) =>
    Array.isArray(template.weekdays) && template.weekdays.includes(weekday));
  if (due.length === 0) return { due: 0, routesCreated: 0, jobsCreated: 0 };

  const { data: existing } = await supabase
    .from("daily_routes").select("template_id").eq("route_date", routeDate);
  const alreadyGenerated = new Set((existing ?? []).map((row) => row.template_id));

  let routesCreated = 0;
  let jobsCreated = 0;

  for (const template of due) {
    if (alreadyGenerated.has(template.id)) continue;

    const { data: route, error: routeError } = await supabase
      .from("daily_routes")
      .insert({
        tenant_id: session.tenantId,
        created_by: session.userId,
        template_id: template.id,
        depot_id: template.depot_id,
        route_date: routeDate,
        code: template.code,
        name: template.name,
        driver_id: template.default_driver_id,
        vehicle_id: template.default_vehicle_id,
        status: "planned",
      })
      .select("id")
      .single();
    if (routeError) return { error: describeDbError(routeError) };
    routesCreated += 1;

    const { data: stops } = await supabase
      .from("route_template_stops")
      .select("customer_id, location_id, sequence, service_type, notes")
      .eq("template_id", template.id).order("sequence");

    for (const stop of stops ?? []) {
      const { data: jobNumber, error: numberError } = await supabase
        .rpc("next_number", { t: session.tenantId, k: "job", p: "JOB" });
      if (numberError) return { error: describeDbError(numberError) };

      // A stop's agreement supplies pricing later; link it now while we know it.
      const { data: agreement } = await supabase
        .from("service_agreements")
        .select("id").eq("customer_id", stop.customer_id).eq("status", "active")
        .lte("start_date", routeDate)
        .order("version", { ascending: false }).limit(1).maybeSingle();

      const { error: jobError } = await supabase.from("jobs").insert({
        tenant_id: session.tenantId,
        created_by: session.userId,
        route_id: route.id,
        depot_id: template.depot_id,
        customer_id: stop.customer_id,
        location_id: stop.location_id,
        agreement_id: agreement?.id ?? null,
        driver_id: template.default_driver_id,
        vehicle_id: template.default_vehicle_id,
        job_number: jobNumber as string,
        scheduled_date: routeDate,
        sequence: stop.sequence,
        service_type: stop.service_type,
        status: template.default_driver_id ? "assigned" : "scheduled",
        notes: stop.notes,
      });
      if (jobError) return { error: describeDbError(jobError) };
      jobsCreated += 1;
    }
  }

  if (routesCreated > 0) {
    await recordAudit(session, {
      entity: "daily_route", action: "generate",
      summary: `${routesCreated} routes and ${jobsCreated} jobs for ${routeDate}`,
      metadata: { routeDate, routesCreated, jobsCreated },
    });
    revalidatePath("/routes/daily");
  }
  return { due: due.length, routesCreated, jobsCreated };
}

export async function generateDailyRoutes(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = z.object({ route_date: requiredDate }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/routes/daily", firstIssue(parsed.error));

  const routeDate = parsed.data.route_date;
  const backTo = `/routes/daily?date=${routeDate}`;

  const result = await instantiateRoutes(session, routeDate);
  if ("error" in result) return fail(backTo, result.error);

  if (result.due === 0) {
    return fail(backTo, "No active template runs on that weekday.",
      { href: "/routes/templates", label: "Set up a weekly run" });
  }
  if (result.routesCreated === 0) {
    return fail(backTo, "Every template for that weekday already has a route on that date.");
  }
  return done(backTo, `Generated ${result.routesCreated} route(s) and ${result.jobsCreated} job(s).`);
}

/**
 * The dashboard's one-click "Plan my day" (design spec B3): generate today's
 * routes from the weekly templates with the usual crews pre-assigned, then land
 * on the planner only when a human choice actually remains — a run without a
 * driver or vehicle, or a stop on no run. When nothing needs a decision, the
 * day is simply planned and says so.
 */
export async function planToday(): Promise<void> {
  const session = await assertCapability("routes.write");
  const routeDate = today();

  const result = await instantiateRoutes(session, routeDate);
  if ("error" in result) return fail("/dashboard", result.error);

  if (result.due === 0) {
    return fail("/dashboard",
      "No weekly run is set up for today, so there is nothing to plan from.",
      { href: "/routes/templates", label: "Set up a weekly run" });
  }

  // What still needs a person: crewless runs and stops on no run.
  const supabase = await createClient();
  const [{ data: routes }, { count: orphanStops }] = await Promise.all([
    supabase.from("daily_routes")
      .select("id, driver_id, vehicle_id")
      .eq("route_date", routeDate).is("deleted_at", null)
      .not("status", "in", "(cancelled)")
      .returns<Array<{ id: string; driver_id: string | null; vehicle_id: string | null }>>(),
    supabase.from("jobs").select("id", { count: "exact", head: true })
      .eq("scheduled_date", routeDate).is("route_id", null).is("deleted_at", null),
  ]);

  const crewless = (routes ?? []).filter((route) => !route.driver_id || !route.vehicle_id).length;
  const unassigned = orphanStops ?? 0;

  const generated = result.routesCreated > 0
    ? `Generated ${result.routesCreated} run(s) and ${result.jobsCreated} stop(s) for today.`
    : "Today's runs were already generated.";

  if (crewless > 0 || unassigned > 0) {
    const choices = [
      crewless > 0 && `${crewless} run(s) still need a driver or vehicle`,
      unassigned > 0 && `${unassigned} stop(s) are on no run`,
    ].filter(Boolean).join(" and ");
    return done(`/routes/planner?date=${routeDate}`, `${generated} ${choices} — that part needs you.`);
  }

  return done(`/routes/daily?date=${routeDate}`,
    `${generated} Every run has its usual driver and vehicle — nothing needs a decision.`);
}

export async function assignRoute(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = z.object({
    id: z.string().uuid(),
    driver_id: optionalUuid,
    vehicle_id: optionalUuid,
    trailer_id: optionalUuid,
    notes: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/routes/daily", firstIssue(parsed.error));

  const backTo = `/routes/daily/${parsed.data.id}`;
  const { id, ...assignment } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase
    .from("daily_routes").update(assignment)
    .eq("id", id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  // Keep the route's jobs in step so drivers see their work on their device.
  if (assignment.driver_id || assignment.vehicle_id) {
    const { error: jobError } = await supabase
      .from("jobs")
      .update({
        driver_id: assignment.driver_id ?? null,
        vehicle_id: assignment.vehicle_id ?? null,
        status: assignment.driver_id ? "assigned" : "scheduled",
      })
      .eq("route_id", id).eq("tenant_id", session.tenantId)
      .in("status", ["scheduled", "assigned"]);
    if (jobError) return fail(backTo, describeDbError(jobError));
  }

  await recordAudit(session, { entity: "daily_route", entityId: id, action: "update", summary: "assignment" });
  revalidatePath(backTo);
  return done(backTo, "Route assignment saved.");
}

/**
 * Move a run to another workflow state from the office.
 *
 * Gated on `routes.status` rather than `routes.write`: advancing a run that is
 * already out on the road is a floor decision, and restricting it to the roles
 * that also plan and assign left runs stranded whenever the driver could not
 * drive their own workflow (see ROUTE_TRANSITIONS on the detail page).
 *
 * The state machine's ordering rules live in the database. What this action
 * adds is the bookkeeping each state implies — the timestamps the driver's own
 * /run flow would have stamped — because a state reached without them is a run
 * the guard will refuse to move again later.
 */
export async function setRouteStatus(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.status");
  const parsed = z.object({
    id: z.string().uuid(),
    status: z.enum([
      "planned", "inspection_pending", "inspection_complete", "load_confirmed",
      "in_progress", "returning", "unloading", "closed", "cancelled",
    ]),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/routes/daily", firstIssue(parsed.error));

  const { id, status } = parsed.data;
  const backTo = `/routes/daily/${id}`;
  const supabase = await createClient();

  const { data: route } = await supabase
    .from("daily_routes")
    .select("id, status, load_confirmed_at, returned_at, unloaded_at")
    .eq("id", id).eq("tenant_id", session.tenantId)
    .maybeSingle();
  if (!route) return fail(backTo, "That run could not be found.");
  if (route.status === status) return fail(backTo, `This run is already ${humanStatus(status)}.`);

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status };

  // Only stamp what is still unset — re-entering a state must not rewrite the
  // time it first happened.
  if (status === "load_confirmed" && !route.load_confirmed_at) {
    patch.load_confirmed_at = now;
    patch.load_confirmed_by = session.userId;
  }
  if (status === "returning" && !route.returned_at) patch.returned_at = now;
  if (status === "unloading" && !route.unloaded_at) {
    // Same sweep the driver's own unload performs, so stock does not stay
    // stranded in `in_transit` on a vehicle that is back at the depot.
    const sweepError = await sweepVehicleToDepot(session.tenantId, id);
    if (sweepError) return fail(backTo, sweepError);
    patch.unloaded_at = now;
  }

  // The database enforces the ordering rules; we just surface its message.
  const { error } = await supabase
    .from("daily_routes").update(patch)
    .eq("id", id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "daily_route", entityId: id, action: "status_change", summary: status,
  });
  revalidatePath(backTo);
  return done(backTo, `Route marked ${humanStatus(status)}.`);
}

function humanStatus(status: string): string {
  return status.replace(/_/g, " ");
}
