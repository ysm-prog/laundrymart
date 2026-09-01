"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  count, describeDbError, done, fail, firstIssue, optionalText, optionalUuid, toObject,
} from "@/lib/actions";
import { notify } from "@/lib/notifications/notify";
import {
  REJECT_DESTINATIONS, STAGE_INVENTORY_STATE, STAGE_MOVEMENT_REASON,
  isFlowStage, nextStage,
} from "./stages";
import { driverCountsForRoute } from "./returns";

const BACK = "/warehouse";

type BatchLine = {
  id: string;
  item_id: string;
  owner_type: "laundry_owned" | "customer_owned";
  customer_id: string | null;
  quantity: number;
  rejected_quantity: number;
};

/**
 * Book a returned van into the plant, counting it as you go.
 *
 * This is the operator's whole job at this point in the day: the van is on the
 * dock, the trolleys are in front of them, and the driver's numbers are already
 * on file. So the form arrives pre-filled and they only touch what disagrees.
 *
 * The disagreement is the point. Where the count is short the difference is
 * posted as a real `loss` movement rather than left in at_depot for nobody to
 * find — the recount is how shrinkage gets discovered, and a control that
 * silently discards its own finding is not a control.
 */
export async function countReturn(formData: FormData): Promise<void> {
  const session = await assertCapability("warehouse.write");
  const parsed = z.object({
    route_id: z.string().uuid(),
    machine: optionalText,
    notes: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const backTo = `/warehouse/count/${parsed.data.route_id}`;
  const supabase = await createClient();

  const { data: route } = await supabase
    .from("daily_routes")
    .select("id, code, depot_id, unloaded_at")
    .eq("tenant_id", session.tenantId)
    .eq("id", parsed.data.route_id)
    .maybeSingle<{ id: string; code: string; depot_id: string | null; unloaded_at: string | null }>();
  if (!route) return fail(BACK, "That run could not be found.");
  if (!route.unloaded_at) {
    return fail(BACK, "That van has not been unloaded yet — the driver finishes the run first.");
  }

  const { data: already } = await supabase
    .from("production_batches")
    .select("id, batch_number").eq("route_id", route.id).is("deleted_at", null)
    .maybeSingle<{ id: string; batch_number: string }>();
  if (already) {
    return fail(BACK, `Run ${route.code} was already counted into batch ${already.batch_number}.`);
  }

  // The driver's figures are the baseline; the form only sends what was counted
  // against them, so an item nobody touched still balances to zero difference.
  const expected = await driverCountsForRoute(route.id);
  const counted: Array<typeof expected[number] & { countedQuantity: number }> = [];
  let missingCountFor: string | null = null;
  for (const item of expected) {
    const raw = formData.get(`count_${item.itemId}`);
    const value = Number(raw);
    if (raw == null || raw === "" || !Number.isFinite(value) || value < 0) {
      missingCountFor = item.name;
      break;
    }
    counted.push({ ...item, countedQuantity: Math.trunc(value) });
  }
  if (missingCountFor) {
    return fail(backTo, `Enter a count for ${missingCountFor} — use 0 if none of it came back.`);
  }

  if (counted.every((item) => item.countedQuantity === 0)) {
    return fail(backTo, "Nothing was counted. If the van really came back empty, leave this run uncounted and tell your supervisor.");
  }

  const { data: batchNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "batch", p: "BATCH" });
  if (numberError) return fail(backTo, describeDbError(numberError));

  const { data: batch, error } = await supabase
    .from("production_batches")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      operator_id: session.userId,
      route_id: route.id,
      // Must match the depot the unload credited, or every stage after this one
      // draws from a pool that has nothing in it.
      depot_id: route.depot_id,
      batch_number: batchNumber as string,
      machine: parsed.data.machine ?? null,
      notes: parsed.data.notes ?? null,
    })
    .select("id, batch_number")
    .single();
  if (error) return fail(backTo, describeDbError(error));

  const lines = counted.filter((item) => item.countedQuantity > 0);
  if (lines.length > 0) {
    const { error: lineError } = await supabase.from("production_batch_lines").insert(
      lines.map((item) => ({
        tenant_id: session.tenantId,
        created_by: session.userId,
        batch_id: batch.id,
        item_id: item.itemId,
        quantity: item.countedQuantity,
        driver_quantity: item.driverQuantity,
      })),
    );
    if (lineError) return fail(backTo, describeDbError(lineError));
  }

  let short = 0;
  let over = 0;

  for (const item of counted) {
    const difference = item.countedQuantity - item.driverQuantity;
    if (difference === 0) continue;

    // Short: the driver booked it out of the customer but it never reached the
    // shelf. Over: more arrived than was booked, so it enters the system here.
    const movement = difference < 0
      ? {
        quantity: -difference, from: "at_depot", to: "lost", reason: "loss",
        note: `short at count, run ${route.code}`,
      }
      : {
        quantity: difference, from: null, to: "at_depot", reason: "manual",
        note: `extra found at count, run ${route.code}`,
      };

    const { error: moveError } = await supabase.rpc("move_inventory", {
      p_tenant: session.tenantId,
      p_item: item.itemId,
      p_owner_type: "laundry_owned",
      p_quantity: movement.quantity,
      p_from_state: movement.from,
      p_to_state: movement.to,
      p_reason: movement.reason,
      p_from_customer: null,
      p_from_depot: movement.from ? route.depot_id : null,
      p_from_vehicle: null,
      p_to_customer: null,
      p_to_depot: route.depot_id,
      p_to_vehicle: null,
      p_job: null,
      p_pickup: null,
      p_delivery: null,
      p_notes: movement.note,
    });
    if (moveError) return fail(backTo, describeDbError(moveError));

    if (difference < 0) short += -difference; else over += difference;
  }

  await recordAudit(session, {
    entity: "production_batch", entityId: batch.id, action: "create",
    summary: `${batch.batch_number} counted off run ${route.code}`,
    metadata: { routeId: route.id, short, over },
  });

  revalidatePath(BACK);
  const variance = short > 0 || over > 0
    ? ` ${[short > 0 && `${short} short`, over > 0 && `${over} extra`]
      .filter(Boolean).join(" and ")} — recorded.`
    : "";
  return done(`/warehouse/${batch.id}`, `Run ${route.code} counted into batch ${batch.batch_number}.${variance}`);
}

export async function createBatch(formData: FormData): Promise<void> {
  const session = await assertCapability("warehouse.write");
  const parsed = z.object({
    depot_id: optionalUuid,
    machine: optionalText,
    notes: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const supabase = await createClient();
  const { data: batchNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "batch", p: "BATCH" });
  if (numberError) return fail(BACK, describeDbError(numberError));

  const { data, error } = await supabase
    .from("production_batches")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      operator_id: session.userId,
      depot_id: parsed.data.depot_id ?? null,
      batch_number: batchNumber as string,
      machine: parsed.data.machine ?? null,
      notes: parsed.data.notes ?? null,
    })
    .select("id, batch_number")
    .single();
  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, {
    entity: "production_batch", entityId: data.id, action: "create", summary: data.batch_number,
  });
  revalidatePath(BACK);
  return done(`/warehouse/${data.id}`, `Batch ${data.batch_number} opened.`);
}

export async function addBatchLine(formData: FormData): Promise<void> {
  const session = await assertCapability("warehouse.write");
  const parsed = z.object({
    batch_id: z.string().uuid(),
    item_id: z.string().uuid("Choose an item"),
    quantity: count.pipe(z.number().positive("Quantity must be at least 1")),
    notes: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const backTo = `/warehouse/${parsed.data.batch_id}`;

  // Always our own linen. Pickups book stock as `laundry_owned` and nothing
  // else, so offering customer-owned here only ever produced a batch drawing on
  // a pool that does not exist — a question with one wrong answer. The column
  // and its constraint stay for the day customer-owned linen is collected too.
  const supabase = await createClient();
  const { error } = await supabase.from("production_batch_lines").insert({
    tenant_id: session.tenantId,
    created_by: session.userId,
    batch_id: parsed.data.batch_id,
    item_id: parsed.data.item_id,
    owner_type: "laundry_owned",
    quantity: parsed.data.quantity,
    notes: parsed.data.notes ?? null,
  });
  if (error) return fail(backTo, describeDbError(error));

  revalidatePath(backTo);
  return done(backTo, "Line added to the batch.");
}

export async function removeBatchLine(formData: FormData): Promise<void> {
  const session = await assertCapability("warehouse.write");
  const parsed = z.object({
    id: z.string().uuid(), batch_id: z.string().uuid(),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const backTo = `/warehouse/${parsed.data.batch_id}`;
  const supabase = await createClient();
  const { error } = await supabase
    .from("production_batch_lines").delete()
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  revalidatePath(backTo);
  return done(backTo, "Line removed.");
}

/** The batch's manifest, minus anything already pulled out as a reject. */
async function processableLines(batchId: string): Promise<BatchLine[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("production_batch_lines")
    .select("id, item_id, owner_type, customer_id, quantity, rejected_quantity")
    .eq("batch_id", batchId)
    .returns<BatchLine[]>();
  return data ?? [];
}

/**
 * Move a batch on one stage (spec §7.16).
 *
 * The stage column is only the label; the real work is a movement per line, so
 * warehouse stock and the ledger can never tell different stories. The stage is
 * written *after* the movements succeed — a batch that says "drying" while its
 * stock is still in the washers is the one state worth ruling out.
 */
export async function advanceBatch(formData: FormData): Promise<void> {
  const session = await assertCapability("warehouse.write");
  const parsed = z.object({ id: z.string().uuid() }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const backTo = `/warehouse/${parsed.data.id}`;
  const supabase = await createClient();

  const { data: batch } = await supabase
    .from("production_batches")
    .select("id, batch_number, stage, depot_id")
    .eq("tenant_id", session.tenantId)
    .eq("id", parsed.data.id)
    .maybeSingle<{ id: string; batch_number: string; stage: string; depot_id: string | null }>();
  if (!batch) return fail(BACK, "That batch could not be found.");

  if (!isFlowStage(batch.stage)) {
    return fail(backTo, `A ${batch.stage} batch cannot be advanced.`);
  }

  const target = nextStage(batch.stage);
  if (!target) {
    return fail(backTo, "This batch is already ready for dispatch. Complete it instead.");
  }

  const lines = await processableLines(batch.id);
  if (lines.length === 0) return fail(backTo, "Add at least one line before starting the batch.");

  const from = STAGE_INVENTORY_STATE[batch.stage];
  const to = STAGE_INVENTORY_STATE[target];

  for (const line of lines) {
    const quantity = line.quantity - line.rejected_quantity;
    if (quantity <= 0) continue;

    const { error } = await supabase.rpc("move_inventory", {
      p_tenant: session.tenantId,
      p_item: line.item_id,
      p_owner_type: line.owner_type,
      p_quantity: quantity,
      p_from_state: from,
      p_to_state: to,
      p_reason: STAGE_MOVEMENT_REASON[target],
      p_from_customer: line.owner_type === "customer_owned" ? line.customer_id : null,
      p_from_depot: batch.depot_id,
      p_from_vehicle: null,
      p_to_customer: line.owner_type === "customer_owned" ? line.customer_id : null,
      p_to_depot: batch.depot_id,
      p_to_vehicle: null,
      p_job: null,
      p_pickup: null,
      p_delivery: null,
      p_notes: `batch ${batch.batch_number}`,
    });
    if (error) return fail(backTo, describeDbError(error));
  }

  const { error: stageError } = await supabase
    .from("production_batches")
    .update({ stage: target })
    .eq("id", batch.id).eq("tenant_id", session.tenantId);
  if (stageError) return fail(backTo, describeDbError(stageError));

  await recordAudit(session, {
    entity: "production_batch", entityId: batch.id, action: "status_change",
    summary: `${batch.stage} → ${target}`,
  });
  revalidatePath(backTo);
  return done(backTo, `Batch moved to ${target.replace(/_/g, " ")}.`);
}

/**
 * Pull damaged stock out of a batch mid-process.
 *
 * Rejects leave the line's processable quantity, so every later stage moves the
 * smaller number — the torn sheet is not washed, dried and folded on paper after
 * someone physically removed it from the trolley.
 */
export async function rejectFromBatch(formData: FormData): Promise<void> {
  const session = await assertCapability("warehouse.write");
  const parsed = z.object({
    line_id: z.string().uuid(),
    batch_id: z.string().uuid(),
    quantity: count.pipe(z.number().positive("Reject at least one item")),
    destination: z.enum(["in_repair", "damaged"]),
    notes: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const backTo = `/warehouse/${parsed.data.batch_id}`;
  const supabase = await createClient();

  const { data: batch } = await supabase
    .from("production_batches").select("id, batch_number, stage, depot_id")
    .eq("tenant_id", session.tenantId)
    .eq("id", parsed.data.batch_id)
    .maybeSingle<{ id: string; batch_number: string; stage: string; depot_id: string | null }>();
  if (!batch) return fail(BACK, "That batch could not be found.");
  if (!isFlowStage(batch.stage)) return fail(backTo, `A ${batch.stage} batch cannot be changed.`);

  const { data: line } = await supabase
    .from("production_batch_lines")
    .select("id, item_id, owner_type, customer_id, quantity, rejected_quantity")
    .eq("tenant_id", session.tenantId)
    .eq("id", parsed.data.line_id)
    .maybeSingle<BatchLine>();
  if (!line) return fail(backTo, "That batch line could not be found.");

  const remaining = line.quantity - line.rejected_quantity;
  if (parsed.data.quantity > remaining) {
    return fail(backTo, `Only ${remaining} of that line are still in the batch.`);
  }

  const destination = REJECT_DESTINATIONS.find((d) => d.value === parsed.data.destination);

  const { error: moveError } = await supabase.rpc("move_inventory", {
    p_tenant: session.tenantId,
    p_item: line.item_id,
    p_owner_type: line.owner_type,
    p_quantity: parsed.data.quantity,
    p_from_state: STAGE_INVENTORY_STATE[batch.stage],
    p_to_state: parsed.data.destination,
    p_reason: destination?.reason ?? "damage",
    p_from_customer: line.owner_type === "customer_owned" ? line.customer_id : null,
    p_from_depot: batch.depot_id,
    p_from_vehicle: null,
    p_to_customer: line.owner_type === "customer_owned" ? line.customer_id : null,
    p_to_depot: batch.depot_id,
    p_to_vehicle: null,
    p_job: null,
    p_pickup: null,
    p_delivery: null,
    p_notes: parsed.data.notes ?? `batch ${batch.batch_number}`,
  });
  if (moveError) return fail(backTo, describeDbError(moveError));

  const { error } = await supabase
    .from("production_batch_lines")
    .update({ rejected_quantity: line.rejected_quantity + parsed.data.quantity })
    .eq("id", line.id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "production_batch", entityId: batch.id, action: "update",
    summary: `${parsed.data.quantity} rejected to ${parsed.data.destination}`,
  });

  // Damaged is a write-off — stock that leaves the business. In-repair comes
  // back, so it stays a floor matter and raises nothing.
  if (parsed.data.destination === "damaged") {
    await notify(session, {
      kind: "batch_rejected",
      subjectId: batch.id,
      title: `${parsed.data.quantity} item(s) were written off as damaged from batch`
        + ` ${batch.batch_number}. Check whether the customer needs replacements.`,
      href: backTo,
    });
  }

  revalidatePath(backTo);
  return done(backTo, `${parsed.data.quantity} item(s) pulled out of the batch.`);
}

/** Closes a finished batch. The database refuses this before dispatch-ready. */
export async function completeBatch(formData: FormData): Promise<void> {
  const session = await assertCapability("warehouse.write");
  const parsed = z.object({ id: z.string().uuid() }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const backTo = `/warehouse/${parsed.data.id}`;
  const supabase = await createClient();
  const { error } = await supabase
    .from("production_batches").update({ stage: "completed" })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "production_batch", entityId: parsed.data.id, action: "status_change",
    summary: "completed",
  });
  revalidatePath(backTo);
  return done(backTo, "Batch completed. The linen is staged for dispatch.");
}

/**
 * Abandon a batch and put its stock back where it came from.
 *
 * Cancelling without returning the stock would strand it in `washing` forever,
 * so the movements run first and the stage change only lands if they do.
 */
export async function cancelBatch(formData: FormData): Promise<void> {
  const session = await assertCapability("warehouse.write");
  const parsed = z.object({
    id: z.string().uuid(),
    cancel_reason: z.string().trim().min(3, "Give a reason for cancelling"),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const backTo = `/warehouse/${parsed.data.id}`;
  const supabase = await createClient();

  const { data: batch } = await supabase
    .from("production_batches").select("id, batch_number, stage, depot_id")
    .eq("tenant_id", session.tenantId)
    .eq("id", parsed.data.id)
    .maybeSingle<{ id: string; batch_number: string; stage: string; depot_id: string | null }>();
  if (!batch) return fail(BACK, "That batch could not be found.");
  if (!isFlowStage(batch.stage)) return fail(backTo, `A ${batch.stage} batch cannot be cancelled.`);

  const from = STAGE_INVENTORY_STATE[batch.stage];

  if (from !== "at_depot") {
    for (const line of await processableLines(batch.id)) {
      const quantity = line.quantity - line.rejected_quantity;
      if (quantity <= 0) continue;

      const { error } = await supabase.rpc("move_inventory", {
        p_tenant: session.tenantId,
        p_item: line.item_id,
        p_owner_type: line.owner_type,
        p_quantity: quantity,
        p_from_state: from,
        p_to_state: "at_depot",
        p_reason: "manual",
        p_from_customer: line.owner_type === "customer_owned" ? line.customer_id : null,
        p_from_depot: batch.depot_id,
        p_from_vehicle: null,
        p_to_customer: line.owner_type === "customer_owned" ? line.customer_id : null,
        p_to_depot: batch.depot_id,
        p_to_vehicle: null,
        p_job: null,
        p_pickup: null,
        p_delivery: null,
        p_notes: `batch ${batch.batch_number} cancelled`,
      });
      if (error) return fail(backTo, describeDbError(error));
    }
  }

  const { error } = await supabase
    .from("production_batches")
    .update({ stage: "cancelled", cancel_reason: parsed.data.cancel_reason })
    .eq("id", batch.id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "production_batch", entityId: batch.id, action: "status_change",
    summary: `cancelled: ${parsed.data.cancel_reason}`,
  });
  revalidatePath(backTo);
  return done(backTo, "Batch cancelled and its linen returned to the depot.");
}
