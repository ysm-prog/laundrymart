"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  count, describeDbError, done, fail, firstIssue, optionalText, optionalUuid,
  toObject, weekdaysFrom,
} from "@/lib/actions";

const templateSchema = z.object({
  code: z.string().trim().min(1, "A short code is required").max(16),
  name: z.string().trim().min(2, "Name is required"),
  description: optionalText,
  depot_id: optionalUuid,
  default_driver_id: optionalUuid,
  default_vehicle_id: optionalUuid,
  planned_start_time: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM").optional(),
  ),
  status: z.enum(["active", "archived"]),
});

export async function createTemplate(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = templateSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/routes/templates", firstIssue(parsed.error));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("route_templates")
    .insert({
      ...parsed.data,
      weekdays: weekdaysFrom(formData, "weekdays"),
      tenant_id: session.tenantId,
      created_by: session.userId,
    })
    .select("id, code")
    .single();

  if (error) return fail("/routes/templates", describeDbError(error));

  await recordAudit(session, {
    entity: "route_template", entityId: data.id, action: "create", summary: data.code,
  });
  revalidatePath("/routes/templates");
  return done(`/routes/templates/${data.id}`, `Template ${data.code} created.`);
}

export async function updateTemplate(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/routes/templates", "That template could not be found.");

  const parsed = templateSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(`/routes/templates/${id.data}`, firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase
    .from("route_templates")
    .update({ ...parsed.data, weekdays: weekdaysFrom(formData, "weekdays") })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail(`/routes/templates/${id.data}`, describeDbError(error));

  await recordAudit(session, { entity: "route_template", entityId: id.data, action: "update" });
  revalidatePath(`/routes/templates/${id.data}`);
  return done(`/routes/templates/${id.data}`, "Template updated.");
}

const stopSchema = z.object({
  template_id: z.string().uuid(),
  customer_id: z.string().uuid("Choose a customer"),
  location_id: optionalUuid,
  service_type: z.enum(["pickup", "delivery", "both"]),
  service_minutes: count,
  planned_arrival: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM").optional(),
  ),
  notes: optionalText,
});

export async function addTemplateStop(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = stopSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/routes/templates", firstIssue(parsed.error));
  const backTo = `/routes/templates/${parsed.data.template_id}`;

  const supabase = await createClient();
  const { count: existing } = await supabase
    .from("route_template_stops")
    .select("id", { count: "exact", head: true })
    .eq("template_id", parsed.data.template_id);

  const { error } = await supabase.from("route_template_stops").insert({
    ...parsed.data,
    sequence: (existing ?? 0) + 1,
    tenant_id: session.tenantId,
    created_by: session.userId,
  });
  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "route_template_stop", entityId: parsed.data.template_id, action: "create",
  });
  revalidatePath(backTo);
  return done(backTo, "Stop added.");
}

export async function removeTemplateStop(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const parsed = z.object({
    id: z.string().uuid(), template_id: z.string().uuid(),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/routes/templates", firstIssue(parsed.error));
  const backTo = `/routes/templates/${parsed.data.template_id}`;

  const supabase = await createClient();
  const { error } = await supabase
    .from("route_template_stops").delete()
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "route_template_stop", entityId: parsed.data.id, action: "delete",
  });
  revalidatePath(backTo);
  return done(backTo, "Stop removed.");
}

/**
 * Persist a drag-and-drop reorder. The client submits the stop IDs in their new
 * visual order; sequence numbers are rewritten from that, so the order the
 * dispatcher sees is exactly what drivers get.
 */
export async function reorderTemplateStops(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const templateId = z.string().uuid().safeParse(formData.get("template_id"));
  if (!templateId.success) return fail("/routes/templates", "That template could not be found.");
  const backTo = `/routes/templates/${templateId.data}`;

  const order = z.array(z.string().uuid())
    .safeParse(String(formData.get("order") ?? "").split(",").filter(Boolean));
  if (!order.success || order.data.length === 0) return fail(backTo, "Could not read the new stop order.");

  const supabase = await createClient();
  // Sequence is not unique-constrained, so a straightforward pass is safe.
  for (const [index, stopId] of order.data.entries()) {
    const { error } = await supabase
      .from("route_template_stops")
      .update({ sequence: index + 1 })
      .eq("id", stopId)
      .eq("template_id", templateId.data)
      .eq("tenant_id", session.tenantId);
    if (error) return fail(backTo, describeDbError(error));
  }

  await recordAudit(session, {
    entity: "route_template", entityId: templateId.data, action: "update",
    summary: `resequenced ${order.data.length} stops`,
  });
  revalidatePath(backTo);
  return done(backTo, "Stop order saved.");
}

/** Duplicate a template with its stops (§7.7 "support duplicate route"). */
export async function duplicateTemplate(formData: FormData): Promise<void> {
  const session = await assertCapability("routes.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/routes/templates", "That template could not be found.");

  const supabase = await createClient();
  const { data: source, error: readError } = await supabase
    .from("route_templates").select("*")
    .eq("tenant_id", session.tenantId)
    .eq("id", id.data).single();
  if (readError) return fail("/routes/templates", describeDbError(readError));

  const { id: _id, created_at: _c, updated_at: _u, deleted_at: _d, ...rest } =
    source as Record<string, unknown>;

  const { data: copy, error } = await supabase
    .from("route_templates")
    .insert({
      ...rest,
      code: `${source.code}-COPY`,
      name: `${source.name} (copy)`,
      created_by: session.userId,
    })
    .select("id, code")
    .single();
  if (error) return fail("/routes/templates", describeDbError(error));

  const { data: stops } = await supabase
    .from("route_template_stops").select("*").eq("template_id", id.data).order("sequence");

  if (stops?.length) {
    const copies = stops.map((stop) => {
      const { id: _sid, created_at: _sc, updated_at: _su, ...stopRest } = stop as Record<string, unknown>;
      return { ...stopRest, template_id: copy.id, created_by: session.userId };
    });
    const { error: stopError } = await supabase.from("route_template_stops").insert(copies);
    if (stopError) return fail(`/routes/templates/${copy.id}`, describeDbError(stopError));
  }

  await recordAudit(session, {
    entity: "route_template", entityId: copy.id, action: "create", summary: `copy of ${source.code}`,
  });
  revalidatePath("/routes/templates");
  return done(`/routes/templates/${copy.id}`, `Duplicated as ${copy.code}.`);
}
