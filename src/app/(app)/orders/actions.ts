"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { recordAudit } from "@/lib/audit";
import {
  checkbox, describeDbError, done, fail, firstIssue,
  optionalDate, optionalText, optionalUuid, returnTo, toObject,
} from "@/lib/actions";
import { parseOrderItems } from "./order-items";
import {
  DELIVERY_WINDOWS, ORDER_PRIORITIES, ORDER_STATUS_LABELS, RECEIVED_VIA,
  STAGE_CONTROLS, capabilitiesForMove, checkTransition, isOrderStatus,
  leavesTheRound, receivedInstant, validateItem,
  type OrderItemInput, type OrderStatus,
} from "@/lib/domain/laundry-orders";
import { businessToday, isClockTime, toInstant } from "@/lib/domain/timezone";
import { logOrderActivity } from "@/lib/orders/activity";
import { completeLaundryOrder } from "@/lib/orders/complete";
import { retireStopIfEmpty } from "@/lib/runs/assign";

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

const orderSchema = z.object({
  customer_id: z.string().uuid("Please select a customer."),
  received_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Please select a valid date."),
  // No `received_time`: the form does not ask for it, so requiring one here
  // would refuse every post from it. The time of day is stamped server-side —
  // see `receivedInstant`. The enum stays the full column set rather than the
  // two the form offers, so a job holding a legacy value can still be edited.
  received_via: z.enum(RECEIVED_VIA),
  pickup_date: optionalDate,
  // No `pickup_time`. The form no longer asks for it and nothing reads it, so
  // accepting one here would be a field the schema still required a caller to
  // understand. The column stays, nullable, holding what history put in it.
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

/**
 * Only the fields the database column set actually holds, ready to write.
 *
 * `receivedAt` is passed in rather than composed here: creating stamps the
 * current time, editing keeps the time already on the job, and only the caller
 * knows which of the two it is.
 */
function toRow(input: OrderInput, deliveryAddress: string | null, receivedAt: string) {
  const delivery = input.delivery_required;
  return {
    customer_id: input.customer_id,
    received_at: receivedAt,
    received_via: input.received_via,
    // Pickup details only mean anything on a driver collection; carrying them
    // over from a changed answer would leave a drop-off claiming a driver.
    pickup_date: input.received_via === "driver_pickup" ? input.pickup_date ?? null : null,
    // `pickup_time` is deliberately absent from every write. It is out of the
    // workflow, and a legacy value left on a historical row is invisible rather
    // than wrong — which is a better trade than a destructive migration.
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
  tenantId: string,
  input: OrderInput,
): Promise<string | null> {
  if (!input.delivery_required) return null;
  if (input.use_custom_address) return input.delivery_address ?? null;

  const { data: location } = await supabase
    .from("customer_locations")
    .select("address_line1, suburb, state, postcode, is_primary")
    .eq("tenant_id", tenantId)
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
    .eq("tenant_id", tenantId)
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

/**
 * Where a rejected post goes back to, carrying the customer already chosen.
 *
 * A failure redirects — that is the flash-cookie convention — so the form is
 * re-rendered by the server and anything held only in the browser is gone. The
 * customer is the one answer that costs a search to give again, and the form
 * already reads `?customer=` (it is how the quick-create returns), so the same
 * door is used rather than a second mechanism. The id is re-validated here
 * because it came off a form: only a well-formed uuid is ever put in the URL.
 */
function backWithCustomer(path: string, formData: FormData): string {
  const posted = formData.get("customer_id");
  if (typeof posted !== "string" || !z.string().uuid().safeParse(posted).success) return path;
  const [base, existing] = path.split("?");
  const query = new URLSearchParams(existing);
  query.set("customer", posted);
  return `${base}?${query.toString()}`;
}

/** The job as it is now, with the two facts every guard here needs. */
async function loadOrder(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
): Promise<
  {
    id: string; order_number: string; status: OrderStatus; delivery_required: boolean;
    received_at: string;
    /** The round's call this job is riding on, so a move back into the plant can tidy it up. */
    stop_id: string | null;
  } | null
> {
  const { data } = await supabase
    .from("laundry_orders")
    .select("id, order_number, status, delivery_required, received_at, stop_id")
    .eq("id", id)
    .maybeSingle<{
      id: string; order_number: string; status: string;
      delivery_required: boolean; received_at: string; stop_id: string | null;
    }>();
  if (!data || !isOrderStatus(data.status)) return null;
  return { ...data, status: data.status };
}

/* ----------------------------------------------------------------- create */

export async function createOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.write");
  const backTo = returnTo(formData, "/orders/new");
  // Every rejection below comes back with the customer still chosen; the one
  // exception is the customer itself being unusable, which is handled there.
  const backToForm = backWithCustomer(backTo, formData);

  const parsed = orderSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(backToForm, firstIssue(parsed.error));

  const parsedItems = parseOrderItems(formData.get("items"));
  if (!parsedItems.ok) return fail(backToForm, parsedItems.problem);
  const items = parsedItems.items;

  const problem = crossFieldProblem(parsed.data, items);
  if (problem) return fail(backToForm, problem);

  // Backdating a receipt changes what the day's takings and the overdue list
  // say, so it is a supervisor's action rather than a counter one.
  if (parsed.data.received_date < businessToday()
      && !can(session.role, "orders.manage")) {
    return fail(backToForm, "Only a manager can record a job as received on an earlier day.");
  }

  const supabase = await createClient();

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id, business_name, depot_id")
    // **This laundry's customer.** RLS says so for ten of the eleven roles and
    // does not for a platform admin (0019), so without this a job could be
    // raised in one business against a customer of another — which is how
    // LJ00001 came to exist and could then never be given a driver.
    .eq("tenant_id", session.tenantId)
    .eq("id", parsed.data.customer_id)
    .is("deleted_at", null)
    .maybeSingle<{ id: string; business_name: string; depot_id: string | null }>();
  if (customerError) return fail(backToForm, describeDbError(customerError));
  if (!customer) {
    // Deliberately *without* the customer: carrying an id the database will not
    // stand behind would re-open the form still claiming that selection.
    return fail(backTo, "That customer could not be found — please select one from the list.");
  }

  const deliveryAddress = await resolveDeliveryAddress(supabase, session.tenantId, parsed.data);

  // Sequential and allocated in Postgres, so two people taking laundry in at the
  // same moment cannot be handed the same number.
  const { data: orderNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "laundry_order", p: "LJ" });
  if (numberError) return fail(backToForm, describeDbError(numberError));

  const { data: order, error } = await supabase
    .from("laundry_orders")
    .insert({
      ...toRow(parsed.data, deliveryAddress, receivedInstant(parsed.data.received_date)),
      tenant_id: session.tenantId,
      depot_id: session.depotId ?? customer.depot_id,
      created_by: session.userId,
      // Drawn above and, until now, thrown away: the column is `not null` with
      // no default, so every single insert died on the constraint instead.
      order_number: orderNumber as string,
      status: "new",
    })
    .select("id, order_number")
    .single();
  if (error) return fail(backToForm, describeDbError(error));

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
    return fail(backToForm, describeDbError(itemsError));
  }

  await logOrderActivity(supabase, session, order.id, {
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
  const backTo = backWithCustomer(`/orders/${id.data}/edit`, formData);

  const parsed = orderSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(backTo, firstIssue(parsed.error));

  const parsedItems = parseOrderItems(formData.get("items"));
  if (!parsedItems.ok) return fail(backTo, parsedItems.problem);
  const items = parsedItems.items;

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

  // The customer is posted by the form and written back, so an edit is another
  // door onto the same mistake creation had: `.eq("tenant_id")` because RLS does
  // not narrow a platform admin to one laundry (0019).
  const { data: customer } = await supabase
    .from("customers").select("id")
    .eq("tenant_id", session.tenantId)
    .eq("id", parsed.data.customer_id)
    .is("deleted_at", null)
    .maybeSingle<{ id: string }>();
  if (!customer) {
    return fail(`/orders/${id.data}/edit`,
      "That customer could not be found — please select one from the list.");
  }

  const deliveryAddress = await resolveDeliveryAddress(supabase, session.tenantId, parsed.data);
  // The stored time of day is carried over, so correcting the received *date*
  // does not move an 8am drop-off to whenever the correction was made.
  const row = toRow(
    parsed.data, deliveryAddress,
    receivedInstant(parsed.data.received_date, existing.received_at),
  );

  const { data: before } = await supabase
    .from("laundry_orders")
    .select(
      "priority, assigned_to, delivery_required, expected_delivery_date, " +
      "expected_collection_date, delivery_address, received_at",
    )
    .eq("tenant_id", session.tenantId)
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

  await logOrderActivity(supabase, session, id.data, {
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
 * The plain status moves, which since the status track landed means **any stage
 * this job can be at**, in either direction — not just the next one.
 *
 * Two targets are still refused here and are not an oversight. `completed`
 * records who handed the laundry over and when, so it belongs to `completeOrder`
 * and can never be reached by posting `status=completed` at this action;
 * `assigned` captures a round and a delivery date, so it belongs to
 * `assignJobToDriver` and posting it here would create exactly the row the
 * constraints forbid — an Assigned job with no assignment. `cancelled` likewise
 * carries a reason.
 *
 * Everything else is `checkTransition`'s to decide, and it is the same rule the
 * track drew the step with and the same rule `guard_laundry_order_transition`
 * enforces underneath. The button is a courtesy; this and the trigger are the
 * boundary.
 */
export async function advanceOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.status");
  const parsed = statusSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(LIST, firstIssue(parsed.error));

  const target = parsed.data.status as OrderStatus;
  const detail = `/orders/${parsed.data.id}`;
  if (STAGE_CONTROLS[target].via !== "jump") {
    return fail(detail, STAGE_CONTROLS[target].where
      ?? "Use the delivery, collection or cancel action for that step.");
  }

  const supabase = await createClient();
  const existing = await loadOrder(supabase, parsed.data.id);
  if (!existing) return fail(LIST, "That job could not be found.");

  const allowed = checkTransition(existing.status, target, existing.delivery_required);
  if (!allowed.ok) return fail(detail, allowed.reason);

  // Who may make *this* move, source and target together — the second half is
  // what stops the status control being a back door around Remove Assignment.
  // Sending a job out is a management override of the round's own Start Route;
  // pulling one back off a round un-books a call somebody planned. Checked here
  // as well as drawn on the track, because the step is a courtesy and this is
  // the guard.
  for (const capability of capabilitiesForMove(existing.status, target)) {
    if (can(session.role, capability)) continue;
    if (capability === "orders.manage") {
      return fail(detail,
        "Jobs go out when the round starts its route. Ask a manager if this one needs "
        + "sending out from the office.");
    }
    return fail(detail,
      "Taking this job off its round un-books a call somebody planned, so your role cannot "
      + `move it to ${ORDER_STATUS_LABELS[target].toLowerCase()}. Ask dispatch, or use `
      + "Remove Assignment on the job's Delivery card.");
  }

  // A job pulled back into the plant leaves its call on the round, and a run
  // that has lost its second stop must not read 1, 3, 4 on the round's phone —
  // so the same tidy-up Remove Assignment does runs here, from the same helper.
  // Read before the write, because the trigger clears `stop_id` with it.
  const offTheRound = leavesTheRound(existing.status, target);
  const strandedStop = offTheRound ? existing.stop_id : null;

  const { error } = await supabase
    .from("laundry_orders")
    .update({ status: target })
    .eq("id", parsed.data.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(detail, describeDbError(error));

  if (strandedStop) await retireStopIfEmpty(supabase, session, strandedStop);

  await logOrderActivity(supabase, session, parsed.data.id, {
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
  // A status move can now take a job off a round, so the round's own day and the
  // driver's copy of the job are stale as well. Same set `removeJobAssignment`
  // refreshes, for the same reason.
  if (offTheRound) {
    revalidatePath("/my-runs");
    revalidatePath(`/my-runs/jobs/${parsed.data.id}`);
  }
  return done(detail,
    `Job ${existing.order_number} is now ${ORDER_STATUS_LABELS[target].toLowerCase()}.`);
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

  // The write itself lives in `lib/orders/complete.ts`, shared with the driver's
  // own "mark delivered" on My Runs — one implementation of finishing a job,
  // two guards in front of it. `dispatchIfNeeded` is deliberately not passed
  // here: at the counter, a delivery job still sitting at "ready" means somebody
  // forgot to record that the van left, and that is worth being told about.
  const result = await completeLaundryOrder(supabase, session, existing, {
    at: toInstant(parsed.data.completed_date, parsed.data.completed_time),
    handledBy: parsed.data.handled_by,
    note: parsed.data.note ?? null,
  });
  if (!result.ok) return fail(detail, result.error);
  const { delivered } = result;

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

  await logOrderActivity(supabase, session, parsed.data.id, {
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
    .from("laundry_orders").select("assigned_to")
    .eq("tenant_id", session.tenantId)
    .eq("id", parsed.data.id)
    .maybeSingle<{ assigned_to: string | null }>();

  const { error } = await supabase
    .from("laundry_orders")
    .update({ assigned_to: parsed.data.assigned_to ?? null })
    .eq("id", parsed.data.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(detail, describeDbError(error));

  await logOrderActivity(supabase, session, parsed.data.id, {
    activity_type: "assigned",
    previous: { assigned_to: before?.assigned_to ?? null },
    next: { assigned_to: parsed.data.assigned_to ?? null },
  });

  revalidatePath(detail);
  return done(detail, parsed.data.assigned_to ? "Job reassigned." : "Job unassigned.");
}
