"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  describeDbError, done, fail, firstIssue, mediaPaths, optionalText, toObject,
} from "@/lib/actions";
import { isTenantPath } from "@/lib/media";
import { sweepVehicleToDepot } from "@/lib/routes/unload";
import { CHECKLIST_KEYS } from "./checklist";

const BACK = "/run";

async function currentDriver(session: Session) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("drivers").select("id, full_name").eq("user_id", session.userId).maybeSingle();
  return data;
}

const inspectionSchema = z.object({
  route_id: z.string().uuid(),
  vehicle_id: z.string().uuid("This route has no vehicle assigned yet"),
  odometer_km: z.preprocess(
    (v) => (v === "" || v == null ? undefined : Number(v)),
    z.number().int().min(0).optional(),
  ),
  result: z.enum(["pass", "pass_with_defects", "fail"]),
  defects: optionalText,
  photo_paths: mediaPaths,
});

export async function submitInspection(formData: FormData): Promise<void> {
  const session = await assertCapability("run.execute");
  const parsed = inspectionSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const driver = await currentDriver(session);
  if (!driver) return fail(BACK, "Your login is not linked to a driver record.");

  const checklist = Object.fromEntries(
    CHECKLIST_KEYS.map((key) => [key, formData.get(`check_${key}`) === "on"]),
  );

  const supabase = await createClient();
  const { data: inspection, error } = await supabase
    .from("vehicle_inspections")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      vehicle_id: parsed.data.vehicle_id,
      route_id: parsed.data.route_id,
      driver_id: driver.id,
      odometer_km: parsed.data.odometer_km ?? null,
      result: parsed.data.result,
      defects: parsed.data.defects ?? null,
      checklist,
      // Storage enforced the boundary on upload; this keeps another tenant's
      // key from being recorded against our inspection.
      photo_urls: parsed.data.photo_paths.filter((path) => isTenantPath(path, session.tenantId)),
    })
    .select("id")
    .single();

  if (error) return fail(BACK, describeDbError(error));

  if (parsed.data.result === "fail") {
    // A failed inspection takes the vehicle off the road rather than silently
    // letting the run continue.
    await supabase.from("vehicles")
      .update({ maintenance_status: "out_of_service" })
      .eq("id", parsed.data.vehicle_id).eq("tenant_id", session.tenantId);

    await recordAudit(session, {
      entity: "vehicle_inspection", entityId: inspection.id, action: "create",
      summary: "inspection failed — vehicle taken out of service",
    });
    revalidatePath(BACK);
    return fail(BACK, "Inspection failed. The vehicle is out of service — contact your dispatcher.");
  }

  // The inspection no longer gates the start (migration 0012), so it can now
  // legitimately arrive on a run that is already moving. Recording it must not
  // then walk the status backwards.
  const { data: route } = await supabase
    .from("daily_routes").select("status")
    .eq("id", parsed.data.route_id).eq("tenant_id", session.tenantId).maybeSingle();

  const { error: routeError } = await supabase
    .from("daily_routes")
    .update({
      inspection_id: inspection.id,
      odometer_start_km: parsed.data.odometer_km ?? null,
      ...(["planned", "inspection_pending"].includes(route?.status ?? "")
        ? { status: "inspection_complete" }
        : {}),
    })
    .eq("id", parsed.data.route_id).eq("tenant_id", session.tenantId);
  if (routeError) return fail(BACK, describeDbError(routeError));

  await recordAudit(session, {
    entity: "vehicle_inspection", entityId: inspection.id, action: "create", summary: parsed.data.result,
  });
  revalidatePath(BACK);
  return done(BACK, "Inspection recorded.");
}

export async function confirmLoad(formData: FormData): Promise<void> {
  const session = await assertCapability("run.execute");
  const id = z.string().uuid().safeParse(formData.get("route_id"));
  if (!id.success) return fail(BACK, "That run could not be found.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("daily_routes")
    .update({
      load_confirmed_at: new Date().toISOString(),
      load_confirmed_by: session.userId,
      status: "load_confirmed",
    })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, { entity: "daily_route", entityId: id.data, action: "status_change", summary: "load confirmed" });
  revalidatePath(BACK);
  return done(BACK, "Load confirmed.");
}

export async function startRun(formData: FormData): Promise<void> {
  const session = await assertCapability("run.execute");
  const id = z.string().uuid().safeParse(formData.get("route_id"));
  if (!id.success) return fail(BACK, "That run could not be found.");

  const supabase = await createClient();
  // The database refuses this transition without a confirmed load — the rule
  // lives there so no client can route around it. The inspection is recorded
  // and shown, but no longer gates the start (migration 0012).
  const { error } = await supabase
    .from("daily_routes").update({ status: "in_progress" })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, { entity: "daily_route", entityId: id.data, action: "status_change", summary: "started" });
  revalidatePath(BACK);
  return done(BACK, "Run started. Drive safely.");
}

export async function markReturning(formData: FormData): Promise<void> {
  const session = await assertCapability("run.execute");
  const id = z.string().uuid().safeParse(formData.get("route_id"));
  if (!id.success) return fail(BACK, "That run could not be found.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("daily_routes")
    .update({ status: "returning", returned_at: new Date().toISOString() })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail(BACK, describeDbError(error));
  revalidatePath(BACK);
  return done(BACK, "Marked as returning to depot.");
}

/**
 * Unload moves everything still on the vehicle into depot receiving
 * (acceptance criterion §10) and stamps the run as unloaded.
 */
export async function unloadRun(formData: FormData): Promise<void> {
  const session = await assertCapability("run.execute");
  const parsed = z.object({
    route_id: z.string().uuid(),
    odometer_end_km: z.preprocess(
      (v) => (v === "" || v == null ? undefined : Number(v)),
      z.number().int().min(0).optional(),
    ),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const sweepError = await sweepVehicleToDepot(session.tenantId, parsed.data.route_id);
  if (sweepError) return fail(BACK, sweepError);

  const supabase = await createClient();
  const { error } = await supabase
    .from("daily_routes")
    .update({
      status: "unloading",
      unloaded_at: new Date().toISOString(),
      odometer_end_km: parsed.data.odometer_end_km ?? null,
    })
    .eq("id", parsed.data.route_id).eq("tenant_id", session.tenantId);
  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, {
    entity: "daily_route", entityId: parsed.data.route_id, action: "status_change", summary: "unloaded",
  });
  revalidatePath(BACK);
  return done(BACK, "Vehicle unloaded into depot receiving.");
}

export async function closeRun(formData: FormData): Promise<void> {
  const session = await assertCapability("run.execute");
  const id = z.string().uuid().safeParse(formData.get("route_id"));
  if (!id.success) return fail(BACK, "That run could not be found.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("daily_routes").update({ status: "closed" })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, { entity: "daily_route", entityId: id.data, action: "status_change", summary: "closed" });
  revalidatePath(BACK);
  return done(BACK, "Run closed. Have a good evening.");
}
