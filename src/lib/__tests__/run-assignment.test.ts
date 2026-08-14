import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_STATUS, checkAssignable, checkRunStart, describeProgress,
  isUnassignedDeliveryWork, jobProgress, preferredRunDate, runStage, stopProgress,
} from "@/lib/domain/run-assignment";
import { ORDER_STATUSES } from "@/lib/domain/laundry-orders";

/**
 * The rules of putting a job on a run.
 *
 * These are asserted twice in this repository on purpose — here in English and
 * in `supabase/tests/run_assignment.test.sql` against the trigger. This file is
 * what stops the screen from *offering* something the database will refuse; that
 * one is what stops anything else from doing it anyway.
 */

const READY = { status: "ready_for_delivery", delivery_required: true, stop_id: null };

describe("checkAssignable", () => {
  it("allows a ready-for-delivery delivery job that is on no run", () => {
    expect(checkAssignable(READY)).toEqual({ ok: true });
  });

  it("refuses a customer pickup, and says why in the customer's terms", () => {
    const result = checkAssignable({ ...READY, delivery_required: false });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/customer pickup/i);
  });

  it("refuses work that has not left the plant", () => {
    for (const status of ["new", "in_progress"] as const) {
      const result = checkAssignable({ ...READY, status });
      expect(result.ok, status).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/not ready for delivery/i);
    }
  });

  it("refuses a finished or cancelled job", () => {
    expect(checkAssignable({ ...READY, status: "completed" }).ok).toBe(false);
    expect(checkAssignable({ ...READY, status: "cancelled" }).ok).toBe(false);
  });

  it("refuses a job that is already on a run, unless reassigning", () => {
    const assigned = { ...READY, stop_id: "stop-1" };
    const fresh = checkAssignable(assigned);
    expect(fresh.ok).toBe(false);
    expect(fresh.ok === false && fresh.reason).toMatch(/already assigned/i);

    expect(checkAssignable(assigned, { allowAssigned: true })).toEqual({ ok: true });
  });

  it("still refuses an ineligible job when reassigning", () => {
    // The reassign path relaxes exactly one rule. A cancelled job does not
    // become dispatchable because someone pressed the other button.
    expect(checkAssignable(
      { status: "cancelled", delivery_required: true, stop_id: "stop-1" },
      { allowAssigned: true },
    ).ok).toBe(false);
  });

  it("gives every status a definite answer", () => {
    // A status added later must not fall through to "allowed" by omission.
    for (const status of ORDER_STATUSES) {
      const result = checkAssignable({ ...READY, status });
      expect(typeof result.ok, status).toBe("boolean");
      if (!result.ok) expect(result.reason.length, status).toBeGreaterThan(0);
    }
  });

  it("agrees with isUnassignedDeliveryWork on what the queue holds", () => {
    expect(isUnassignedDeliveryWork(READY)).toBe(true);
    expect(isUnassignedDeliveryWork({ ...READY, delivery_required: false })).toBe(false);
    expect(isUnassignedDeliveryWork({ ...READY, stop_id: "stop-1" })).toBe(false);
    expect(isUnassignedDeliveryWork({ ...READY, status: "out_for_delivery" })).toBe(false);
    expect(ASSIGNABLE_STATUS).toBe("ready_for_delivery");
  });
});

describe("preferredRunDate", () => {
  it("uses the job's own promised date when it is still ahead", () => {
    expect(preferredRunDate({ due_date: "2026-08-16" }, "2026-08-14")).toBe("2026-08-16");
  });

  it("falls back to the day being planned when the promise has passed", () => {
    // Silently assigning to a day that has already gone is the failure this
    // exists to prevent: the job would vanish from every forward-looking view.
    expect(preferredRunDate({ due_date: "2026-08-10" }, "2026-08-14")).toBe("2026-08-14");
  });

  it("uses the day being planned when the job promises nothing", () => {
    expect(preferredRunDate({ due_date: null }, "2026-08-14")).toBe("2026-08-14");
    expect(preferredRunDate({}, "2026-08-14")).toBe("2026-08-14");
  });
});

describe("runStage", () => {
  it("folds the nine run statuses into the four an operator thinks in", () => {
    expect(runStage("planned")).toBe("not_started");
    expect(runStage("inspection_pending")).toBe("not_started");
    expect(runStage("inspection_complete")).toBe("not_started");
    expect(runStage("load_confirmed")).toBe("not_started");
    expect(runStage("in_progress")).toBe("in_progress");
    expect(runStage("returning")).toBe("in_progress");
    expect(runStage("unloading")).toBe("in_progress");
    expect(runStage("closed")).toBe("completed");
    expect(runStage("cancelled")).toBe("cancelled");
  });
});

describe("checkRunStart", () => {
  it("refuses a run whose load has not been confirmed", () => {
    // The rule belongs to `guard_route_transition`; repeating it here is what
    // turns a failed write into an explanation beside a disabled button.
    const result = checkRunStart({ status: "planned", load_confirmed_at: null });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/confirm the load/i);
  });

  it("allows a loaded run to start", () => {
    expect(checkRunStart({ status: "load_confirmed", load_confirmed_at: "2026-08-14T21:00:00Z" }))
      .toEqual({ ok: true });
  });

  it("allows a loaded run with no stops on it yet", () => {
    // Stops are added through the morning. A driver who cannot press start
    // until dispatch has finished planning is a driver waiting in a car park.
    expect(checkRunStart({ status: "planned", load_confirmed_at: "2026-08-14T21:00:00Z" }).ok)
      .toBe(true);
  });

  it("refuses a run that is finished, cancelled or already moving", () => {
    const loaded = "2026-08-14T21:00:00Z";
    expect(checkRunStart({ status: "closed", load_confirmed_at: loaded }).ok).toBe(false);
    expect(checkRunStart({ status: "cancelled", load_confirmed_at: loaded }).ok).toBe(false);
    expect(checkRunStart({ status: "in_progress", load_confirmed_at: loaded }).ok).toBe(false);
  });
});

describe("progress", () => {
  const stops = [
    { progress_status: "completed", status: "completed" },
    { progress_status: "at_customer", status: "assigned" },
    { progress_status: "not_started", status: "cancelled" },
    { progress_status: "not_started", status: "scheduled" },
  ];

  it("counts a stop as done when it is completed or cancelled", () => {
    // A cancelled stop is not outstanding work, and leaving it in the
    // denominator means a run can never read as finished.
    expect(stopProgress(stops)).toEqual({ total: 4, done: 2 });
  });

  it("counts only delivered laundry as delivered", () => {
    expect(jobProgress([
      { status: "completed" }, { status: "out_for_delivery" }, { status: "ready_for_delivery" },
    ])).toEqual({ total: 3, done: 1 });
  });

  it("says it in words, with the noun agreeing", () => {
    expect(describeProgress({ total: 8, done: 3 }, "stop")).toBe("3 of 8 stops completed");
    expect(describeProgress({ total: 1, done: 0 }, "stop")).toBe("0 of 1 stop completed");
    expect(describeProgress({ total: 11, done: 6 }, "job", "delivered"))
      .toBe("6 of 11 jobs delivered");
  });

  it("does not divide by zero on an empty run", () => {
    expect(stopProgress([])).toEqual({ total: 0, done: 0 });
    expect(describeProgress({ total: 0, done: 0 }, "stop")).toBe("0 of 0 stops completed");
  });
});
