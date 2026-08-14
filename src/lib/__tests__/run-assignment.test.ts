import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_STATUS, checkAssignable, checkAssignmentRemovable, checkConfirmLoad,
  checkRunStart, checkStartRoute, describeProgress, dispatchableJobs, groupDriverDay,
  isUnassignedDeliveryWork, jobProgress, loadableJobs, preferredRunDate, runStage,
  stopProgress,
} from "@/lib/domain/run-assignment";
import { ORDER_STATUSES } from "@/lib/domain/laundry-orders";

/**
 * The rules of giving a job to a driver for a day.
 *
 * These are asserted twice in this repository on purpose — here in English and
 * in `supabase/tests/run_assignment.test.sql` against the triggers. This file is
 * what stops the screen from *offering* something the database will refuse; that
 * one is what stops anything else from doing it anyway.
 */

const READY = {
  status: "ready_for_delivery", delivery_required: true, assigned_driver_id: null,
};

describe("checkAssignable", () => {
  it("allows a ready-for-delivery delivery job with no driver", () => {
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

  it("refuses a job that already has a driver, unless reassigning", () => {
    const assigned = { status: "assigned", delivery_required: true, assigned_driver_id: "d1" };
    const fresh = checkAssignable(assigned);
    expect(fresh.ok).toBe(false);
    expect(fresh.ok === false && fresh.reason).toMatch(/already assigned to another driver/i);

    expect(checkAssignable(assigned, { allowAssigned: true })).toEqual({ ok: true });
  });

  it("still refuses an ineligible job when reassigning", () => {
    // The reassign path relaxes exactly one rule. A cancelled job does not
    // become assignable because someone pressed the other button.
    expect(checkAssignable(
      { status: "cancelled", delivery_required: true, assigned_driver_id: "d1" },
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
    expect(isUnassignedDeliveryWork({ ...READY, assigned_driver_id: "d1" })).toBe(false);
    expect(isUnassignedDeliveryWork({ ...READY, status: "out_for_delivery" })).toBe(false);
    expect(ASSIGNABLE_STATUS).toBe("ready_for_delivery");
  });
});

describe("checkAssignmentRemovable", () => {
  it("allows an assigned job to have its driver taken away", () => {
    expect(checkAssignmentRemovable({
      status: "assigned", delivery_required: true, assigned_driver_id: "d1",
    })).toEqual({ ok: true });
  });

  it("refuses a job that has no driver to remove", () => {
    const result = checkAssignmentRemovable(READY);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/not assigned/i);
  });

  it("refuses removal once the job has left, and points at reassignment", () => {
    // The driver is holding it somewhere. Putting it back in the ready queue
    // would have the office believe it is on the shelf.
    const result = checkAssignmentRemovable({
      status: "out_for_delivery", delivery_required: true, assigned_driver_id: "d1",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/reassign/i);
  });

  it("refuses removal on a finished job", () => {
    expect(checkAssignmentRemovable({
      status: "completed", delivery_required: true, assigned_driver_id: "d1",
    }).ok).toBe(false);
  });
});

describe("groupDriverDay", () => {
  const day = [
    { status: "assigned" as const },
    { status: "out_for_delivery" as const },
    { status: "completed" as const },
    { status: "assigned" as const },
  ];

  it("splits a day into the three groups the driver reads, in order", () => {
    const grouped = groupDriverDay(day);
    expect(grouped.toDeliver).toHaveLength(2);
    expect(grouped.outForDelivery).toHaveLength(1);
    expect(grouped.completed).toHaveLength(1);
  });

  it("counts outstanding work as everything not yet delivered", () => {
    const grouped = groupDriverDay(day);
    expect(grouped.outstanding).toBe(3);
    expect(grouped.total).toBe(4);
  });

  it("keeps completed work in the day rather than dropping it", () => {
    // Coming back to an earlier date has to still show what happened on it,
    // and a job the driver has just delivered should move, not vanish.
    expect(groupDriverDay([{ status: "completed" }]).completed).toHaveLength(1);
  });

  it("does not put an unknown status in any group", () => {
    const grouped = groupDriverDay([{ status: "cancelled" }]);
    expect(grouped.toDeliver.concat(grouped.outForDelivery, grouped.completed)).toHaveLength(0);
    expect(grouped.total).toBe(1);
  });
});

describe("confirm load and start route", () => {
  const assigned = (load_confirmed_at: string | null) =>
    ({ status: "assigned" as const, load_confirmed_at });

  it("offers to load the assigned jobs that are not confirmed yet", () => {
    const jobs = [assigned(null), assigned("2026-08-16T21:00:00Z"), { status: "completed" }];
    expect(loadableJobs(jobs)).toHaveLength(1);
    const result = checkConfirmLoad(jobs);
    expect(result.ok).toBe(true);
    expect(result.ok && result.jobs).toHaveLength(1);
  });

  it("refuses a second Confirm Load when everything is already confirmed", () => {
    const result = checkConfirmLoad([assigned("2026-08-16T21:00:00Z")]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/already confirmed/i);
  });

  it("refuses Confirm Load on a day with nothing assigned", () => {
    const result = checkConfirmLoad([{ status: "completed" }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/nothing assigned/i);
  });

  it("sends out only the jobs that were actually loaded", () => {
    // This is the whole reason load confirmation is tracked per job: work
    // assigned after the driver loaded the van is not on it, and Start Route
    // must not claim it left the depot.
    const jobs = [assigned("2026-08-16T21:00:00Z"), assigned(null)];
    expect(dispatchableJobs(jobs)).toHaveLength(1);
    const result = checkStartRoute(jobs);
    expect(result.ok).toBe(true);
    expect(result.ok && result.jobs).toHaveLength(1);
  });

  it("refuses Start Route before anything has been loaded, and says so", () => {
    const result = checkStartRoute([assigned(null)]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/confirm the load/i);
  });

  it("refuses Start Route when the loaded work has already gone out", () => {
    const result = checkStartRoute([{ status: "out_for_delivery", load_confirmed_at: "x" }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/no loaded jobs left/i);
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
