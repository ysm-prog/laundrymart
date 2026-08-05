/**
 * The catalogue of things the app will speak up about (roadmap C1/C2, AD-4).
 *
 * Pure data — no database, no session, no I/O — so the writers, the bell, the
 * settings screen and the tests all read one list and cannot drift apart. A new
 * event is added here and everything else picks it up.
 *
 * `audience` is a capability string, reusing the existing role model rather than
 * inventing a second targeting scheme. The rule for choosing one: **the
 * capability held by the person who fixes it**, not the one held by everyone who
 * might find it interesting. A dispatcher chases a run that has not started, so
 * that event is `routes.write`; using `routes.read` would put it in front of
 * every driver, whose own screen already tells them their run has not started.
 */

import type { Capability } from "@/lib/roles";

export const NOTIFICATION_KINDS = [
  "invoice_overdue",
  "run_not_started",
  "inspection_failed",
  "vehicle_out_of_service",
  "batch_rejected",
  "sync_failed",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationEvent = {
  /** Operator language, used on the settings screen. */
  label: string;
  /** One plain sentence saying when it fires. */
  description: string;
  audience: Capability;
  /** Swept events are produced by the cron check; the rest ride a server action. */
  source: "action" | "sweep";
};

export const NOTIFICATION_EVENTS: Record<NotificationKind, NotificationEvent> = {
  invoice_overdue: {
    label: "An invoice passes its payment terms",
    description: "Fires the morning an issued invoice goes past its due date and is still unpaid.",
    audience: "invoices.write",
    source: "sweep",
  },
  run_not_started: {
    label: "A run has not started on time",
    description: "Fires when a run planned for today is still sitting at the depot past its start window.",
    audience: "routes.write",
    source: "sweep",
  },
  inspection_failed: {
    label: "A driver fails a vehicle inspection",
    description: "Fires the moment a driver submits a failed inspection from their run.",
    audience: "fleet.write",
    source: "action",
  },
  vehicle_out_of_service: {
    label: "A vehicle is taken off the road",
    description: "Fires when anyone marks a vehicle out of service, from the office or the yard.",
    audience: "fleet.write",
    source: "action",
  },
  batch_rejected: {
    label: "Stock is written off as damaged",
    description: "Fires when linen is pulled out of a production batch and sent to damaged.",
    audience: "warehouse.write",
    source: "action",
  },
  sync_failed: {
    label: "A driver's paperwork fails to sync",
    description: "Fires when a stop captured offline is rejected on its way back in, so it is chased rather than lost.",
    audience: "routes.write",
    source: "action",
  },
};

export function isNotificationKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}
