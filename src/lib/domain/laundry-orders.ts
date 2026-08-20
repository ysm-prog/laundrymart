/**
 * The rules of a laundry job, with no database in sight.
 *
 * Everything here is pure so that the four places that need to agree actually
 * do: the create/edit form deciding what to show, the job page deciding which
 * buttons exist, the server action deciding whether to allow the write, and the
 * migration's guard trigger, whose transition table is a transcription of the
 * one below. When those drift, the symptom is a button that always fails — so
 * they are stated once, here, and unit-tested.
 *
 * On screen this entity is a **Job**; in the schema it is a `laundry_order`.
 * `public.jobs` was already taken by the routing module's stops (see the header
 * of migration 0014).
 */

import type { Capability } from "@/lib/roles";
import { businessNowTime, toInstant, toZonedTime } from "@/lib/domain/timezone";

/* --------------------------------------------------------------- statuses */

export const ORDER_STATUSES = [
  "new",
  "in_progress",
  "ready_for_delivery",
  "assigned",
  "out_for_delivery",
  "completed",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Operator language, per the design system. "Ready for delivery" reads wrong on
 * a job the customer is collecting, so the label is neutral — the job page and
 * the list both say which workflow a job is on beside it.
 */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  new: "New",
  in_progress: "In progress",
  ready_for_delivery: "Ready for delivery",
  assigned: "Assigned",
  out_for_delivery: "Out for delivery",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const TERMINAL_STATUSES: readonly OrderStatus[] = ["completed", "cancelled"];

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

/**
 * The transition table. Mirrored exactly by `guard_laundry_order_transition()`
 * in migration 0016 — the database is the boundary, this is the explanation.
 *
 * `ready_for_delivery` is the one state with a fork, and it is the fork the
 * whole module turns on: a job we deliver is given to a driver first, a job the
 * customer collects is finished the moment they walk out with it.
 *
 * `assigned -> ready_for_delivery` is the one backwards edge, and it is Remove
 * Assignment rather than a mistake. Taking a job off a driver puts it back in
 * the queue with its laundry, its customer and its history — it is emphatically
 * not a cancellation, and modelling it as one is how work quietly disappears.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ["in_progress", "cancelled"],
  in_progress: ["ready_for_delivery", "cancelled"],
  ready_for_delivery: ["assigned", "completed", "cancelled"],
  assigned: ["out_for_delivery", "ready_for_delivery", "cancelled"],
  out_for_delivery: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** Statuses that only a delivery job ever reaches. A pickup never leaves the shop. */
const DELIVERY_ONLY: readonly OrderStatus[] = ["assigned", "out_for_delivery"];

/** The statuses a job may move to next, given which workflow it is on. */
export function nextStatuses(from: OrderStatus, deliveryRequired: boolean): OrderStatus[] {
  return TRANSITIONS[from].filter((to) => {
    if (DELIVERY_ONLY.includes(to)) return deliveryRequired;
    if (to === "completed" && from === "ready_for_delivery") return !deliveryRequired;
    return true;
  });
}

/**
 * Whether a move is allowed, and if not, why — in a sentence a person can act
 * on. The action shows this to the user; the trigger behind it raises its own.
 */
export function checkTransition(
  from: OrderStatus, to: OrderStatus, deliveryRequired: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: false, reason: `This job is already ${ORDER_STATUS_LABELS[to].toLowerCase()}.` };
  if (TERMINAL_STATUSES.includes(from)) {
    return {
      ok: false,
      reason: from === "completed"
        ? "This job is completed. A finished job cannot be moved again."
        : "This job was cancelled. A cancelled job cannot be moved again.",
    };
  }
  if (DELIVERY_ONLY.includes(to) && !deliveryRequired) {
    return { ok: false, reason: "The customer is collecting this job, so it never goes out on a run." };
  }
  if (to === "completed" && from === "ready_for_delivery" && deliveryRequired) {
    return {
      ok: false,
      reason: "Assign this job to a driver and send it out before completing it.",
    };
  }
  if (to === "out_for_delivery" && from === "ready_for_delivery") {
    return { ok: false, reason: "Assign this job to a driver before it goes out." };
  }
  if (!nextStatuses(from, deliveryRequired).includes(to)) {
    return {
      ok: false,
      reason: `A job cannot go from ${ORDER_STATUS_LABELS[from].toLowerCase()} to ${ORDER_STATUS_LABELS[to].toLowerCase()}.`,
    };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- actions */

/**
 * The workflow buttons, as data. The job page renders whichever of these the
 * job's state and the viewer's role allow, and the action re-checks both — the
 * hidden button is a courtesy, never the guard.
 */
export type OrderAction = {
  key: "start" | "ready" | "dispatch" | "deliver" | "collect" | "cancel";
  label: string;
  to: OrderStatus;
  capability: Capability;
  /** Needs the confirm step that captures date, time and who did it. */
  confirms: boolean;
};

export const ORDER_ACTIONS: readonly OrderAction[] = [
  { key: "start", label: "Mark in progress", to: "in_progress", capability: "orders.status", confirms: false },
  { key: "ready", label: "Mark ready for delivery", to: "ready_for_delivery", capability: "orders.status", confirms: false },
  // Sending a job out is the *driver's* Start Route, not an office button. It
  // stays here only as the management override the brief allows for the run
  // that never got started, which is why it sits on `orders.manage` rather than
  // the counter's `orders.status`: an ordinary office user pressing this would
  // silently step around the driver's load confirmation.
  { key: "dispatch", label: "Send out (override)", to: "out_for_delivery", capability: "orders.manage", confirms: false },
  { key: "deliver", label: "Mark as delivered", to: "completed", capability: "orders.status", confirms: true },
  { key: "collect", label: "Mark as collected", to: "completed", capability: "orders.status", confirms: true },
  // Cancelling is the supervisor's call, so it sits on the wider capability.
  { key: "cancel", label: "Cancel job", to: "cancelled", capability: "orders.manage", confirms: true },
];

/**
 * Which actions this job's state permits, before capabilities are considered.
 *
 * Assignment is deliberately absent: giving a job to a driver captures a driver
 * and a date, so it is a form rather than a status button, and it lives in
 * `AssignForm`. Un-assigning is likewise its own action — a status control
 * offering "ready for delivery" on an assigned job would read as a step
 * backwards through the plant rather than as taking it off a van.
 */
export function actionsFor(status: OrderStatus, deliveryRequired: boolean): OrderAction[] {
  const reachable = nextStatuses(status, deliveryRequired);
  return ORDER_ACTIONS.filter((action) => {
    if (!reachable.includes(action.to)) return false;
    if (action.key === "deliver") return deliveryRequired;
    if (action.key === "collect") return !deliveryRequired;
    // `ready_for_delivery` is reachable from `assigned`, but only as Remove
    // Assignment — never as the plain "mark ready" button.
    if (action.key === "ready") return status !== "assigned";
    return true;
  });
}

/* -------------------------------------------------------------- vocabulary */

export const ORDER_PRIORITIES = ["normal", "urgent"] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];
export const PRIORITY_LABELS: Record<OrderPriority, string> = {
  normal: "Normal",
  urgent: "Urgent",
};

/**
 * Every value the column accepts, including the legacy `other`.
 *
 * This stays the *accepted* set, not the offered one: the check constraint in
 * 0014 allows all three, jobs taken in before this change may hold `other`, and
 * a validator narrower than the column would refuse to save an edit to one of
 * them. What the counter is offered on a new job is `RECEIVED_VIA_OPTIONS`.
 */
export const RECEIVED_VIA = ["customer_dropoff", "driver_pickup", "other"] as const;
export type ReceivedVia = (typeof RECEIVED_VIA)[number];
export const RECEIVED_VIA_LABELS: Record<ReceivedVia, string> = {
  customer_dropoff: "Customer drop-off",
  driver_pickup: "Pickup by driver",
  other: "Other",
};

/** The two ways laundry actually arrives, and the only two a new job is offered. */
export const RECEIVED_VIA_OPTIONS: readonly ReceivedVia[] = ["driver_pickup", "customer_dropoff"];

/**
 * The default on a new job, and the stored answer on an existing one.
 *
 * Most laundry is collected by a driver rather than carried in, so that is what
 * the form now opens on — the same reasoning that put the delivery fork on
 * "Deliver". An existing job answers with its own value: opening a drop-off to
 * fix a quantity must never quietly re-record how it arrived.
 */
export function initialReceivedVia(order?: { received_via: string } | null): string {
  return order?.received_via ?? "driver_pickup";
}

/**
 * The received-via choices to render, given what the job already holds.
 *
 * A new job gets the two real answers. An older job holding a value that is no
 * longer offered keeps it in the list, so opening it to change something else
 * cannot silently rewrite how it arrived — the same read-what-is-stored rule the
 * delivery choice follows below.
 */
export function receivedViaOptions(current?: string | null): string[] {
  const offered: string[] = [...RECEIVED_VIA_OPTIONS];
  if (current && !offered.includes(current)) offered.push(current);
  return offered;
}

/**
 * Whether the delivery/pickup choice starts on "Deliver".
 *
 * New jobs do: taking it back to the customer is the normal job, and making the
 * counter select it every time was a step that was almost always the same. An
 * existing job answers with its own stored value, so editing one never moves it
 * onto the other workflow.
 *
 * The label is "Deliver", not "Re-deliver". The customer-facing word for taking
 * clean laundry to a customer is delivery; "re-delivery" is what a courier calls
 * a second attempt after a failed one, which is a different event this system
 * does not model and should not appear to.
 */
export function initialDeliveryRequired(order?: { delivery_required: boolean } | null): boolean {
  return order ? order.delivery_required : true;
}

/**
 * When the laundry was received, as the instant the column stores.
 *
 * The counter no longer types a time — it is the moment they are standing there,
 * and asking for it was a field that was never wrong and always in the way. So a
 * new job takes the clock time now, on whichever date was chosen (a manager
 * backdating to yesterday gets this time yesterday, not midnight).
 *
 * An edit passes the job's existing `received_at` and keeps its time of day:
 * correcting the date must not quietly move an 8am drop-off to this afternoon.
 */
export function receivedInstant(date: string, existing?: string | null): string {
  const time = (existing ? toZonedTime(existing) : "") || businessNowTime();
  return toInstant(date, time);
}

export const DELIVERY_WINDOWS = ["morning", "afternoon", "specific_time", "no_specific_time"] as const;
export type DeliveryWindow = (typeof DELIVERY_WINDOWS)[number];
export const DELIVERY_WINDOW_LABELS: Record<DeliveryWindow, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  specific_time: "Specific time",
  no_specific_time: "No specific time",
};

/**
 * What arrives in a customer's bag. Deliberately separate from `public.items`,
 * which is the linen the laundry owns and rents out — see migration 0014.
 */
export const ITEM_TYPES = [
  "towels", "hand_towels", "bath_towels", "bath_mats", "sheets",
  "pillowcases", "linen", "uniforms", "other",
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  towels: "Towels",
  hand_towels: "Hand towels",
  bath_towels: "Bath towels",
  bath_mats: "Bath mats",
  sheets: "Sheets",
  pillowcases: "Pillowcases",
  linen: "Linen",
  uniforms: "Uniforms",
  other: "Other",
};

export const QUANTITY_TYPES = ["exact", "bulk_lot"] as const;
export type QuantityType = (typeof QUANTITY_TYPES)[number];
export const QUANTITY_TYPE_LABELS: Record<QuantityType, string> = {
  exact: "Exact quantity",
  bulk_lot: "Bulk / lot",
};

/* ------------------------------------------------------------------ items */

export type OrderItemInput = {
  item_type: string;
  custom_description?: string | null;
  quantity_type: string;
  exact_quantity?: number | null;
  bag_count?: number | null;
  estimated_quantity?: number | null;
  notes?: string | null;
};

/**
 * Is this row worth keeping? The form always carries at least one blank row, and
 * a blank row is an abandoned thought rather than an error — it is dropped
 * silently. A row with *anything* in it is validated properly.
 */
export function isBlankItem(item: OrderItemInput): boolean {
  return !item.item_type
    && !item.custom_description?.trim()
    && item.exact_quantity == null
    && item.bag_count == null
    && item.estimated_quantity == null
    && !item.notes?.trim();
}

/**
 * The item rules, as the message the counter hand should see. Same three rules
 * the check constraints in 0014 enforce; said in words here, refused there.
 */
export function validateItem(item: OrderItemInput, position: number): string | null {
  const where = `Laundry item ${position}`;
  if (!(ITEM_TYPES as readonly string[]).includes(item.item_type)) {
    return `${where}: choose what kind of laundry it is.`;
  }
  if (item.item_type === "other" && !item.custom_description?.trim()) {
    return `${where}: describe what it is, since you chose Other.`;
  }
  if (!(QUANTITY_TYPES as readonly string[]).includes(item.quantity_type)) {
    return `${where}: choose an exact quantity or a bulk lot.`;
  }
  if (item.quantity_type === "exact") {
    const quantity = item.exact_quantity;
    if (quantity == null || !Number.isInteger(quantity) || quantity < 1) {
      return `${where}: please enter a valid quantity — a whole number of one or more.`;
    }
  }
  if (item.quantity_type === "bulk_lot") {
    const measured = item.bag_count != null || item.estimated_quantity != null || !!item.notes?.trim();
    if (!measured) {
      return `${where}: say how many bags, roughly how many pieces, or add a note — a bulk lot needs something to go on.`;
    }
    if (item.bag_count != null && (!Number.isInteger(item.bag_count) || item.bag_count < 1)) {
      return `${where}: please enter a valid number of bags.`;
    }
    if (item.estimated_quantity != null
        && (!Number.isInteger(item.estimated_quantity) || item.estimated_quantity < 1)) {
      return `${where}: please enter a valid estimated quantity.`;
    }
  }
  return null;
}

/** One item, said the way it would be said across a counter. */
export function describeItem(item: OrderItemInput): string {
  const kind = item.item_type === "other"
    ? (item.custom_description?.trim() || "Other")
    : ITEM_TYPE_LABELS[item.item_type as ItemType] ?? item.item_type;

  if (item.quantity_type === "exact") return `${item.exact_quantity ?? 0} × ${kind}`;

  const bags = item.bag_count
    ? `${item.bag_count} ${item.bag_count === 1 ? "bag" : "bags"}`
    : "bulk lot";
  const estimate = item.estimated_quantity ? ` (about ${item.estimated_quantity})` : "";
  return `${bags} of ${kind}${estimate}`;
}

/** The list's laundry column: the first couple of items, then a count. */
export function summariseItems(items: readonly OrderItemInput[], limit = 2): string {
  if (items.length === 0) return "No items";
  const shown = items.slice(0, limit).map(describeItem).join(", ");
  const rest = items.length - limit;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/* ---------------------------------------------------------------- overdue */

/**
 * Overdue is a calculation, never a stored status: a job is late when the day it
 * was due has passed and it is neither finished nor cancelled. Which date counts
 * depends on the workflow, which is why `due_date` is a generated column — this
 * function and the database read the same definition.
 */
export function isOverdue(
  order: { status: string; due_date: string | null }, today: string,
): boolean {
  if (!order.due_date) return false;
  if (TERMINAL_STATUSES.includes(order.status as OrderStatus)) return false;
  return order.due_date < today;
}
