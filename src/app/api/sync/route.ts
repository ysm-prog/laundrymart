import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { recordAudit } from "@/lib/audit";
import { MAX_PHOTOS, isTenantPath } from "@/lib/media";
import { notify } from "@/lib/notifications/notify";
import { sendDeliveryConfirmation } from "@/lib/notifications/delivery-confirmation";

/**
 * Offline sync endpoint for the driver app.
 *
 * Every record carries a `clientRef` the device generates before it goes
 * offline. That ref is unique per tenant in the database, so replaying the same
 * queue twice — which will happen when a phone regains signal mid-flight —
 * inserts once and reports the duplicate as already-synced rather than failing.
 */

const line = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().int().min(0),
  damagedQuantity: z.number().int().min(0).optional(),
  missingQuantity: z.number().int().min(0).optional(),
});

// Media is uploaded ahead of the batch by /api/media; what arrives here is the
// storage key it returned, re-checked below against the caller's own tenant.
const media = {
  photoPaths: z.array(z.string().max(400)).max(MAX_PHOTOS).optional(),
  signaturePath: z.string().max(400).nullish(),
};

const pickup = z.object({
  kind: z.literal("pickup"),
  clientRef: z.string().min(8).max(80),
  jobId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  bagCount: z.number().int().min(0).default(0),
  totalWeightKg: z.number().min(0).nullish(),
  signedBy: z.string().max(120).nullish(),
  notes: z.string().max(2000).nullish(),
  lines: z.array(line).min(1),
  ...media,
});

const delivery = z.object({
  kind: z.literal("delivery"),
  clientRef: z.string().min(8).max(80),
  jobId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  signedBy: z.string().max(120).nullish(),
  notes: z.string().max(2000).nullish(),
  lines: z.array(line).min(1),
  ...media,
});

const batch = z.object({
  records: z.array(z.discriminatedUnion("kind", [pickup, delivery])).min(1).max(100),
});

type Outcome = { clientRef: string; status: "accepted" | "duplicate" | "rejected"; reason?: string };

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!can(session.role, "operations.write")) {
    return NextResponse.json({ error: "Your role cannot record field data." }, { status: 403 });
  }

  const parsed = batch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Malformed sync batch", issues: parsed.error.issues.slice(0, 5) },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const outcomes: Outcome[] = [];

  for (const record of parsed.data.records) {
    const table = record.kind === "pickup" ? "pickups" : "deliveries";

    const { data: existing } = await supabase
      .from(table).select("id").eq("client_ref", record.clientRef).maybeSingle();
    if (existing) {
      outcomes.push({ clientRef: record.clientRef, status: "duplicate" });
      continue;
    }

    // RLS scopes this read: a driver can only reach their own jobs.
    const { data: job } = await supabase
      .from("jobs")
      .select("id, customer_id, route_id, driver_id, vehicle_id")
      .eq("id", record.jobId)
      .maybeSingle();

    if (!job) {
      outcomes.push({ clientRef: record.clientRef, status: "rejected", reason: "Job not found" });
      continue;
    }

    // Storage already refused a cross-tenant write; this second check stops a
    // caller from *recording* someone else's key against their own paperwork.
    const photoUrls = (record.photoPaths ?? [])
      .filter((path) => isTenantPath(path, session.tenantId));
    const signatureUrl = record.signaturePath
      && isTenantPath(record.signaturePath, session.tenantId)
      ? record.signaturePath
      : null;

    const base = {
      tenant_id: session.tenantId,
      created_by: session.userId,
      job_id: job.id,
      customer_id: job.customer_id,
      driver_id: job.driver_id,
      route_id: job.route_id,
      client_ref: record.clientRef,
      signed_by: record.signedBy ?? null,
      notes: record.notes ?? null,
      photo_urls: photoUrls,
      signature_url: signatureUrl,
      completed_at: record.capturedAt,
      synced_at: new Date().toISOString(),
    };

    const { data: parent, error } = await supabase
      .from(table)
      .insert(record.kind === "pickup"
        ? {
            ...base,
            pickup_date: record.capturedAt.slice(0, 10),
            bag_count: record.bagCount,
            total_weight_kg: record.totalWeightKg ?? null,
          }
        : { ...base, delivery_date: record.capturedAt.slice(0, 10) })
      .select("id")
      .single();

    if (error || !parent) {
      // A unique-violation here means a concurrent replay won the race.
      const status = error?.code === "23505" ? "duplicate" : "rejected";
      outcomes.push({ clientRef: record.clientRef, status, reason: error?.message });
      continue;
    }

    const lineRows = record.lines.map((entry) => ({
      tenant_id: session.tenantId,
      created_by: session.userId,
      item_id: entry.itemId,
      quantity: entry.quantity,
      ...(record.kind === "pickup"
        ? {
            pickup_id: parent.id,
            damaged_quantity: entry.damagedQuantity ?? 0,
            missing_quantity: entry.missingQuantity ?? 0,
          }
        : { delivery_id: parent.id }),
    }));

    const { error: lineError } = await supabase
      .from(record.kind === "pickup" ? "pickup_lines" : "delivery_lines")
      .insert(lineRows);

    if (lineError) {
      outcomes.push({ clientRef: record.clientRef, status: "rejected", reason: lineError.message });
      continue;
    }

    for (const entry of record.lines) {
      const moves = record.kind === "pickup"
        ? [
            { quantity: entry.quantity, from: "at_customer", to: "in_transit", reason: "pickup" },
            { quantity: entry.damagedQuantity ?? 0, from: "at_customer", to: "damaged", reason: "damage" },
            { quantity: entry.missingQuantity ?? 0, from: "at_customer", to: "lost", reason: "loss" },
          ]
        : [{ quantity: entry.quantity, from: "in_transit", to: "at_customer", reason: "delivery" }];

      for (const move of moves) {
        if (move.quantity <= 0) continue;
        await supabase.rpc("move_inventory", {
          p_tenant: session.tenantId,
          p_item: entry.itemId,
          p_owner_type: "laundry_owned",
          p_quantity: move.quantity,
          p_from_state: move.from,
          p_to_state: move.to,
          p_reason: move.reason,
          p_from_customer: move.from === "at_customer" ? job.customer_id : null,
          p_from_depot: null,
          p_from_vehicle: move.from === "in_transit" ? job.vehicle_id : null,
          p_to_customer: move.to === "at_customer" || move.to === "damaged" || move.to === "lost"
            ? job.customer_id : null,
          p_to_depot: null,
          p_to_vehicle: move.to === "in_transit" ? job.vehicle_id : null,
          p_job: job.id,
          p_pickup: record.kind === "pickup" ? parent.id : null,
          p_delivery: record.kind === "delivery" ? parent.id : null,
          p_notes: "offline sync",
        });
      }
    }

    await supabase
      .from("jobs")
      .update({
        progress_status: record.kind === "pickup" ? "pickup_completed" : "delivery_completed",
      })
      .eq("id", job.id).eq("tenant_id", session.tenantId);

    // Same courtesy as a delivery typed at a desk: the customer hears about it
    // when the phone syncs, not when someone remembers. A replayed batch takes
    // the `duplicate` branch above and never reaches here, so a queue flushed
    // twice does not email twice.
    if (record.kind === "delivery") {
      await sendDeliveryConfirmation(session, parent.id);
    }

    outcomes.push({ clientRef: record.clientRef, status: "accepted" });
  }

  const accepted = outcomes.filter((outcome) => outcome.status === "accepted").length;
  if (accepted > 0) {
    await recordAudit(session, {
      entity: "offline_sync", action: "sync",
      summary: `${accepted} of ${outcomes.length} records synced`,
      metadata: { outcomes },
    });
  }

  // A rejected record is proof of service that never landed: the driver's phone
  // shows the stop done, the office sees nothing, and the queue will keep
  // retrying a batch that will keep failing. `duplicate` is not a failure — it
  // is the replay path working as designed — so only outright rejections raise
  // anything. One notification per batch, not per record, because a stale token
  // or a bad deploy rejects every stop a driver has and the useful signal is
  // "this driver's day is not coming in", said once.
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  if (rejected.length > 0) {
    await notify(session, {
      kind: "sync_failed",
      subjectId: session.userId,
      title: `${rejected.length} stop(s) captured on a driver's phone could not be saved.`
        + " The paperwork is still on the device — check the stops before the run closes.",
      href: "/operations/exceptions",
    });
  }

  return NextResponse.json({ outcomes }, { status: 200 });
}
