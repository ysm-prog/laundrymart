"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { isoWeekday } from "@/lib/domain/dates";
import {
  describeDbError, done, fail, firstIssue, optionalText, optionalUuid, requiredDate, toObject,
} from "@/lib/actions";

/**
 * Instantiate daily routes for a date from every active template that runs on
 * that weekday, creating one job per template stop.
 *
 * Re-running for the same date is safe: templates that already have a route for
 * the date are skipped rather than duplicated.
 */
export async function generateDailyRoutes(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = z.object({ route_date: requiredDate }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/routes/daily", firstIssue(parsed.error));

  const routeDate = parsed.data.route_date;
  const backTo = `/routes/daily?date=${routeDate}`;
  const weekday = isoWeekday(routeDate);

  const supabase = await createClient();

  const { data: templates, error: templateError } = await supabase
    .from("route_templates")
    .select("id, code, name, depot_id, default_driver_id, default_vehicle_id, weekdays")
    .eq("status", "active").is("deleted_at", null);
  if (templateError) return fail(backTo, describeDbError(templateError));

  const due = (templates ?? []).filter((template) =>
    Array.isArray(template.weekdays) && template.weekdays.includes(weekday));

  if (due.length === 0) {
    return fail(backTo, "No active template runs on that weekday.");
  }

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
    if (routeError) return fail(backTo, describeDbError(routeError));
    routesCreated += 1;

    const { data: stops } = await supabase
      .from("route_template_stops")
      .select("customer_id, location_id, sequence, service_type, notes")
      .eq("template_id", template.id).order("sequence");

    for (const stop of stops ?? []) {
      const { data: jobNumber, error: numberError } = await supabase
        .rpc("next_number", { t: session.tenantId, k: "job", p: "JOB" });
      if (numberError) return fail(backTo, describeDbError(numberError));

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
      if (jobError) return fail(backTo, describeDbError(jobError));
      jobsCreated += 1;
    }
  }

  if (routesCreated === 0) {
    return fail(backTo, "Every template for that weekday already has a route on that date.");
  }

  await recordAudit(session, {
    entity: "daily_route", action: "generate",
    summary: `${routesCreated} routes and ${jobsCreated} jobs for ${routeDate}`,
    metadata: { routeDate, routesCreated, jobsCreated },
  });
  revalidatePath("/routes/daily");
  return done(backTo, `Generated ${routesCreated} route(s) and ${jobsCreated} job(s).`);
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

export async function setRouteStatus(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = z.object({
    id: z.string().uuid(),
    status: z.enum([
      "planned", "inspection_pending", "inspection_complete", "load_confirmed",
      "in_progress", "returning", "unloading", "closed", "cancelled",
    ]),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/routes/daily", firstIssue(parsed.error));

  const backTo = `/routes/daily/${parsed.data.id}`;
  const supabase = await createClient();

  // The database enforces the ordering rules; we just surface its message.
  const { error } = await supabase
    .from("daily_routes").update({ status: parsed.data.status })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "daily_route", entityId: parsed.data.id, action: "status_change",
    summary: parsed.data.status,
  });
  revalidatePath(backTo);
  return done(backTo, `Route marked ${parsed.data.status.replace(/_/g, " ")}.`);
}
