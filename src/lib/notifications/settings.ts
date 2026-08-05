/**
 * Per-tenant notification preferences, stored in `tenants.settings` (AD-3).
 *
 * One jsonb column holds the whole bag of tenant preferences, so Phase C and the
 * simple-mode switch of Phase D share a single migration. The column is opaque
 * to Postgres, which means the shape is only as trustworthy as the code that
 * reads it — so nothing here throws on bad input. `parseSettings()` takes
 * whatever is in the column, keeps what it recognises and falls back to the
 * defaults for the rest. A tenant with a hand-edited settings blob gets the
 * conservative behaviour, not a 500 on every page in the app.
 *
 * Defaults are deliberately asymmetric:
 * - **in-app notifications are on**, because the bell is inert until something
 *   is in it, and a notification nobody asked for costs a glance;
 * - **customer emails are off**, because they leave the building under the
 *   tenant's name. Someone decides to turn those on.
 */

import { z } from "zod";
import { NOTIFICATION_KINDS, type NotificationKind } from "@/lib/notifications/kinds";

export type OverdueReminderSettings = {
  enabled: boolean;
  /** Days past the invoice's due date before the first reminder goes out. */
  firstAfterDays: number;
  /** Days between reminders after the first. */
  repeatEveryDays: number;
  /** Total reminders per invoice, first one included. Then it is a human's job. */
  maxReminders: number;
};

export type NotificationSettings = {
  inApp: Record<NotificationKind, boolean>;
  customerEmail: {
    deliveryConfirmation: boolean;
    overdueReminder: OverdueReminderSettings;
  };
};

/**
 * The owner's answers (2026-08-05): first chase at 7 days past terms, repeating
 * weekly to a maximum of three, in a friendly voice. They are the defaults for
 * the schedule — but `enabled` stays false until someone turns it on, because
 * these emails go to the tenant's customers.
 */
export const DEFAULT_OVERDUE_REMINDER: OverdueReminderSettings = {
  enabled: false,
  firstAfterDays: 7,
  repeatEveryDays: 7,
  maxReminders: 3,
};

export function defaultSettings(): NotificationSettings {
  return {
    inApp: Object.fromEntries(
      NOTIFICATION_KINDS.map((kind) => [kind, true]),
    ) as Record<NotificationKind, boolean>,
    customerEmail: {
      deliveryConfirmation: false,
      overdueReminder: { ...DEFAULT_OVERDUE_REMINDER },
    },
  };
}

/** Bounds, so a bad stored value cannot turn a reminder into a mail flood. */
const reminderSchema = z.object({
  enabled: z.boolean().optional(),
  firstAfterDays: z.number().int().min(0).max(180).optional(),
  repeatEveryDays: z.number().int().min(1).max(90).optional(),
  maxReminders: z.number().int().min(1).max(10).optional(),
});

const schema = z.object({
  notifications: z.object({
    inApp: z.record(z.string(), z.boolean()).optional(),
    customerEmail: z.object({
      deliveryConfirmation: z.boolean().optional(),
      overdueReminder: reminderSchema.optional(),
    }).optional(),
  }).optional(),
});

/** Never throws: unrecognised or malformed input yields the defaults. */
export function parseSettings(raw: unknown): NotificationSettings {
  const defaults = defaultSettings();
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return defaults;

  const stored = parsed.data.notifications;
  if (!stored) return defaults;

  for (const kind of NOTIFICATION_KINDS) {
    const value = stored.inApp?.[kind];
    if (typeof value === "boolean") defaults.inApp[kind] = value;
  }

  const email = stored.customerEmail;
  if (email) {
    if (typeof email.deliveryConfirmation === "boolean") {
      defaults.customerEmail.deliveryConfirmation = email.deliveryConfirmation;
    }
    const reminder = email.overdueReminder;
    if (reminder) {
      defaults.customerEmail.overdueReminder = {
        enabled: reminder.enabled ?? DEFAULT_OVERDUE_REMINDER.enabled,
        firstAfterDays: reminder.firstAfterDays ?? DEFAULT_OVERDUE_REMINDER.firstAfterDays,
        repeatEveryDays: reminder.repeatEveryDays ?? DEFAULT_OVERDUE_REMINDER.repeatEveryDays,
        maxReminders: reminder.maxReminders ?? DEFAULT_OVERDUE_REMINDER.maxReminders,
      };
    }
  }

  return defaults;
}

/**
 * The jsonb to store back. Written under a `notifications` key rather than at
 * the root so Phase D's `ui_mode` can join it without either one clobbering the
 * other on save.
 */
export function serialiseSettings(
  settings: NotificationSettings,
  existing: unknown,
): Record<string, unknown> {
  const base = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? { ...(existing as Record<string, unknown>) }
    : {};
  base.notifications = {
    inApp: settings.inApp,
    customerEmail: settings.customerEmail,
  };
  return base;
}

/**
 * Which reminder number is due for an invoice this many days past its due date,
 * or null if none is. Pure, so the schedule is unit-tested rather than inferred
 * from watching mail go out.
 *
 * Returns a 1-based sequence number: 1 is the first chase, and the caller uses
 * it both to stop at `maxReminders` and as part of the idempotency key, so a
 * sweep that runs twice in a day does not send the same reminder twice.
 */
export function reminderDue(
  daysPastDue: number,
  settings: OverdueReminderSettings,
): number | null {
  if (!settings.enabled) return null;
  if (daysPastDue < settings.firstAfterDays) return null;

  const elapsed = daysPastDue - settings.firstAfterDays;
  // Only on the day a reminder falls due — not every day after it.
  if (elapsed % settings.repeatEveryDays !== 0) return null;

  const sequence = elapsed / settings.repeatEveryDays + 1;
  return sequence <= settings.maxReminders ? sequence : null;
}
