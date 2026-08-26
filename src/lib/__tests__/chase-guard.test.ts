import { describe, expect, it } from "vitest";
import { chaseBlockedBecause, reminderDue } from "@/lib/notifications/settings";

/**
 * The rules that decide whether a real business gets a debt-collection email.
 *
 * Worth pinning tightly, because the failure is not a broken screen — it is a
 * customer being told they owe money they may not owe, under the laundry's own
 * name. `reminderDue` answers *when*; `chaseBlockedBecause` answers *whether*,
 * and the second was added when wiring the mail provider made the first
 * dangerous on this deployment's imported data.
 */

const sent = {
  emailedTo: "accounts@customer.test",
  remindersEnabled: null,
  billingEmail: "accounts@customer.test",
};

const CADENCE = { enabled: true, firstAfterDays: 7, repeatEveryDays: 7, maxReminders: 3 };

describe("who may be chased", () => {
  it("lets through an invoice this app actually sent", () => {
    expect(chaseBlockedBecause(sent)).toBeNull();
  });

  it("never chases an invoice this app did not send", () => {
    // The one that matters. Every invoice on the live deployment is an imported
    // MYOB header with a null `emailed_to` and no payment rows behind it —
    // chasing one would assert a debt this app cannot see the settlement of.
    expect(chaseBlockedBecause({ ...sent, emailedTo: null })).toBe("never-sent");
  });

  it("respects a customer who opted out, even on an invoice we did send", () => {
    // Their preference outranks everything, so this is asserted on the path
    // where every other condition passes — otherwise the test would pass for
    // the wrong reason.
    expect(chaseBlockedBecause({ ...sent, remindersEnabled: false })).toBe("reminders-off");
  });

  it("treats an unset preference as no objection, not as opt-out", () => {
    // `null` is "the old books said nothing", which is not the same as "no".
    // Reading it as opt-out would silently disable the feature for everybody.
    expect(chaseBlockedBecause({ ...sent, remindersEnabled: null })).toBeNull();
    expect(chaseBlockedBecause({ ...sent, remindersEnabled: true })).toBeNull();
  });

  it("has nowhere to send it without a billing address", () => {
    expect(chaseBlockedBecause({ ...sent, billingEmail: null })).toBe("no-address");
  });
});

describe("when a chase falls due", () => {
  it("says nothing before the terms have passed", () => {
    expect(reminderDue(0, CADENCE)).toBeNull();
    expect(reminderDue(6, CADENCE)).toBeNull();
  });

  it("fires on the day, and only on the day", () => {
    expect(reminderDue(7, CADENCE)).toBe(1);
    expect(reminderDue(8, CADENCE)).toBeNull();
    expect(reminderDue(14, CADENCE)).toBe(2);
    expect(reminderDue(21, CADENCE)).toBe(3);
  });

  it("stops after the third, however old the invoice gets", () => {
    // This is what keeps a 2011 invoice out of the chase on its own: the live
    // deployment holds 400 past-due invoices older than 21 days, and every one
    // of them returns null here. It is the second line of defence behind
    // `chaseBlockedBecause`, not the first — a cadence that happened to land on
    // a weekly boundary would otherwise be the only thing standing in the way.
    expect(reminderDue(28, CADENCE)).toBeNull();
    expect(reminderDue(5_313, CADENCE)).toBeNull();
  });

  it("says nothing at all when the owner has the chase switched off", () => {
    expect(reminderDue(7, { ...CADENCE, enabled: false })).toBeNull();
  });
});
