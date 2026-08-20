import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERDUE_REMINDER, defaultSettings, parseSettings, reminderDue, serialiseSettings,
} from "@/lib/notifications/settings";
import { NOTIFICATION_KINDS } from "@/lib/notifications/kinds";

/**
 * `tenants.settings` is a jsonb column, so Postgres guarantees it is JSON and
 * nothing more. Every property that matters — the conservative defaults, the
 * bounds on the reminder schedule, and not clobbering a sibling key on save —
 * lives in this parser rather than in the database.
 */
describe("notification settings", () => {
  it("defaults in-app notifications on and customer emails off", () => {
    const settings = defaultSettings();
    for (const kind of NOTIFICATION_KINDS) {
      expect(settings.inApp[kind]).toBe(true);
    }
    expect(settings.customerEmail.deliveryConfirmation).toBe(false);
    expect(settings.customerEmail.overdueReminder.enabled).toBe(false);
  });

  it("carries the owner's schedule as the default, still switched off", () => {
    expect(DEFAULT_OVERDUE_REMINDER).toMatchObject({
      enabled: false, firstAfterDays: 7, repeatEveryDays: 7, maxReminders: 3,
    });
  });

  it("falls back to the defaults for an empty, absent or malformed column", () => {
    for (const input of [null, undefined, {}, "not an object", 42, []]) {
      expect(parseSettings(input).customerEmail.deliveryConfirmation).toBe(false);
      expect(parseSettings(input).inApp.invoice_overdue).toBe(true);
    }
  });

  it("keeps a stored switch and ignores a junk one in the same blob", () => {
    const settings = parseSettings({
      notifications: {
        inApp: { invoice_overdue: false, not_a_real_kind: false },
        customerEmail: { deliveryConfirmation: true },
      },
    });
    expect(settings.inApp.invoice_overdue).toBe(false);
    // Untouched kinds keep the default rather than inheriting the stored one.
    expect(settings.inApp.run_not_started).toBe(true);
    expect(settings.customerEmail.deliveryConfirmation).toBe(true);
  });

  it("rejects an out-of-range stored schedule rather than mailing on it", () => {
    // A repeat of 0 days would be a reminder every sweep, all day.
    const settings = parseSettings({
      notifications: { customerEmail: { overdueReminder: { enabled: true, repeatEveryDays: 0 } } },
    });
    expect(settings.customerEmail.overdueReminder.repeatEveryDays)
      .toBe(DEFAULT_OVERDUE_REMINDER.repeatEveryDays);
  });

  it("merges into the existing blob so a sibling preference survives a save", () => {
    const stored = serialiseSettings(defaultSettings(), { ui_mode: "simple" });
    expect(stored.ui_mode).toBe("simple");
    expect(stored.notifications).toBeDefined();
    // A non-object column is replaced rather than spread.
    expect(serialiseSettings(defaultSettings(), "junk").notifications).toBeDefined();
  });
});

describe("reminderDue", () => {
  const enabled = { ...DEFAULT_OVERDUE_REMINDER, enabled: true };

  it("sends nothing while the feature is off", () => {
    expect(reminderDue(30, DEFAULT_OVERDUE_REMINDER)).toBeNull();
  });

  it("waits for the threshold, then fires on the day", () => {
    expect(reminderDue(6, enabled)).toBeNull();
    expect(reminderDue(7, enabled)).toBe(1);
  });

  it("fires only on a reminder day, not every day after one", () => {
    expect(reminderDue(8, enabled)).toBeNull();
    expect(reminderDue(13, enabled)).toBeNull();
    expect(reminderDue(14, enabled)).toBe(2);
    expect(reminderDue(21, enabled)).toBe(3);
  });

  it("stops at the maximum instead of chasing forever", () => {
    expect(reminderDue(28, enabled)).toBeNull();
    expect(reminderDue(70, enabled)).toBeNull();
  });

  it("handles a same-day threshold without dividing by zero", () => {
    const immediate = { ...enabled, firstAfterDays: 0 };
    expect(reminderDue(0, immediate)).toBe(1);
    expect(reminderDue(-1, immediate)).toBeNull();
  });
});
