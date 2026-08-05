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
import { sendDeliveryConfirmation } from "@/lib/notifications/delivery-confirmation";

/**
 * Proof-of-service media arrives as storage keys the browser already uploaded.
 * Storage refused a cross-tenant write on the way in; this stops another
 * tenant's key from being *recorded* against our paperwork.
 */
function ownMedia(session: Session, paths: string[], signature?: string) {
  return {
    photo_urls: paths.filter((path) => isTenantPath(path, session.tenantId)),
    signature_url: signature && isTenantPath(signature, session.tenantId) ? signature : null,
  };
}

/**
 * Quantities are posted as `qty_<itemId>` / `damaged_<itemId>` / `missing_<itemId>`
 * so a form can list every item without index bookkeeping. Zero rows are dropped
 * — a pickup records what was collected, not what was offered.
 */
type CountedLine = {
  itemId: string;
  quantity: number;
  damagedQuantity: number;
  missingQuantity: number;
};

function countedLines(formData: FormData): CountedLine[] {
  const lines = new Map<string, CountedLine>();

  const read = (key: string, prefix: string): string | null =>
    key.startsWith(prefix) ? key.slice(prefix.length) : null;

  for (const [key, raw] of formData.entries()) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;

    const targets: Array<[string, keyof Omit<CountedLine, "itemId">]> = [
      ["qty_", "quantity"], ["damaged_", "damagedQuantity"], ["missing_", "missingQuantity"],
    ];

    for (const [prefix, field] of targets) {
      const itemId = read(key, prefix);
      if (!itemId) continue;
      const line = lines.get(itemId) ??
        { itemId, quantity: 0, damagedQuantity: 0, missingQuantity: 0 };
      line[field] = Math.trunc(value);
      lines.set(itemId, line);
    }
  }

  return [...lines.values()].filter(
    (line) => line.quantity > 0 || line.damagedQuantity > 0 || line.missingQuantity > 0,
  );
}

/** Where the job's linen is coming from / going to, for the movement ledger. */
async function jobContext(jobId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("jobs")
    .select("id, customer_id, route_id, driver_id, vehicle_id, depot_id, status")
    .eq("id", jobId)
    .maybeSingle();
  return data;
}

const pickupSchema = z.object({
  job_id: z.string().uuid(),
  bag_count: z.preprocess((v) => (v === "" || v == null ? 0 : Number(v)), z.number().int().min(0)),
  total_weight_kg: z.preprocess(
    (v) => (v === "" || v == null ? undefined : Number(v)),
    z.number().finite().min(0).optional(),
  ),
  signed_by: optionalText,
  notes: optionalText,
  client_ref: optionalText,
  photo_paths: mediaPaths,
  signature_path: optionalText,
});

export async function recordPickup(formData: FormData): Promise<void> {
  const session = await assertCapability("operations.write");
  const parsed = pickupSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/jobs", firstIssue(parsed.error));

  const jobId = parsed.data.job_id;
  const backTo = `/jobs/${jobId}`;
  const lines = countedLines(formData);
  if (lines.length === 0) return fail(backTo, "Record at least one item quantity before saving the pickup.");

  const job = await jobContext(jobId);
  if (!job) return fail(backTo, "That job could not be found.");

  const supabase = await createClient();
  const { data: pickup, error } = await supabase
    .from("pickups")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      job_id: jobId,
      customer_id: job.customer_id,
      driver_id: job.driver_id,
      route_id: job.route_id,
      bag_count: parsed.data.bag_count,
      total_weight_kg: parsed.data.total_weight_kg ?? null,
      signed_by: parsed.data.signed_by ?? null,
      notes: parsed.data.notes ?? null,
      client_ref: parsed.data.client_ref ?? null,
      ...ownMedia(session, parsed.data.photo_paths, parsed.data.signature_path),
      completed_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) return fail(backTo, describeDbError(error));

  const { error: lineError } = await supabase.from("pickup_lines").insert(
    lines.map((line) => ({
      tenant_id: session.tenantId,
      created_by: session.userId,
      pickup_id: pickup.id,
      item_id: line.itemId,
      quantity: line.quantity,
      damaged_quantity: line.damagedQuantity,
      missing_quantity: line.missingQuantity,
    })),
  );
  if (lineError) return fail(backTo, describeDbError(lineError));

  // Acceptance criterion §10: a pickup reduces customer stock and increases
  // in-transit stock. Damaged and missing quantities are moved to their own
  // states so they can be charged and chased.
  await applyPickupMovements(session, { job, pickupId: pickup.id, lines, backTo });

  await supabase.from("jobs")
    .update({ progress_status: "pickup_completed", arrived_at: new Date().toISOString() })
    .eq("id", jobId).eq("tenant_id", session.tenantId);

  await recordAudit(session, {
    entity: "pickup", entityId: pickup.id, action: "create",
    summary: `${lines.reduce((total, line) => total + line.quantity, 0)} items`,
    metadata: { jobId },
  });

  revalidatePath(backTo);
  return done(backTo, "Pickup recorded.");
}

async function applyPickupMovements(
  session: Session,
  {
    job, pickupId, lines, backTo,
  }: {
    job: { customer_id: string; vehicle_id: string | null; depot_id: string | null; id: string };
    pickupId: string;
    lines: CountedLine[];
    backTo: string;
  },
) {
  const supabase = await createClient();

  for (const line of lines) {
    const moves: Array<{ quantity: number; to: string; reason: string }> = [
      { quantity: line.quantity, to: "in_transit", reason: "pickup" },
      { quantity: line.damagedQuantity, to: "damaged", reason: "damage" },
      { quantity: line.missingQuantity, to: "lost", reason: "loss" },
    ];

    for (const move of moves) {
      if (move.quantity <= 0) continue;
      const { error } = await supabase.rpc("move_inventory", {
        p_tenant: session.tenantId,
        p_item: line.itemId,
        p_owner_type: "laundry_owned",
        p_quantity: move.quantity,
        p_from_state: "at_customer",
        p_to_state: move.to,
        p_reason: move.reason,
        p_from_customer: job.customer_id,
        p_from_depot: null,
        p_from_vehicle: null,
        p_to_customer: move.to === "in_transit" ? null : job.customer_id,
        p_to_depot: null,
        p_to_vehicle: move.to === "in_transit" ? job.vehicle_id : null,
        p_job: job.id,
        p_pickup: pickupId,
        p_delivery: null,
        p_notes: null,
      });
      if (error) return fail(backTo, describeDbError(error));
    }
  }
}

const deliverySchema = z.object({
  job_id: z.string().uuid(),
  signed_by: optionalText,
  notes: optionalText,
  client_ref: optionalText,
  photo_paths: mediaPaths,
  signature_path: optionalText,
});

export async function recordDelivery(formData: FormData): Promise<void> {
  const session = await assertCapability("operations.write");
  const parsed = deliverySchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/jobs", firstIssue(parsed.error));

  const jobId = parsed.data.job_id;
  const backTo = `/jobs/${jobId}`;
  const lines = countedLines(formData).filter((line) => line.quantity > 0);
  if (lines.length === 0) return fail(backTo, "Record at least one delivered quantity.");

  const job = await jobContext(jobId);
  if (!job) return fail(backTo, "That job could not be found.");

  const supabase = await createClient();
  const { data: delivery, error } = await supabase
    .from("deliveries")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      job_id: jobId,
      customer_id: job.customer_id,
      driver_id: job.driver_id,
      route_id: job.route_id,
      signed_by: parsed.data.signed_by ?? null,
      notes: parsed.data.notes ?? null,
      client_ref: parsed.data.client_ref ?? null,
      ...ownMedia(session, parsed.data.photo_paths, parsed.data.signature_path),
      completed_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) return fail(backTo, describeDbError(error));

  const { error: lineError } = await supabase.from("delivery_lines").insert(
    lines.map((line) => ({
      tenant_id: session.tenantId,
      created_by: session.userId,
      delivery_id: delivery.id,
      item_id: line.itemId,
      quantity: line.quantity,
    })),
  );
  if (lineError) return fail(backTo, describeDbError(lineError));

  for (const line of lines) {
    const { error: moveError } = await supabase.rpc("move_inventory", {
      p_tenant: session.tenantId,
      p_item: line.itemId,
      p_owner_type: "laundry_owned",
      p_quantity: line.quantity,
      p_from_state: "in_transit",
      p_to_state: "at_customer",
      p_reason: "delivery",
      p_from_customer: null,
      p_from_depot: null,
      p_from_vehicle: job.vehicle_id,
      p_to_customer: job.customer_id,
      p_to_depot: null,
      p_to_vehicle: null,
      p_job: job.id,
      p_pickup: null,
      p_delivery: delivery.id,
      p_notes: null,
    });
    if (moveError) return fail(backTo, describeDbError(moveError));
  }

  await supabase.from("jobs")
    .update({ progress_status: "delivery_completed" })
    .eq("id", jobId).eq("tenant_id", session.tenantId);

  await recordAudit(session, {
    entity: "delivery", entityId: delivery.id, action: "create",
    summary: `${lines.reduce((total, line) => total + line.quantity, 0)} items`,
    metadata: { jobId },
  });

  // Off by default; when the tenant has turned it on the customer gets their
  // proof of service without anyone remembering to send it.
  await sendDeliveryConfirmation(session, delivery.id);

  revalidatePath(backTo);
  return done(backTo, "Delivery recorded.");
}

export async function setJobProgress(formData: FormData): Promise<void> {
  const session = await assertCapability("operations.write");
  const parsed = z.object({
    id: z.string().uuid(),
    progress_status: z.enum([
      "not_started", "travelling", "at_customer", "pickup_completed",
      "delivery_completed", "completed",
    ]),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/jobs", firstIssue(parsed.error));

  const backTo = `/jobs/${parsed.data.id}`;
  const completing = parsed.data.progress_status === "completed";

  const supabase = await createClient();
  const { error } = await supabase
    .from("jobs")
    .update({
      progress_status: parsed.data.progress_status,
      status: completing ? "completed" : "in_progress",
      completed_at: completing ? new Date().toISOString() : null,
      arrived_at: parsed.data.progress_status === "at_customer" ? new Date().toISOString() : undefined,
    })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);

  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "job", entityId: parsed.data.id, action: "status_change",
    summary: parsed.data.progress_status,
  });
  revalidatePath(backTo);
  return done(backTo, "Job updated.");
}

export async function flagException(formData: FormData): Promise<void> {
  const session = await assertCapability("operations.write");
  const parsed = z.object({
    id: z.string().uuid(),
    exception_reason: z.enum([
      "customer_closed", "no_access", "nothing_to_collect", "vehicle_issue",
      "customer_refused", "short_delivery", "other",
    ]),
    exception_notes: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/jobs", firstIssue(parsed.error));

  const backTo = `/jobs/${parsed.data.id}`;
  const supabase = await createClient();
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "exception",
      exception_reason: parsed.data.exception_reason,
      exception_notes: parsed.data.exception_notes ?? null,
    })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);

  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "job", entityId: parsed.data.id, action: "status_change",
    summary: `exception: ${parsed.data.exception_reason}`,
  });
  revalidatePath(backTo);
  return done(backTo, "Exception recorded.");
}

export async function resolveException(formData: FormData): Promise<void> {
  const session = await assertCapability("operations.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/operations/exceptions", "That job could not be found.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("jobs")
    .update({ status: "scheduled", exception_reason: null, exception_notes: null })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail("/operations/exceptions", describeDbError(error));

  await recordAudit(session, {
    entity: "job", entityId: id.data, action: "status_change", summary: "exception resolved",
  });
  revalidatePath("/operations/exceptions");
  return done("/operations/exceptions", "Exception cleared.");
}
