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
  DELIVERY_WINDOWS, ORDER_PRIORITIES, RECEIVED_VIA,
  checkTransition, isOrderStatus, receivedInstant, validateItem,
  type OrderItemInput, type OrderStatus,
} from "@/lib/domain/laundry-orders";
import { businessToday, isClockTime, toInstant } from "@/lib/domain/timezone";
import { logOrderActivity } from "@/lib/orders/activity";
import { completeLaundryOrder } from "@/lib/orders/complete";

const LIST = "/orders";

const optionalTime = z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().refine(isClockTime, "Use the time picker").optional());
const requiredTime = z.string().refine(isClockTime, "Use the time picker");
const orderSchema = z.object({
  customer_id: z.string().uuid("Please select a customer."),
  received_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Please select a valid date."),
  received_via: z.enum(RECEIVED_VIA),
  pickup_date: optionalDate,
  pickup_driver_id: optionalUuid,
  delivery_required: checkbox,
  expected_delivery_date: optionalDate,
  expected_collection_date: optionalDate,
  delivery_window: z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.enum(DELIVERY_WINDOWS).optional()),
  expected_delivery_time: optionalTime,
  use_custom_address: checkbox,
  delivery_address: optionalText,
  delivery_instructions: optionalText,
  special_instructions: optionalText,
  priority: z.enum(ORDER_PRIORITIES),
  assigned_to: optionalUuid,
});
type OrderInput = z.infer<typeof orderSchema>;

function crossFieldProblem(input: OrderInput, items: OrderItemInput[]): string | null {
  if (items.length === 0) return "Please add at least one laundry item.";
  for (const [index, item] of items.entries()) {
    const problem = validateItem(item, index + 1);
    if (problem) return problem;
  }
  if (input.delivery_required) {
    if (!input.expected_delivery_date) return "Please select an expected delivery date.";
    if (input.expected_delivery_date < input.received_date) return "The expected delivery date cannot be before the laundry arrived.";
    if (input.delivery_window === "specific_time" && !input.expected_delivery_time) return "Please choose the delivery time, or pick a wider window.";
    if (input.use_custom_address && !input.delivery_address) return "Please enter a delivery address for this job.";
  } else if (input.expected_collection_date && input.expected_collection_date < input.received_date) return "The expected collection date cannot be before the laundry arrived.";
  if (input.received_via === "driver_pickup" && input.pickup_date && input.pickup_date > input.received_date) return "The driver cannot have collected the laundry after it was received.";
  return null;
}

function toRow(input: OrderInput, deliveryAddress: string | null, receivedAt: string) {
  const delivery = input.delivery_required;
  return {
    customer_id: input.customer_id, received_at: receivedAt, received_via: input.received_via,
    pickup_date: input.received_via === "driver_pickup" ? input.pickup_date ?? null : null,
    pickup_driver_id: input.received_via === "driver_pickup" ? input.pickup_driver_id ?? null : null,
    delivery_required: delivery, expected_delivery_date: delivery ? input.expected_delivery_date ?? null : null,
    expected_collection_date: delivery ? null : input.expected_collection_date ?? null,
    delivery_window: delivery ? input.delivery_window ?? null : null,
    expected_delivery_time: delivery && input.delivery_window === "specific_time" ? input.expected_delivery_time ?? null : null,
    delivery_address_source: delivery && input.use_custom_address ? "custom" : "customer",
    delivery_address: delivery ? deliveryAddress : null, delivery_instructions: delivery ? input.delivery_instructions ?? null : null,
    special_instructions: input.special_instructions ?? null, priority: input.priority, assigned_to: input.assigned_to ?? null,
  };
}

async function resolveDeliveryAddress(supabase: Awaited<ReturnType<typeof createClient>>, input: OrderInput): Promise<string | null> {
  if (!input.delivery_required) return null;
  if (input.use_custom_address) return input.delivery_address ?? null;
  const { data: location } = await supabase.from("customer_locations").select("address_line1, suburb, state, postcode, is_primary").eq("customer_id", input.customer_id).eq("is_delivery", true).is("deleted_at", null).order("is_primary", { ascending: false }).limit(1).maybeSingle<{ address_line1: string | null; suburb: string | null; state: string | null; postcode: string | null }>();
  const fromSite = [location?.address_line1, location?.suburb, location?.state, location?.postcode].filter(Boolean).join(", ");
  if (fromSite) return fromSite;
  const { data: customer } = await supabase.from("customers").select("billing_address_line1, billing_suburb, billing_state, billing_postcode").eq("id", input.customer_id).maybeSingle<{ billing_address_line1: string | null; billing_suburb: string | null; billing_state: string | null; billing_postcode: string | null }>();
  return [customer?.billing_address_line1, customer?.billing_suburb, customer?.billing_state, customer?.billing_postcode].filter(Boolean).join(", ") || null;
}

function backWithCustomer(path: string, formData: FormData): string {
  const posted = formData.get("customer_id");
  if (typeof posted !== "string" || !z.string().uuid().safeParse(posted).success) return path;
  const [base, existing] = path.split("?");
  const query = new URLSearchParams(existing);
  query.set("customer", posted);
  return `${base}?${query.toString()}`;
}

async function loadOrder(supabase: Awaited<ReturnType<typeof createClient>>, id: string): Promise<{ id: string; order_number: string; status: OrderStatus; delivery_required: boolean; received_at: string } | null> {
  const { data } = await supabase.from("laundry_orders").select("id, order_number, status, delivery_required, received_at").eq("id", id).maybeSingle<{ id: string; order_number: string; status: string; delivery_required: boolean; received_at: string }>();
  if (!data || !isOrderStatus(data.status)) return null;
  return { ...data, status: data.status };
}

export async function createOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.write");
  const backTo = returnTo(formData, "/orders/new"); const backToForm = backWithCustomer(backTo, formData);
  const parsed = orderSchema.safeParse(toObject(formData)); if (!parsed.success) return fail(backToForm, firstIssue(parsed.error));
  const parsedItems = parseOrderItems(formData.get("items")); if (!parsedItems.ok) return fail(backToForm, parsedItems.problem);
  const items = parsedItems.items; const problem = crossFieldProblem(parsed.data, items); if (problem) return fail(backToForm, problem);
  if (parsed.data.received_date < businessToday() && !can(session.role, "orders.manage")) return fail(backToForm, "Only a manager can record a job as received on an earlier day.");
  const supabase = await createClient();
  const { data: customer, error: customerError } = await supabase.from("customers").select("id, business_name, depot_id").eq("id", parsed.data.customer_id).is("deleted_at", null).maybeSingle<{ id: string; business_name: string; depot_id: string | null }>();
  if (customerError) return fail(backToForm, describeDbError(customerError)); if (!customer) return fail(backTo, "That customer could not be found — please select one from the list.");
  const deliveryAddress = await resolveDeliveryAddress(supabase, parsed.data);
  const { data: orderNumber, error: numberError } = await supabase.rpc("next_number", { t: session.tenantId, k: "laundry_order", p: "LJ" }); if (numberError) return fail(backToForm, describeDbError(numberError));
  const { data: order, error } = await supabase.from("laundry_orders").insert({ ...toRow(parsed.data, deliveryAddress, receivedInstant(parsed.data.received_date)), tenant_id: session.tenantId, depot_id: session.depotId ?? customer.depot_id, created_by: session.userId, order_number: orderNumber as string, status: "new" }).select("id, order_number").single();
  if (error) return fail(backToForm, describeDbError(error));
  const { error: itemsError } = await supabase.rpc("save_laundry_order_items", { p_order_id: order.id, p_items: items });
  if (itemsError) { const { error: cleanupError } = await supabase.from("laundry_orders").delete().eq("id", order.id).eq("tenant_id", session.tenantId); if (cleanupError) return fail(`/orders/${order.id}`, `Job ${order.order_number} was created but its laundry list could not be saved: ${describeDbError(itemsError)}`); return fail(backToForm, describeDbError(itemsError)); }
  await logOrderActivity(supabase, session, order.id, { activity_type: "created", next: { status: "new", items: items.length, delivery_required: parsed.data.delivery_required, priority: parsed.data.priority } });
  await recordAudit(session, { entity: "laundry_order", entityId: order.id, action: "create", summary: `${order.order_number} ${customer.business_name}` });
  revalidatePath(LIST); return done(`/orders/${order.id}`, `Job ${order.order_number} created.`);
}

export async function updateOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.write");
  const id = z.string().uuid().safeParse(formData.get("id")); if (!id.success) return fail(LIST, "That job could not be found.");
  const backTo = returnTo(formData, `/orders/${id.data}/edit`); const parsed = orderSchema.safeParse(toObject(formData)); if (!parsed.success) return fail(backWithCustomer(backTo, formData), firstIssue(parsed.error));
  const parsedItems = parseOrderItems(formData.get("items")); if (!parsedItems.ok) return fail(backWithCustomer(backTo, formData), parsedItems.problem); const items = parsedItems.items;
  const problem = crossFieldProblem(parsed.data, items); if (problem) return fail(backWithCustomer(backTo, formData), problem);
  const supabase = await createClient(); const existing = await loadOrder(supabase, id.data); if (!existing) return fail(LIST, "That job could not be found.");
  if (existing.status === "cancelled") return fail(`/orders/${id.data}`, "Cancelled jobs cannot be edited.");
  if (existing.status === "completed" && !can(session.role, "orders.manage")) return fail(`/orders/${id.data}`, "Only a manager can edit a completed job.");
  if (parsed.data.received_date < businessToday() && !can(session.role, "orders.manage")) return fail(backWithCustomer(backTo, formData), "Only a manager can record a job as received on an earlier day.");
  const customer = await supabase.from("customers").select("id, depot_id").eq("id", parsed.data.customer_id).is("deleted_at", null).maybeSingle<{ id: string; depot_id: string | null }>(); if (customer.error || !customer.data) return fail(backWithCustomer(backTo, formData), customer.error ? describeDbError(customer.error) : "That customer could not be found.");
  const deliveryAddress = await resolveDeliveryAddress(supabase, parsed.data); const row = toRow(parsed.data, deliveryAddress, existing.received_at);
  const { error } = await supabase.from("laundry_orders").update({ ...row, depot_id: session.depotId ?? customer.data.depot_id }).eq("id", id.data).eq("tenant_id", session.tenantId); if (error) return fail(backWithCustomer(backTo, formData), describeDbError(error));
  const { error: itemsError } = await supabase.rpc("save_laundry_order_items", { p_order_id: id.data, p_items: items }); if (itemsError) return fail(`/orders/${id.data}`, describeDbError(itemsError));
  await logOrderActivity(supabase, session, id.data, { activity_type: "updated", previous: { status: existing.status }, next: { ...row, items: items.length } }); await recordAudit(session, { entity: "laundry_order", entityId: id.data, action: "update", summary: existing.order_number });
  revalidatePath(LIST); revalidatePath(`/orders/${id.data}`); return done(`/orders/${id.data}`, `Job ${existing.order_number} updated.`);
}

const statusSchema = z.object({ id: z.string().uuid(), status: z.string().refine(isOrderStatus, "That is not a job status."), note: optionalText });
export async function advanceOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.status"); const parsed = statusSchema.safeParse(toObject(formData)); if (!parsed.success) return fail(LIST, firstIssue(parsed.error));
  const target = parsed.data.status as OrderStatus; const detail = `/orders/${parsed.data.id}`;
  if (target === "completed" || target === "cancelled") return fail(detail, "Use the delivery, collection or cancel action for that step."); if (target === "assigned") return fail(detail, "Use Assign Driver to give this job to a driver and a delivery date.");
  if (target === "out_for_delivery" && !can(session.role, "orders.manage")) return fail(detail, "Jobs go out when the driver starts their route. Ask a manager if this one needs sending out from the office.");
  const supabase = await createClient(); const existing = await loadOrder(supabase, parsed.data.id); if (!existing) return fail(LIST, "That job could not be found.");
  if (target === "ready_for_delivery" && existing.status === "assigned") return fail(detail, "Use Remove Assignment to take this job off its driver.");
  const allowed = checkTransition(existing.status, target, existing.delivery_required); if (!allowed.ok) return fail(detail, allowed.reason);
  const { error } = await supabase.from("laundry_orders").update({ status: target }).eq("id", parsed.data.id).eq("tenant_id", session.tenantId); if (error) return fail(detail, describeDbError(error));
  await logOrderActivity(supabase, session, parsed.data.id, { activity_type: "status_changed", previous: { status: existing.status }, next: { status: target }, note: parsed.data.note ?? null });
  await recordAudit(session, { entity: "laundry_order", entityId: parsed.data.id, action: "status_change", summary: `${existing.order_number}: ${existing.status} → ${target}` });
  revalidatePath(LIST); revalidatePath(detail); return done(detail, `Job ${existing.order_number} is now ${target.replace(/_/g, " ")}.`);
}

const completionSchema = z.object({ id: z.string().uuid(), completed_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Please select a valid date."), completed_time: requiredTime, handled_by: z.string().uuid("Please choose who handled it."), note: optionalText });
export async function completeOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.status"); const parsed = completionSchema.safeParse(toObject(formData)); if (!parsed.success) { const id = formData.get("id"); return fail(typeof id === "string" ? `/orders/${id}` : LIST, firstIssue(parsed.error)); }
  const detail = `/orders/${parsed.data.id}`; const supabase = await createClient(); const existing = await loadOrder(supabase, parsed.data.id); if (!existing) return fail(LIST, "That job could not be found.");
  const result = await completeLaundryOrder(supabase, session, existing, { at: toInstant(parsed.data.completed_date, parsed.data.completed_time), handledBy: parsed.data.handled_by, note: parsed.data.note ?? null }); if (!result.ok) return fail(detail, result.error);
  const { delivered } = result; await recordAudit(session, { entity: "laundry_order", entityId: parsed.data.id, action: "status_change", summary: `${existing.order_number} ${delivered ? "delivered" : "collected"}` });
  revalidatePath(LIST); revalidatePath(detail); revalidatePath("/awaiting-invoice"); return done(detail, `Job ${existing.order_number} ${delivered ? "delivered" : "collected"} and completed; it is now awaiting invoice review.`);
}

export async function cancelOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.manage"); const parsed = z.object({ id: z.string().uuid(), cancellation_reason: optionalText }).safeParse(toObject(formData)); if (!parsed.success) return fail(LIST, firstIssue(parsed.error));
  const detail = `/orders/${parsed.data.id}`; const supabase = await createClient(); const existing = await loadOrder(supabase, parsed.data.id); if (!existing) return fail(LIST, "That job could not be found.");
  const allowed = checkTransition(existing.status, "cancelled", existing.delivery_required); if (!allowed.ok) return fail(detail, allowed.reason);
  const { error } = await supabase.from("laundry_orders").update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancellation_reason: parsed.data.cancellation_reason ?? null, billing_status: "cancelled_no_invoice" }).eq("id", parsed.data.id).eq("tenant_id", session.tenantId); if (error) return fail(detail, describeDbError(error));
  await logOrderActivity(supabase, session, parsed.data.id, { activity_type: "cancelled", previous: { status: existing.status }, next: { status: "cancelled" }, note: parsed.data.cancellation_reason ?? null }); await recordAudit(session, { entity: "laundry_order", entityId: parsed.data.id, action: "status_change", summary: `${existing.order_number} cancelled` });
  revalidatePath(LIST); revalidatePath(detail); revalidatePath("/awaiting-invoice"); return done(detail, `Job ${existing.order_number} cancelled. Nothing was deleted.`);
}

export async function assignOrder(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.write"); const parsed = z.object({ id: z.string().uuid(), assigned_to: optionalUuid }).safeParse(toObject(formData)); if (!parsed.success) return fail(LIST, firstIssue(parsed.error));
  const detail = `/orders/${parsed.data.id}`; const supabase = await createClient(); const existing = await loadOrder(supabase, parsed.data.id); if (!existing) return fail(LIST, "That job could not be found."); if (existing.status === "cancelled") return fail(detail, "This job was cancelled, so it cannot be assigned.");
  const { data: before } = await supabase.from("laundry_orders").select("assigned_to").eq("id", parsed.data.id).maybeSingle<{ assigned_to: string | null }>();
  const { error } = await supabase.from("laundry_orders").update({ assigned_to: parsed.data.assigned_to ?? null }).eq("id", parsed.data.id).eq("tenant_id", session.tenantId); if (error) return fail(detail, describeDbError(error));
  await logOrderActivity(supabase, session, parsed.data.id, { activity_type: "assigned", previous: { assigned_to: before?.assigned_to ?? null }, next: { assigned_to: parsed.data.assigned_to ?? null } });
  revalidatePath(detail); return done(detail, parsed.data.assigned_to ? "Job reassigned." : "Job unassigned.");
}
