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
 * Where a job may go from here.
 *
 * **Until 2026-08-26 this was a linear table and a job could only take one step
 * at a time**, forwards, with `assigned -> ready_for_delivery` the single
 * exception. The owner's decision is that the plant stages are pickable in any
 * order and in either direction: a counter hand who marked a job ready by
 * mistake puts it back, and a job that never needed the middle step skips it.
 *
 * What survives is the four rules that are about **this job's own facts** rather
 * than about the order things happened in, and each of them is a sentence:
 *
 *  1. a customer pickup never reaches `assigned` or `out_for_delivery` — it has
 *     no delivery to be on;
 *  2. a job still in the plant is not given to a delivery round, which is the
 *     same rule `checkAssignable` and `guard_laundry_order_assignment` already
 *     state, said in the one place a status can be picked;
 *  3. a delivery job is assigned before it goes out, or it is on nobody's van
 *     and invisible to My Runs;
 *  4. a delivery job goes out before it is completed, or its delivery is a
 *     record of something that did not happen.
 *
 * And `completed` and `cancelled` stay terminal, which is not one of the four so
 * much as the frame around them: a job that finished and then reopened is two
 * accounts of the same work, and by then it may have been priced, approved and
 * rolled onto an invoice the customer has been sent.
 *
 * Mirrored exactly by `guard_laundry_order_transition()` in migration 0042 —
 * the database is the boundary, this is the explanation.
 */

/** Statuses that only a delivery job ever reaches. A pickup never leaves the shop. */
const DELIVERY_ONLY: readonly OrderStatus[] = ["assigned", "out_for_delivery"];

/** The stages where the laundry is still in the building. */
const PLANT_STAGES: readonly OrderStatus[] = ["new", "in_progress", "ready_for_delivery"];

/**
 * The stages of the work itself, in the order it runs — which is the order the
 * status track draws them in, and nothing more. Being a list no longer implies
 * that a job walks it one step at a time. `cancelled` is deliberately not on it:
 * it is not a stage of the work, it is the work stopping.
 */
export const ORDER_STAGES: readonly OrderStatus[] = [
  "new", "in_progress", "ready_for_delivery", "assigned", "out_for_delivery", "completed",
];

/**
 * The stages of *this* job, which is the shorter list for a customer pickup.
 *
 * A pickup is drawn without the two delivery stages rather than with them greyed
 * out: a step that can never apply is noise, and §29 already settles the general
 * form of this question — a chip nothing matches is left off, not drawn dead.
 */
export function stagesFor(deliveryRequired: boolean): OrderStatus[] {
  return ORDER_STAGES.filter((stage) => deliveryRequired || !DELIVERY_ONLY.includes(stage));
}

/**
 * The one rule, stated once. `null` means the move is allowed; a string is what
 * the person who tried it should read.
 *
 * Both `nextStatuses` and `checkTransition` read this rather than each other,
 * which is what stops the pair drifting — and stops the recursion the obvious
 * arrangement (each defined in terms of the other) would have produced.
 */
function refuseTransition(
  from: OrderStatus, to: OrderStatus, deliveryRequired: boolean,
): string | null {
  if (from === to) return `This job is already ${ORDER_STATUS_LABELS[to].toLowerCase()}.`;

  if (TERMINAL_STATUSES.includes(from)) {
    return from === "completed"
      ? "This job is completed. A finished job cannot be moved again."
      : "This job was cancelled. A cancelled job cannot be moved again.";
  }

  if (DELIVERY_ONLY.includes(to) && !deliveryRequired) {
    return "The customer is collecting this job, so it never goes out on a run.";
  }

  // Rule 2, said as "not ready yet" rather than as "you cannot go from here",
  // because that is the actual objection: the laundry is still being done.
  if (to === "assigned" && from !== "ready_for_delivery") {
    return from === "out_for_delivery"
      ? "This job is already out for delivery. Take it off the round first if it needs re-assigning."
      : "This job is not ready for delivery yet — mark it ready, then give it to a round.";
  }

  // Rule 3.
  if (to === "out_for_delivery" && from !== "assigned") {
    return "Assign this job to a round and a delivery date before it goes out.";
  }

  // Rule 4.
  if (to === "completed" && deliveryRequired && from !== "out_for_delivery") {
    return "A delivery job is completed once it has gone out — assign it to a round and "
      + "send it out first.";
  }

  return null;
}

/**
 * Every status this job can be moved to, in the order the track draws them.
 *
 * Now genuinely "every", not "the next one": from `in_progress` a delivery job
 * offers `new`, `ready_for_delivery` and `cancelled`, and from
 * `ready_for_delivery` it adds `assigned`.
 */
export function nextStatuses(from: OrderStatus, deliveryRequired: boolean): OrderStatus[] {
  return ORDER_STATUSES.filter(
    (to) => refuseTransition(from, to, deliveryRequired) === null,
  );
}

/**
 * Whether a move is allowed, and if not, why — in a sentence a person can act
 * on. The action shows this to the user; the trigger behind it raises its own.
 */
export function checkTransition(
  from: OrderStatus, to: OrderStatus, deliveryRequired: boolean,
): { ok: true } | { ok: false; reason: string } {
  const reason = refuseTransition(from, to, deliveryRequired);
  return reason === null ? { ok: true } : { ok: false, reason };
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
 * Still the whole set. What changed is who reads it: since the status track
 * landed the job page takes only the actions that `confirms`, because the plain
 * status moves are steps on the track now and a button for each of them as well
 * would be the same choice offered twice — and with free movement there are up
 * to four at once. The rest is kept because it is where each move's capability
 * is declared, and `roles.test.ts` and the tests below read it from here.
 */
export function actionsFor(status: OrderStatus, deliveryRequired: boolean): OrderAction[] {
  const reachable = nextStatuses(status, deliveryRequired);
  return ORDER_ACTIONS.filter((action) => {
    if (!reachable.includes(action.to)) return false;
    if (action.key === "deliver") return deliveryRequired;
    if (action.key === "collect") return !deliveryRequired;
    return true;
  });
}

/* ----------------------------------------------------------- status track */

/**
 * How a stage is reached, which is not the same question as whether it is
 * allowed.
 *
 * `jump` is a plain status write, and the track posts it itself. The other two
 * name a form, because giving a job to a round captures a round *and* a delivery
 * date, and finishing one captures who handed it over and when — neither is a
 * status with a button on it. Those steps are drawn on the track and say where
 * their control is rather than being pressable: a control whose only possible
 * outcome is a refusal is a dead end dressed as a choice.
 */
export type StageControl = {
  capability: Capability;
  via: "jump" | "assign" | "complete";
  /** Where the real control is, for a step that cannot be pressed from here. */
  where: string | null;
};

export const STAGE_CONTROLS: Record<OrderStatus, StageControl> = {
  new: { capability: "orders.status", via: "jump", where: null },
  in_progress: { capability: "orders.status", via: "jump", where: null },
  ready_for_delivery: { capability: "orders.status", via: "jump", where: null },
  // `routes.write` is the existing plan-and-assign capability — the same one the
  // Delivery card checks, so the step and the form it points at agree.
  assigned: {
    capability: "routes.write", via: "assign",
    where: "Give this job to a round and a delivery date in the Delivery card below.",
  },
  // Sending a job out is the round's own Start Route. It stays here as the
  // management override for the run that never got started, which is why it sits
  // on `orders.manage` rather than the counter's `orders.status`.
  out_for_delivery: {
    capability: "orders.manage", via: "jump",
    where: "Jobs normally go out when the round starts its route.",
  },
  completed: {
    capability: "orders.status", via: "complete",
    where: "Use the button below — finishing a job records who handed it over and when.",
  },
  // Not a stage of the work, so never drawn on the track. Here because the map
  // is total: a status the track never asks about is still a status.
  cancelled: { capability: "orders.manage", via: "complete", where: null },
};

/**
 * Does this move take the job off the round it is on?
 *
 * True for every move out of `assigned` or `out_for_delivery` back into the
 * plant, and stated as exactly that rather than as "not one of the others" —
 * which is what it said first, and it was wrong about **cancelling**. Neither
 * `completed` nor `cancelled` gives up the round: a delivered job keeps the one
 * that delivered it, which is how the business answers "who was holding that
 * parcel?", and 0016 lets a cancellation keep it deliberately, so that stopping
 * a job never requires unpicking its assignment first. The trigger's own
 * clearing condition is this list, so the two cannot disagree.
 *
 * Two callers, and they are the reason this is a named rule rather than an
 * inline condition: it decides who may make the move, and it tells the action
 * that the round's own screens and its emptied stop need tidying up.
 */
export function leavesTheRound(from: OrderStatus, to: OrderStatus): boolean {
  return DELIVERY_ONLY.includes(from) && PLANT_STAGES.includes(to);
}

/**
 * Which capabilities a move needs, source and target together.
 *
 * The second half is what stops the status control being a back door around
 * Remove Assignment: un-booking a call somebody planned is dispatch's decision,
 * whoever is moving the job's status.
 */
export function capabilitiesForMove(from: OrderStatus, to: OrderStatus): Capability[] {
  const needed: Capability[] = [STAGE_CONTROLS[to].capability];
  if (leavesTheRound(from, to)) needed.push("routes.write");
  return needed;
}

/** One step on the track, ready to draw. */
export type StatusStep = {
  status: OrderStatus;
  label: string;
  /** Where this step sits relative to where the job is now. */
  state: "done" | "current" | "upcoming";
  /** Pressable right now, as a plain status write the track posts itself. */
  jump: boolean;
  /** Why it cannot be pressed. Null on the current step and on a pressable one. */
  note: string | null;
};

/**
 * The whole track, as data.
 *
 * Pure and here rather than inside the component for the reason this file
 * records four times over: a rule stated inside a `"use server"` module or a
 * JSX tree is a rule no unit test can reach, and two of the three payload
 * contracts that were written that way shipped broken behind a green `verify`.
 *
 * A cancelled job has no position on the track — `cancelled` is not one of the
 * stages — so every step comes back `upcoming` and unpressable, which is right:
 * the banner above the track is what says what happened to it.
 */
export function buildStatusTrack(
  job: { status: OrderStatus; deliveryRequired: boolean },
  allows: (capability: Capability) => boolean,
  /**
   * One sentence that stops the whole track and replaces every note, for the
   * case where nothing about this job is movable from here whatever the rules
   * say — a platform admin looking at another laundry's job, whose session reads
   * every laundry (0019) while every write is scoped to the one they are in.
   * Passing it is better than passing an `allows` that always answers false,
   * which would tell them their *role* is the problem when it is not.
   */
  blocked?: string,
): StatusStep[] {
  const stages = stagesFor(job.deliveryRequired);
  const at = stages.indexOf(job.status);

  return stages.map((status, index) => {
    const control = STAGE_CONTROLS[status];
    const state = at < 0 || index > at ? "upcoming" : index === at ? "current" : "done";
    if (state === "current") {
      return { status, label: ORDER_STATUS_LABELS[status], state, jump: false, note: null };
    }
    if (blocked) {
      return { status, label: ORDER_STATUS_LABELS[status], state, jump: false, note: blocked };
    }

    const refusal = refuseTransition(job.status, status, job.deliveryRequired);
    const missing = capabilitiesForMove(job.status, status).some((c) => !allows(c));
    const note = refusal
      ?? (missing ? "Your role cannot make this change." : control.where);

    return {
      status,
      label: ORDER_STATUS_LABELS[status],
      state,
      jump: !refusal && !missing && control.via === "jump",
      note: note ?? null,
    };
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
  /**
   * The item master row this is (0032), where the counter picked a coded item.
   *
   * Optional, and null on every job written before the item master existed. When
   * it is set, `item_type` is derived from the item's `laundry_category` by a
   * database trigger, so the two can never disagree — which is what lets every
   * existing price tier, report and filter keep matching on `item_type`.
   */
  item_id?: string | null;
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

/**
 * One item, said the way it would be said across a counter.
 *
 * `label` is the item master's name when the row names a coded item — staff read
 * "TOW001 — Bath Towel", not "Towels", and the code is the half they recognise.
 * Without one this falls back to the kind of laundry exactly as it always did,
 * which is what every job written before the item master relies on.
 */
export function describeItem(item: OrderItemInput, label?: string | null): string {
  const kind = label?.trim()
    || (item.item_type === "other"
      ? (item.custom_description?.trim() || "Other")
      : ITEM_TYPE_LABELS[item.item_type as ItemType] ?? item.item_type);

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
  const shown = items.slice(0, limit).map((item) => describeItem(item)).join(", ");
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
