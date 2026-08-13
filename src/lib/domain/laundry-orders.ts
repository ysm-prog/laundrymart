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

/* --------------------------------------------------------------- statuses */

export const ORDER_STATUSES = [
  "new",
  "in_progress",
  "ready_for_delivery",
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
 * in migration 0014 — the database is the boundary, this is the explanation.
 *
 * `ready_for_delivery` is the one state with a fork, and it is the fork the
 * whole module turns on: a job we deliver goes out on a van first, a job the
 * customer collects is finished the moment they walk out with it.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ["in_progress", "cancelled"],
  in_progress: ["ready_for_delivery", "cancelled"],
  ready_for_delivery: ["out_for_delivery", "completed", "cancelled"],
  out_for_delivery: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** The statuses a job may move to next, given which workflow it is on. */
export function nextStatuses(from: OrderStatus, deliveryRequired: boolean): OrderStatus[] {
  return TRANSITIONS[from].filter((to) => {
    if (to === "out_for_delivery") return deliveryRequired;
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
  if (to === "out_for_delivery" && !deliveryRequired) {
    return { ok: false, reason: "The customer is collecting this job, so it never goes out for delivery." };
  }
  if (to === "completed" && from === "ready_for_delivery" && deliveryRequired) {
    return { ok: false, reason: "Mark this job out for delivery before completing it." };
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
  { key: "ready", label: "Mark ready", to: "ready_for_delivery", capability: "orders.status", confirms: false },
  { key: "dispatch", label: "Mark out for delivery", to: "out_for_delivery", capability: "orders.status", confirms: false },
  { key: "deliver", label: "Mark as delivered", to: "completed", capability: "orders.status", confirms: true },
  { key: "collect", label: "Mark as collected", to: "completed", capability: "orders.status", confirms: true },
  // Cancelling is the supervisor's call, so it sits on the wider capability.
  { key: "cancel", label: "Cancel job", to: "cancelled", capability: "orders.manage", confirms: true },
];

/** Which actions this job's state permits, before capabilities are considered. */
export function actionsFor(status: OrderStatus, deliveryRequired: boolean): OrderAction[] {
  const reachable = nextStatuses(status, deliveryRequired);
  return ORDER_ACTIONS.filter((action) => {
    if (!reachable.includes(action.to)) return false;
    if (action.key === "deliver") return deliveryRequired;
    if (action.key === "collect") return !deliveryRequired;
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

export const RECEIVED_VIA = ["customer_dropoff", "driver_pickup", "other"] as const;
export type ReceivedVia = (typeof RECEIVED_VIA)[number];
export const RECEIVED_VIA_LABELS: Record<ReceivedVia, string> = {
  customer_dropoff: "Customer drop-off",
  driver_pickup: "Pickup by driver",
  other: "Other",
};

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
