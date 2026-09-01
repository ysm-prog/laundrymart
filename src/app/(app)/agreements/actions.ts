"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { servicePatternSchema, type ServicePattern } from "@/lib/domain/service-calendar";
import {
  checkbox, count, describeDbError, done, fail, firstIssue, money, optionalDate,
  optionalText, optionalUuid, percent, requiredDate, toObject, weekdaysFrom,
} from "@/lib/actions";
import { parseWizardLines } from "./wizard-lines";

/**
 * Patterns arrive as a handful of flat form fields (`<prefix>_type`, weekday
 * checkboxes, an anchor, …) and are assembled into the single JSON shape the
 * domain module and the database both speak.
 */
function patternFrom(formData: FormData, prefix: string): ServicePattern | null {
  const type = String(formData.get(`${prefix}_type`) ?? "weekly");

  const draft: unknown = (() => {
    switch (type) {
      case "alternate_weekly":
        return {
          type,
          weekdays: weekdaysFrom(formData, `${prefix}_weekdays`),
          anchorDate: String(formData.get(`${prefix}_anchor`) ?? ""),
        };
      case "monthly_nth":
        return {
          type,
          weekday: Number(formData.get(`${prefix}_weekday`) ?? 1),
          nth: Number(formData.get(`${prefix}_nth`) ?? 1),
        };
      case "custom":
        return {
          type,
          dates: String(formData.get(`${prefix}_dates`) ?? "")
            .split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
        };
      default:
        return { type: "weekly", weekdays: weekdaysFrom(formData, `${prefix}_weekdays`) };
    }
  })();

  const parsed = servicePatternSchema.safeParse(draft);
  return parsed.success ? parsed.data : null;
}

const agreementSchema = z.object({
  customer_id: z.string().uuid("Choose a customer"),
  location_id: optionalUuid,
  depot_id: optionalUuid,
  start_date: requiredDate,
  end_date: optionalDate,
  collections_per_visit: count.pipe(z.number().min(1, "At least one collection per visit")),
  emergency_service: checkbox,
  linen_ownership: z.enum(["rental", "customer_owned", "mixed"]),
  minimum_charge: money,
  holiday_rule: z.enum(["skip", "next_business_day", "previous_business_day", "service_as_normal"]),
  holiday_region: z.string().trim().min(2).max(4),
  weekend_surcharge_pct: percent,
  holiday_surcharge_pct: percent,
  fuel_levy_pct: percent,
  billing_frequency: z.enum(["per_service", "weekly", "fortnightly", "monthly"]),
  payment_terms_days: count,
  purchase_order_number: optionalText,
  notes: optionalText,
});

export async function createAgreement(formData: FormData): Promise<void> {
  const session = await assertCapability("agreements.write");
  const backTo = "/agreements/new";

  const parsed = agreementSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const pickup = patternFrom(formData, "pickup");
  // The wizard's common case: clean linen comes back on the next service day,
  // so the delivery pattern is the pickup pattern — one checkbox, not a second
  // pattern editor.
  const followsPickup = formData.get("delivery_follows") === "on";
  const delivery = followsPickup ? pickup : patternFrom(formData, "delivery");
  if (!pickup) return fail(backTo, "The pickup pattern is incomplete — pick at least one service day.");
  if (!delivery) return fail(backTo, "The delivery pattern is incomplete — pick at least one service day.");

  const lines = parseWizardLines(formData.get("lines"));
  if (lines === null) {
    return fail(backTo, "The priced items could not be read. Check step 3 and try again.");
  }

  const supabase = await createClient();
  const { data: agreementNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "agreement", p: "SA" });
  if (numberError) return fail(backTo, describeDbError(numberError));

  const { data, error } = await supabase
    .from("service_agreements")
    .insert({
      ...parsed.data,
      tenant_id: session.tenantId,
      created_by: session.userId,
      agreement_number: agreementNumber as string,
      pickup_pattern: pickup,
      delivery_pattern: delivery,
      status: "draft",
    })
    .select("id, agreement_number")
    .single();

  if (error) return fail(backTo, describeDbError(error));

  if (lines.length > 0) {
    const { error: lineError } = await supabase.from("service_agreement_lines").insert(
      lines.map((line) => ({
        ...line,
        agreement_id: data.id,
        tenant_id: session.tenantId,
        created_by: session.userId,
      })),
    );
    if (lineError) {
      // The agreement exists; land on it so the lines can be re-added there.
      return fail(`/agreements/${data.id}`,
        `${data.agreement_number} was created, but its priced items could not be saved: ${describeDbError(lineError)}`);
    }
  }

  await recordAudit(session, {
    entity: "service_agreement", entityId: data.id, action: "create",
    summary: data.agreement_number,
  });
  revalidatePath("/agreements");
  return done(`/agreements/${data.id}`,
    `Contract ${data.agreement_number} created as a draft. Activate it and it starts appearing on runs.`);
}

export async function updateAgreement(formData: FormData): Promise<void> {
  const session = await assertCapability("agreements.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/agreements", "That agreement could not be found.");
  const backTo = `/agreements/${id.data}`;

  const parsed = agreementSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const pickup = patternFrom(formData, "pickup");
  const delivery = patternFrom(formData, "delivery");
  if (!pickup || !delivery) return fail(backTo, "Both service patterns need at least one service day.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("service_agreements")
    .update({ ...parsed.data, pickup_pattern: pickup, delivery_pattern: delivery })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, { entity: "service_agreement", entityId: id.data, action: "update" });
  revalidatePath(backTo);
  return done(backTo, "Agreement updated.");
}

export async function setAgreementStatus(formData: FormData): Promise<void> {
  const session = await assertCapability("agreements.write");
  const parsed = z.object({
    id: z.string().uuid(),
    status: z.enum(["draft", "active", "suspended", "expired", "terminated"]),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/agreements", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase
    .from("service_agreements").update({ status: parsed.data.status })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);

  if (error) return fail(`/agreements/${parsed.data.id}`, describeDbError(error));

  await recordAudit(session, {
    entity: "service_agreement", entityId: parsed.data.id,
    action: "status_change", summary: parsed.data.status,
  });
  revalidatePath(`/agreements/${parsed.data.id}`);
  return done(`/agreements/${parsed.data.id}`, `Agreement marked ${parsed.data.status}.`);
}

const lineSchema = z.object({
  agreement_id: z.string().uuid(),
  item_id: optionalUuid,
  charge_type: z.enum([
    "rental", "wash_only", "replacement", "minimum_service_fee", "fuel_levy",
    "emergency_delivery", "weekend_surcharge", "holiday_surcharge", "bag_charge",
    "weight_charge", "monthly_fee", "other",
  ]),
  pricing_model: z.enum(["per_item", "per_kg", "per_collection", "monthly", "percentage"]),
  unit_price: money,
  standard_quantity: money,
  included_quantity: money,
  taxable: checkbox,
});

export async function addAgreementLine(formData: FormData): Promise<void> {
  const session = await assertCapability("agreements.write");
  const parsed = lineSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/agreements", firstIssue(parsed.error));
  const backTo = `/agreements/${parsed.data.agreement_id}`;

  const supabase = await createClient();
  const { error } = await supabase.from("service_agreement_lines").insert({
    ...parsed.data, tenant_id: session.tenantId, created_by: session.userId,
  });
  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "service_agreement_line", entityId: parsed.data.agreement_id,
    action: "create", summary: parsed.data.charge_type,
  });
  revalidatePath(backTo);
  return done(backTo, "Priced line added.");
}

export async function removeAgreementLine(formData: FormData): Promise<void> {
  const session = await assertCapability("agreements.write");
  const parsed = z.object({
    id: z.string().uuid(), agreement_id: z.string().uuid(),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/agreements", firstIssue(parsed.error));
  const backTo = `/agreements/${parsed.data.agreement_id}`;

  const supabase = await createClient();
  const { error } = await supabase
    .from("service_agreement_lines").delete()
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);

  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "service_agreement_line", entityId: parsed.data.id, action: "delete",
  });
  revalidatePath(backTo);
  return done(backTo, "Line removed.");
}

/**
 * Contract versioning (§7.4): supersede rather than overwrite, so historic
 * invoices still point at the terms that produced them.
 */
export async function createNewVersion(formData: FormData): Promise<void> {
  const session = await assertCapability("agreements.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/agreements", "That agreement could not be found.");

  const supabase = await createClient();
  const { data: current, error: readError } = await supabase
    .from("service_agreements").select("*")
    .eq("tenant_id", session.tenantId)
    .eq("id", id.data).single();
  if (readError) return fail(`/agreements/${id.data}`, describeDbError(readError));

  const {
    id: _id, created_at: _created, updated_at: _updated, deleted_at: _deleted,
    ...rest
  } = current as Record<string, unknown>;

  const { data: created, error } = await supabase
    .from("service_agreements")
    .insert({
      ...rest,
      version: Number(current.version) + 1,
      supersedes_id: id.data,
      status: "draft",
      created_by: session.userId,
    })
    .select("id, agreement_number, version")
    .single();

  if (error) return fail(`/agreements/${id.data}`, describeDbError(error));

  // Carry the priced lines across so the new version starts from the old terms.
  const { data: lines } = await supabase
    .from("service_agreement_lines").select("*").eq("agreement_id", id.data);

  if (lines?.length) {
    const copies = lines.map((line) => {
      const { id: _lineId, created_at: _lineCreated, updated_at: _lineUpdated, ...lineRest } =
        line as Record<string, unknown>;
      return { ...lineRest, agreement_id: created.id, created_by: session.userId };
    });
    const { error: lineError } = await supabase.from("service_agreement_lines").insert(copies);
    if (lineError) return fail(`/agreements/${created.id}`, describeDbError(lineError));
  }

  await recordAudit(session, {
    entity: "service_agreement", entityId: created.id, action: "create",
    summary: `${created.agreement_number} v${created.version} superseding v${current.version}`,
  });
  revalidatePath("/agreements");
  return done(`/agreements/${created.id}`, `Version ${created.version} created as a draft.`);
}
