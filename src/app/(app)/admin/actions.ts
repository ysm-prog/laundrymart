"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { ROLES } from "@/lib/roles";
import {
  describeDbError, done, fail, firstIssue, optionalText, optionalUuid, requiredDate, toObject,
} from "@/lib/actions";

const depotSchema = z.object({
  code: z.string().trim().min(1, "A depot code is required").max(16),
  name: z.string().trim().min(2, "Name is required"),
  address_line1: optionalText,
  suburb: optionalText,
  state: optionalText,
  postcode: optionalText,
  contact_name: optionalText,
  contact_phone: optionalText,
  contact_email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().email("Enter a valid email").optional(),
  ),
  timezone: z.string().trim().min(3),
  status: z.enum(["active", "inactive"]),
});

export async function createDepot(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = depotSchema.safeParse(toObject(formData));
  if (!parsed.success) fail("/admin/depots", firstIssue(parsed.error));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("depots")
    .insert({ ...parsed.data, tenant_id: session.tenantId, created_by: session.userId })
    .select("id, code")
    .single();
  if (error) fail("/admin/depots", describeDbError(error));

  await recordAudit(session, { entity: "depot", entityId: data.id, action: "create", summary: data.code });
  revalidatePath("/admin/depots");
  done("/admin/depots", `Depot ${data.code} created.`);
}

export async function updateDepotStatus(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = z.object({
    id: z.string().uuid(),
    status: z.enum(["active", "inactive", "archived"]),
  }).safeParse(toObject(formData));
  if (!parsed.success) fail("/admin/depots", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase
    .from("depots").update({ status: parsed.data.status })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) fail("/admin/depots", describeDbError(error));

  await recordAudit(session, {
    entity: "depot", entityId: parsed.data.id, action: "status_change", summary: parsed.data.status,
  });
  revalidatePath("/admin/depots");
  done("/admin/depots", "Depot updated.");
}

export async function addHoliday(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = z.object({
    holiday_date: requiredDate,
    name: z.string().trim().min(2, "Give the holiday a name"),
    region: z.string().trim().min(2).max(4),
  }).safeParse(toObject(formData));
  if (!parsed.success) fail("/admin/holidays", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase.from("public_holidays").insert({
    ...parsed.data, tenant_id: session.tenantId, created_by: session.userId,
  });
  if (error) fail("/admin/holidays", describeDbError(error));

  await recordAudit(session, {
    entity: "public_holiday", action: "create",
    summary: `${parsed.data.name} ${parsed.data.holiday_date} (${parsed.data.region})`,
  });
  revalidatePath("/admin/holidays");
  done("/admin/holidays", "Public holiday added.");
}

export async function removeHoliday(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) fail("/admin/holidays", "That holiday could not be found.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("public_holidays").delete()
    .eq("id", id.data).eq("tenant_id", session.tenantId);
  if (error) fail("/admin/holidays", describeDbError(error));

  await recordAudit(session, { entity: "public_holiday", entityId: id.data, action: "delete" });
  revalidatePath("/admin/holidays");
  done("/admin/holidays", "Public holiday removed.");
}

export async function updateMembership(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = z.object({
    user_id: z.string().uuid(),
    role: z.enum(ROLES),
    depot_id: optionalUuid,
  }).safeParse(toObject(formData));
  if (!parsed.success) fail("/admin/users", firstIssue(parsed.error));

  if (parsed.data.user_id === session.userId && parsed.data.role !== session.role) {
    fail("/admin/users", "You cannot change your own role — ask another administrator.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("memberships")
    .update({ role: parsed.data.role, depot_id: parsed.data.depot_id ?? null })
    .eq("user_id", parsed.data.user_id).eq("tenant_id", session.tenantId);
  if (error) fail("/admin/users", describeDbError(error));

  await recordAudit(session, {
    entity: "membership", entityId: parsed.data.user_id, action: "update", summary: parsed.data.role,
  });
  revalidatePath("/admin/users");
  done("/admin/users", "Access updated.");
}
