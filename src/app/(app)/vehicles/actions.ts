"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  describeDbError, done, fail, firstIssue, money, optionalDate, optionalText, optionalUuid, toObject,
} from "@/lib/actions";

const optionalYear = z.preprocess(
  (value) => (value === "" || value === undefined || value === null ? undefined : Number(value)),
  z.number().int().min(1950).max(2100).optional(),
);

const optionalMoney = z.preprocess(
  (value) => (value === "" || value === undefined || value === null ? undefined : Number(value)),
  z.number().finite().min(0).optional(),
);

const vehicleSchema = z.object({
  registration: z.string().trim().min(1, "Registration is required").max(12),
  vin: optionalText,
  make: optionalText,
  model: optionalText,
  year: optionalYear,
  vehicle_type: z.enum(["van", "truck", "ute", "trailer", "prime_mover", "other"]),
  capacity_kg: optionalMoney,
  fuel_type: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["diesel", "petrol", "electric", "hybrid", "lpg"]).optional(),
  ),
  maintenance_status: z.enum(["ok", "due", "overdue", "in_service", "out_of_service"]),
  next_service_date: optionalDate,
  depot_id: optionalUuid,
  status: z.enum(["active", "inactive"]),
});

export async function createVehicle(formData: FormData): Promise<void> {
  const session = await assertCapability("fleet.write");
  const parsed = vehicleSchema.safeParse(toObject(formData));
  if (!parsed.success) fail("/vehicles", firstIssue(parsed.error));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vehicles")
    .insert({
      ...parsed.data,
      registration: parsed.data.registration.toUpperCase(),
      tenant_id: session.tenantId,
      created_by: session.userId,
    })
    .select("id, registration")
    .single();

  if (error) fail("/vehicles", describeDbError(error));

  await recordAudit(session, {
    entity: "vehicle", entityId: data.id, action: "create", summary: data.registration,
  });
  revalidatePath("/vehicles");
  done("/vehicles", `Vehicle ${data.registration} added.`);
}

export async function updateVehicleStatus(formData: FormData): Promise<void> {
  const session = await assertCapability("fleet.write");
  const parsed = z.object({
    id: z.string().uuid(),
    maintenance_status: z.enum(["ok", "due", "overdue", "in_service", "out_of_service"]),
  }).safeParse(toObject(formData));
  if (!parsed.success) fail("/vehicles", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase
    .from("vehicles")
    .update({ maintenance_status: parsed.data.maintenance_status })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);

  if (error) fail("/vehicles", describeDbError(error));

  await recordAudit(session, {
    entity: "vehicle", entityId: parsed.data.id, action: "status_change",
    summary: parsed.data.maintenance_status,
  });
  revalidatePath("/vehicles");
  done("/vehicles", "Maintenance status updated.");
}

const fuelLogSchema = z.object({
  vehicle_id: z.string().uuid(),
  odometer_km: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number().int().min(0).optional(),
  ),
  litres: optionalMoney,
  cost: money,
  notes: optionalText,
});

export async function logFuel(formData: FormData): Promise<void> {
  const session = await assertCapability("fleet.write");
  const parsed = fuelLogSchema.safeParse(toObject(formData));
  if (!parsed.success) fail("/vehicles", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase.from("fuel_logs").insert({
    ...parsed.data, tenant_id: session.tenantId, created_by: session.userId,
  });
  if (error) fail("/vehicles", describeDbError(error));

  await recordAudit(session, {
    entity: "fuel_log", entityId: parsed.data.vehicle_id, action: "create",
    summary: `${parsed.data.litres ?? 0} L`,
  });
  revalidatePath("/vehicles");
  done("/vehicles", "Fuel logged.");
}
