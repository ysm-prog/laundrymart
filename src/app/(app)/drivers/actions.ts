"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  describeDbError, done, fail, firstIssue, optionalDate, optionalText, optionalUuid, toObject,
} from "@/lib/actions";

const driverSchema = z.object({
  full_name: z.string().trim().min(2, "Driver name is required"),
  employee_number: optionalText,
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().email("Enter a valid email").optional(),
  ),
  phone: optionalText,
  licence_number: optionalText,
  licence_expiry: optionalDate,
  depot_id: optionalUuid,
  user_id: optionalUuid,
  status: z.enum(["active", "on_leave", "inactive"]),
});

export async function createDriver(formData: FormData): Promise<void> {
  const session = await assertCapability("fleet.write");
  const parsed = driverSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/drivers", firstIssue(parsed.error));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("drivers")
    .insert({ ...parsed.data, tenant_id: session.tenantId, created_by: session.userId })
    .select("id, full_name")
    .single();

  if (error) return fail("/drivers", describeDbError(error));

  await recordAudit(session, {
    entity: "driver", entityId: data.id, action: "create", summary: data.full_name,
  });
  revalidatePath("/drivers");
  return done("/drivers", `${data.full_name} added.`);
}

export async function updateDriverStatus(formData: FormData): Promise<void> {
  const session = await assertCapability("fleet.write");
  const parsed = z.object({
    id: z.string().uuid(),
    status: z.enum(["active", "on_leave", "inactive"]),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/drivers", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase
    .from("drivers").update({ status: parsed.data.status })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);

  if (error) return fail("/drivers", describeDbError(error));

  await recordAudit(session, {
    entity: "driver", entityId: parsed.data.id, action: "status_change", summary: parsed.data.status,
  });
  revalidatePath("/drivers");
  return done("/drivers", "Driver status updated.");
}

/**
 * Link a driver record to a login. This is what makes "drivers see their own run
 * only" work — the RLS policy matches `drivers.user_id` to the caller.
 */
export async function linkDriverLogin(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid("Choose the login to link"),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/drivers", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase
    .from("drivers").update({ user_id: parsed.data.user_id })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);

  if (error) return fail("/drivers", describeDbError(error));

  await recordAudit(session, {
    entity: "driver", entityId: parsed.data.id, action: "update", summary: "login linked",
  });
  revalidatePath("/drivers");
  return done("/drivers", "Login linked to driver.");
}
