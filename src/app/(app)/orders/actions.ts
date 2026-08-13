"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { recordAudit } from "@/lib/audit";
import {
  checkbox, describeDbError, done, fail, firstIssue,
  optionalDate, optionalText, optionalUuid, returnTo, toObject,
} from "@/lib/actions";
import {
  DELIVERY_WINDOWS, ORDER_PRIORITIES, RECEIVED_VIA,
  checkTransition, isBlankItem, isOrderStatus, validateItem,
  type OrderItemInput, type OrderStatus,
} from "@/lib/domain/laundry-orders";
import { businessToday, isClockTime, toInstant } from "@/lib/domain/timezone";

/**
 * Writes for the laundry-jobs module.
 *
 * Same shape as every other action file here: derive the tenant from the
 * session, validate with Zod, `return fail(...)` / `return done(...)` so the
 * message rides the flash cookie and TypeScript can narrow after the call.
 *
 * Two rules are specific to this module and worth stating once:
 *
 * - **Nothing is deleted.** A job that should not have been taken is cancelled,
 *   with a reason and a timestamp, and keeps its items and its whole timeline.
 * - **Every material change writes an activity row** in the same call that made
 *   it, so the timeline on the job page is a record of what happened rather than
 *   a reconstruction from column values.
 */

const LIST = "/orders";

/* ------------------------------------------------------------- validation */

/** A clock time from `<input type="time">`, absent when the field was left blank. */
const optionalTime = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().refine(isClockTime, "Use the time picker").optional(),
);

const requiredTime = z.string().refine(isClockTime, "Use the time picker");

/** A count that may legitimately be absent — distinct from `count`, which is 0. */
const optionalCount = z.preprocess(
  (value) => {
    if (value === "" || value === null || value === undefined) return undefined;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  },
  z.number().int("Whole numbers only").min(1, "Must be at least 1").optional(),
);

const itemSchema = z.object({
  item_type: z.string(),
  custom_description: optionalText,
  quantity_type: z.string(),
  exact_quantity: optionalCount,
  bag_count: optionalCount,
  estimated_quantity: optionalCount,
  notes: optionalText,
});

/**
 * The items arrive as JSON in one hidden field — the compose-locally, commit-once
 * shape the dispatch planner and the contract wizard already use. Malformed JSON
 * is treated as "no items", which the caller then rejects with the same sentence
 * an empty list gets; there is no reading of a half-parsed laundry list.
 */
const itemsField = z.preprocess((value) => {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}, z.array(itemSchema).max(40, "That is more laundry items than one job can hold."));

const orderSchema = z.object({
  customer_id: z.string().uuid("Please select a customer."),
  received_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Please select a valid date."),
  received_time: requiredTime,
  received_via: z.enum(RECEIVED_VIA),
  pickup_date: optionalDate,
  pickup_time: optionalTime,
  pickup_driver_id: optionalUuid,
  delivery_required: checkbox,
  expected_delivery_date: optionalDate,
  expected_collection_date: optionalDate,
  delivery_window: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.enum(DELIVERY_WINDOWS).optional(),
  ),
  expected_delivery_time: optionalTime,
  use_custom_address: checkbox,
  delivery_address: optionalText,
  delivery_instructions: optionalText,
  special_instructions: optionalText,
  priority: z.enum(ORDER_PRIORITIES),
  assigned_to: optionalUuid,
});

type OrderInput = z.infer<typeof orderSchema>;

/**
 * The rules a single field cannot state on its own, each phrased as the sentence
 * the person at the counter should read. Returns the first problem, or null.
 */
function crossFieldProblem(input: OrderInput, items: OrderItemInput[]): string | null {
  if (items.length === 0) return "Please add at least one laundry item.";
  for (const [index, item] of items.entries()) {
    const problem = validateItem(item, index + 1);
    if (problem) return problem;
  }

  if (input.delivery_required) {
    if (!input.expected_delivery_date) return "Please select an expected delivery date.";
    if (input.expected_delivery_date < input.received_date) {
      return "The expected delivery date cannot be before the laundry arrived.";
    }
    if (input.delivery_window === "specific_time" && !input.expected_delivery_time) {
      return "Please choose the delivery time, or pick a wider window.";
    }
    if (input.use_custom_address && !input.delivery_address) {
      return "Please enter a delivery address for this job.";
    }
  } else if (input.expected_collection_date && input.expected_collection_date < input.received_date) {
    return "The expected collection date cannot be before the laundry arrived.";
  }

  if (input.received_via === "driver_pickup"
      && input.pickup_date && input.pickup_date > input.received_date) {
    return "The driver cannot have collected the laundry after it was received.";
  }
  return null;
}

/** Drop the blank rows the form always carries, keep the rest in order. */
function itemsFrom(formData: FormData): OrderItemInput[] {
  const parsed = itemsField.safeParse(formData.get("items"));
  if (!parsed.success) return [];
  return parsed.data
    .map((item) => ({
      item_type: item.item_type,
      custom_description: item.custom_description ?? null,
      quantity_type: item.quantity_type,
      exact_quantity: item.exact_quantity ?? null,
      bag_count: item.bag_count ?? null,
      estimated_quantity: item.estimated_quantity ?? null,
      notes: item.notes ?? null,
    }))
    .filter((item) => !isBlankItem(item));
}

/** Only the fields the database column set actually holds, ready to write. */
function toRow(input: OrderInput, deliveryAddress: string | null) {
  const delivery = input.delivery_required;
  return {
    customer_id: input.customer_id,
    received_at: toInstant(input.received_date, input.received_time),
    received_via: input.received_via,
    // Pickup details only mean anything on a driver collection; carrying them
    // over from a changed answer would leave a drop-off claiming a driver.
    pickup_date: input.received_via === "driver_pickup" ? input.pickup_date ?? null : null,
    pickup_time: input.received_via === "driver_pickup" ? input.pickup_time ?? null : null,
    pickup_driver_id: input.received_via === "driver_pickup" ? input.pickup_driver_id ?? null : null,
    delivery_required: delivery,
    expected_delivery_date: delivery ? input.expected_delivery_date ?? null : null,
    expected_collection_date: delivery ? null : input.expected_collection_date ?? null,
    delivery_window: delivery ? input.delivery_window ?? null : null,
    expected_delivery_time:
      delivery && input.delivery_window === "specific_time"
        ? input.expected_delivery_time ?? null
        : null,
    delivery_address_source: delivery && input.use_custom_address ? "custom" : "customer",
    delivery_address: delivery ? deliveryAddress : null,
    delivery_instructions: delivery ? input.delivery_instructions ?? null : null,
    special_instructions: input.special_instructions ?? null,
    priority: input.priority,
    assigned_to: input.assigned_to ?? null,
  };
}

/**
 * The address this job was taken to, frozen at write time.
 *
 * A one-off address is taken as typed. Otherwise the customer's current delivery
 * address is *copied* — read once here and stored — so that a customer who moves
 * next year does not rewrite where last year's linen actually went. That copy is
 * the only customer data this module duplicates, and it is duplicated on purpose.
 */
async function resolveDeliveryAddress(
  supabase: Awaited<ReturnType<typeof createClient>>,
  input: OrderInput,
): Promise<string | null> {
  if (!input.delivery_required) return null;
  if (input.use_custom_address) return input.delivery_address ?? null;

  const { data: location } = await supabase
    .from("customer_locations")
    .select("address_line1, suburb, state, postcode, is_primary")
    .eq("customer_id", input.customer_id)
    .eq("is_delivery", true)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle<{
      address_line1: string | null; suburb: string | null;
      state: string | null; postcode: string | null;
    }>();

  const fromSite = [location?.address_line1, location?.suburb, location?.state, location?.postcode]
    .filter(Boolean).join(", ");
  if (fromSite) return fromSite;

  // No delivery site on file — fall back to the billing address rather than
  // storing nothing, so the run sheet still has somewhere to go.
  const { data: customer } = await supabase
    .from("customers")
    .select("billing_address_line1, billing_suburb, billing_state, billing_postcode")
    .eq("id", input.customer_id)
    .maybeSingle<{
      billing_address_line1: string | null; billing_suburb: string | null;
      billing_state: string | null; billing_postcode: string | null;
    }>();

  const billing = [
    customer?.billing_address_line1, customer?.billing_suburb,
    customer?.billing_state, customer?.billing_postcode,
  ].filter(Boolean).join(", ");
  return billing || null;
}

/* -------------------------------------------------------------- activity */

type ActivityEntry = {
  activity_type:
    | "created" | "status_changed" | "updated" | "items_changed"
    | "assigned" | "delivered" | "collected" | "cancelled";
  previous?: Record<string, unknown> | null;
  next?: Record<string, unknown> | null;
  note?: string | null;
};

/**
 * One line of the job's timeline, written beside the change that caused it.
 *
 * Failures are logged and swallowed, exactly as `recordAudit()` does: a job that
 * was delivered must not report itself as failed because the note about it could
 * not be written. The audit log remains the tamper-evident record; this is the
 * human-readable one on the page.
 */
async function logActivity(
  supabase: Awaited<ReturnType<typeof createClient>>,
  session: Session,
  orderId: string,
  entry: ActivityEntry,
): Promise<void> {
  try {
    const { error } = await supabase.from("laundry_order_activity").insert({
      tenant_id: session.tenantId,
      order_id: orderId,
      actor_id: session.userId,
      activity_type: entry.activity_type,
      previous_value: entry.previous ?? null,
      new_value: entry.next ?? null,
      note: entry.note ?? null,
    });
    if (error) console.error("job activity insert failed", { orderId, error: error.message });
  } catch (cause) {
    console.error("job activity insert threw", cause);
  }
}

/** The job as it is now, with the two facts every guard here needs. */
async function loadOrder(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
): Promise<{ id: string; order_number: string; status: OrderStatus; delivery_required: boolean } | null> {
  const { data } = await supabase
    .from("laundry_orders")
    .select("id, order_number, status, delivery_required")
    .eq("id", id)
    .maybeSingle<{ id: string; order_number: string; status: string; delivery_required: boolean }>();
  if (!data || !isOrderStatus(data.status)) return null;
  return { ...data, status: data.status };
}

/* ----------------------------------------------------------------- create */

export async function createOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.write");
  const backTo = returnTo(formData, "/orders/new");

  const parsed = orderSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const items = itemsFrom(formData);
  const problem = crossFieldProblem(parsed.data, items);
  if (problem) return fail(backTo, problem);

  // Backdating a receipt changes what the day's takings and the overdue list
  // say, so it is a supervisor's action rather than a counter one.
  if (parsed.data.received_date < businessToday()
      && !can(session.role, "orders.manage")) {
    return fail(backTo, "Only a manager can record a job as received on an earlier day.");
  }

  const supabase = await createClient();

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id, business_name, depot_id")
    .eq("id", parsed.data.customer_id)
    .is("deleted_at", null)
    .maybeSingle<{ id: string; business_name: string; depot_id: string | null }>();
  if (customerError) return fail(backTo, describeDbError(customerError));
  if (!customer) {
    return fail(backTo, "That customer could not be found — please select one from the list.");
  }

  const deliveryAddress = await resolveDeliveryAddress(supabase, parsed.data);

  // Sequential and allocated in Postgres, so two people taking laundry in at the
  // same moment cannot be handed the same number.
  const { data: orderNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "laundry_order", p: "LJ" });
  if (numberError) return fail(backTo, describeDbError(numberError));

  const { data: order, error } = await supabase
    .from("laundry_orders")
    .insert({
      ...toRow(parsed.data, deliveryAddress),
      tenant_id: session.tenantId,
      depot_id: session.depotId ?? customer.depot_id,
      created_by: session.userId,
      status: "new",
    })
    .select("id, order_number")
    .single();
  if (error) return fail(backTo, describeDbError(error));

  // One transaction inside Postgres — see save_laundry_order_items in 0014.
  const { error: itemsError } = await supabase
    .rpc("save_laundry_order_items", { p_order_id: order.id, p_items: items });
  if (itemsError) {
    // The job is one statement old and nothing can reference it yet, so the
    // honest outcome is that it never existed rather than an empty job sitting
    // in the list. If even the cleanup fails, say so plainly and link to it.
    const { error: cleanupError } = await supabase
      .from("laundry_orders").delete().eq("id", order.id).eq("tenant_id", session.tenantId);
    if (cleanupError) {
      return fail(`/orders/${order.id}`,
        `Job ${order.order_number} was created but its laundry list could not be saved: ${describeDbError(itemsError)}`);
    }
    return fail(backTo, describeDbError(itemsError));
  }

  await logActivity(supabase, session, order.id, {
    activity_type: "created",
    next: {
      status: "new",
      items: items.length,
      delivery_required: parsed.data.delivery_required,
      priority: parsed.data.priority,
    },
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: order.id, action: "create",
    summary: `${order.order_number} ${customer.business_name}`,
  });

  revalidatePath(LIST);
  return done(`/orders/${order.id}`, `Job ${order.order_number} created.`);
}

/* ----------------------------------------------------------------- update */

export async function updateOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail(LIST, "That job could not be found.");
  const backTo = `/orders/${id.data}/edit`;

  const parsed = orderSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const items = itemsFrom(formData);
  const problem = crossFieldProblem(parsed.data, items);
  if (problem) return fail(backTo, problem);

  const supabase = await createClient();
  const existing = await loadOrder(supabase, id.data);
  if (!existing) return fail(LIST, "That job could not be found.");

  if (existing.status === "cancelled") {
    return fail(`/orders/${id.data}`, "This job was cancelled, so it can no longer be edited.");
  }
  // A completed job is the record of work already handed over. It stays editable
  // — a wrong quantity found afterwards is real — but only for the role that
  // carries that kind of correction.
  if (existing.status === "completed" && !can(session.role, "orders.manage")) {
    return fail(`/orders/${id.data}`,
      "This job is completed. Ask a manager if something recorded on it needs correcting.");
  }
  if (parsed.data.received_date < businessToday() && !can(session.role, "orders.manage")) {
    return fail(backTo, "Only a manager can move a job's received date to an earlier day.");
  }
  // Changing the workflow under a job that has already been dispatched would
  // leave it in a state its own status does not allow.
  if (!parsed.data.delivery_required && existing.status === "out_for_delivery") {
    return fail(backTo, "This job is already out for delivery, so it cannot become a customer pickup.");
  }

  const deliveryAddress = await resolveDeliveryAddress(supabase, parsed.data);
  const row = toRow(parsed.data, deliveryAddress);

  const { data: before } = await supabase
    .from("laundry_orders")
    .select(
      "priority, assigned_to, delivery_required, expected_delivery_date, " +
      "expected_collection_date, delivery_address, received_at",
    )
    .eq("id", id.data)
    .maybeSingle<Record<string, unknown>>();

  const { error } = await supabase
    .from("laundry_orders")
    .update(row)
    .eq("id", id.data)
    // RLS already scopes this; the filter states the intent, as elsewhere.
    .eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  const { error: itemsError } = await supabase
    .rpc("save_laundry_order_items", { p_order_id: id.data, p_items: items });
  // The item swap is atomic in Postgres, so a failure here leaves the previous
  // laundry list exactly as it was — the parent edit is what is now ahead of it.
  if (itemsError) {
    return fail(backTo,
      `The job details were saved but the laundry list was not: ${describeDbError(itemsError)}`);
  }

  await logActivity(supabase, session, id.data, {
    activity_type: "updated",
    previous: before ?? null,
    next: {
      priority: row.priority,
      assigned_to: row.assigned_to,
      delivery_required: row.delivery_required,
      expected_delivery_date: row.expected_delivery_date,
      expected_collection_date: row.expected_collection_date,
      delivery_address: row.delivery_address,
      received_at: row.received_at,
      items: items.length,
    },
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: id.data, action: "update",
    summary: existing.order_number,
  });

  revalidatePath(LIST);
  revalidatePath(`/orders/${id.data}`);
  return done(`/orders/${id.data}`, `Job ${existing.order_number} updated.`);
}

/* ----------------------------------------------------------- status moves */

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.string().refine(isOrderStatus, "That is not a job status."),
  note: optionalText,
});

/**
 * The three plain moves: in progress, ready, out for delivery.
 *
 * Completion and cancellation are not here — both capture more than a status and
 * live in their own actions below, so that "mark delivered" can never be reached
 * by posting `status=completed` at this one.
 */
export async function advanceOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.status");
  const parsed = statusSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(LIST, firstIssue(parsed.error));

  const target = parsed.data.status as OrderStatus;
  const detail = `/orders/${parsed.data.id}`;
  if (target === "completed" || target === "cancelled") {
    return fail(detail, "Use the delivery, collection or cancel action for that step.");
  }

  const supabase = await createClient();
  const existing = await loadOrder(supabase, parsed.data.id);
  if (!existing) return fail(LIST, "That job could not be found.");

  const allowed = checkTransition(existing.status, target, existing.delivery_required);
  if (!allowed.ok) return fail(detail, allowed.reason);

  const { error } = await supabase
    .from("laundry_orders")
    .update({ status: target })
    .eq("id", parsed.data.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(detail, describeDbError(error));

  await logActivity(supabase, session, parsed.data.id, {
    activity_type: "status_changed",
    previous: { status: existing.status },
    next: { status: target },
    note: parsed.data.note ?? null,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: parsed.data.id, action: "status_change",
    summary: `${existing.order_number}: ${existing.status} → ${target}`,
  });

  revalidatePath(LIST);
  revalidatePath(detail);
  return done(detail, `Job ${existing.order_number} is now ${target.replace(/_/g, " ")}.`);
}

/* ------------------------------------------------------------- completion */

const completionSchema = z.object({
  id: z.string().uuid(),
  completed_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Please select a valid date."),
  completed_time: requiredTime,
  handled_by: z.string().uuid("Please choose who handled it."),
  note: optionalText,
});

/**
 * "Marked as delivered" and "marked as collected" are the same transition told
 * from the two ends of the job, so they share one action and differ only in
 * which columns they stamp. Which one is legal is decided by the job's own
 * `delivery_required`, never by which button was pressed.
 */
export async function completeOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.status");
  const parsed = completionSchema.safeParse(toObject(formData));
  if (!parsed.success) {
    const id = formData.get("id");
    return fail(typeof id === "string" ? `/orders/${id}` : LIST, firstIssue(parsed.error));
  }
  const detail = `/orders/${parsed.data.id}`;

  const supabase = await createClient();
  const existing = await loadOrder(supabase, parsed.data.id);
  if (!existing) return fail(LIST, "That job could not be found.");

  const allowed = checkTransition(existing.status, "completed", existing.delivery_required);
  if (!allowed.ok) return fail(detail, allowed.reason);

  const at = toInstant(parsed.data.completed_date, parsed.data.completed_time);
  const delivered = existing.delivery_required;

  const { error } = await supabase
    .from("laundry_orders")
    .update({
      status: "completed",
      completed_at: at,
      ...(delivered
        ? { delivered_at: at, delivered_by: parsed.data.handled_by }
        : { collected_at: at, collected_by: parsed.data.handled_by }),
    })
    .eq("id", parsed.data.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(detail, describeDbError(error));

  await logActivity(supabase, session, parsed.data.id, {
    activity_type: delivered ? "delivered" : "collected",
    previous: { status: existing.status },
    next: { status: "completed", at, by: parsed.data.handled_by },
    note: parsed.data.note ?? null,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: parsed.data.id, action: "status_change",
    summary: `${existing.order_number} ${delivered ? "delivered" : "collected"}`,
  });

  revalidatePath(LIST);
  revalidatePath(detail);
  return done(detail,
    `Job ${existing.order_number} ${delivered ? "delivered" : "collected"} and completed.`);
}

/* ---------------------------------------------------------------- cancel */

export async function cancelOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.manage");
  const parsed = z.object({
    id: z.string().uuid(),
    cancellation_reason: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(LIST, firstIssue(parsed.error));
  const detail = `/orders/${parsed.data.id}`;

  const supabase = await createClient();
  const existing = await loadOrder(supabase, parsed.data.id);
  if (!existing) return fail(LIST, "That job could not be found.");

  const allowed = checkTransition(existing.status, "cancelled", existing.delivery_required);
  if (!allowed.ok) return fail(detail, allowed.reason);

  // The row stays, with everything on it. Cancelling is a state, not a delete.
  const { error } = await supabase
    .from("laundry_orders")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancellation_reason: parsed.data.cancellation_reason ?? null,
    })
    .eq("id", parsed.data.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(detail, describeDbError(error));

  await logActivity(supabase, session, parsed.data.id, {
    activity_type: "cancelled",
    previous: { status: existing.status },
    next: { status: "cancelled" },
    note: parsed.data.cancellation_reason ?? null,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: parsed.data.id, action: "status_change",
    summary: `${existing.order_number} cancelled`,
  });

  revalidatePath(LIST);
  revalidatePath(detail);
  return done(detail, `Job ${existing.order_number} cancelled. Nothing was deleted.`);
}

/* -------------------------------------------------------------- assignment */

/** The one-field version of the edit form, for handing a job to someone. */
export async function assignOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.write");
  const parsed = z.object({
    id: z.string().uuid(),
    assigned_to: optionalUuid,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(LIST, firstIssue(parsed.error));
  const detail = `/orders/${parsed.data.id}`;

  const supabase = await createClient();
  const existing = await loadOrder(supabase, parsed.data.id);
  if (!existing) return fail(LIST, "That job could not be found.");
  if (existing.status === "cancelled") {
    return fail(detail, "This job was cancelled, so it cannot be assigned.");
  }

  const { data: before } = await supabase
    .from("laundry_orders").select("assigned_to").eq("id", parsed.data.id)
    .maybeSingle<{ assigned_to: string | null }>();

  const { error } = await supabase
    .from("laundry_orders")
    .update({ assigned_to: parsed.data.assigned_to ?? null })
    .eq("id", parsed.data.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(detail, describeDbError(error));

  await logActivity(supabase, session, parsed.data.id, {
    activity_type: "assigned",
    previous: { assigned_to: before?.assigned_to ?? null },
    next: { assigned_to: parsed.data.assigned_to ?? null },
  });

  revalidatePath(detail);
  return done(detail, parsed.data.assigned_to ? "Job reassigned." : "Job unassigned.");
}
