import { describe, expect, it } from "vitest";
import { UNASSIGNED, parseDispatchPlan } from "../plan";

/**
 * The board's payload, as `PlannerBoard.toPlan` builds it.
 *
 * This file exists because the two disagreed. Until 2026-08-14 the board posted
 * `{columns:[{id,…}]}` with no date on it at all, while `planSchema` read
 * `{date, columns:[{routeId,…}]}` — so **every** "Apply plan" was refused, and
 * the planner had never once committed a plan. The schema sat inside a
 * `"use server"` module, so nothing could compare the two shapes anywhere but
 * production.
 *
 * `toPlan` now returns `DispatchPlan`, which makes the common case a compile
 * error. These assertions cover what the type cannot: the literal strings, the
 * tray's sentinel id, and the empty-string crew fields.
 */

const ROUTE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const JOB = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const DRIVER = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";

/** One crewless run and the unassigned tray — the state a fresh board is in. */
const POSTED = {
  date: "2026-08-14",
  columns: [
    { routeId: UNASSIGNED, jobIds: [JOB], driverId: "", vehicleId: "" },
    { routeId: ROUTE, jobIds: [], driverId: "", vehicleId: "" },
  ],
};

describe("parseDispatchPlan", () => {
  it("accepts the payload the board actually posts", () => {
    const result = parseDispatchPlan(JSON.stringify(POSTED));
    expect(result.ok ? "accepted" : `rejected: ${result.problem}`).toBe("accepted");
    if (!result.ok) return;
    expect(result.plan.date).toBe("2026-08-14");
    expect(result.plan.columns[0]?.routeId).toBe(UNASSIGNED);
  });

  it("carries the crew when one is picked", () => {
    const result = parseDispatchPlan(JSON.stringify({
      ...POSTED,
      columns: [{ routeId: ROUTE, jobIds: [JOB], driverId: DRIVER, vehicleId: "" }],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.columns[0]).toMatchObject({ driverId: DRIVER, vehicleId: "" });
  });

  it("refuses a plan with no date — the shape that shipped broken", () => {
    const { date: _date, ...noDate } = POSTED;
    const result = parseDispatchPlan(JSON.stringify(noDate));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("date");
  });

  it("refuses a column keyed `id` — the other half of the same break", () => {
    const result = parseDispatchPlan(JSON.stringify({
      date: POSTED.date,
      columns: [{ id: ROUTE, jobIds: [], driverId: "", vehicleId: "" }],
    }));
    expect(result.ok).toBe(false);
  });

  it("says the plan could not be read rather than throwing", () => {
    for (const bad of ["{not json", "", null, undefined]) {
      const result = parseDispatchPlan(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toContain("could not be read");
    }
  });

  it("refuses more columns and stops than a day can hold", () => {
    const column = { routeId: ROUTE, jobIds: [], driverId: "", vehicleId: "" };
    expect(parseDispatchPlan(JSON.stringify({
      date: POSTED.date, columns: Array.from({ length: 61 }, () => column),
    })).ok).toBe(false);
    expect(parseDispatchPlan(JSON.stringify({
      date: POSTED.date,
      columns: [{ ...column, jobIds: Array.from({ length: 501 }, () => JOB) }],
    })).ok).toBe(false);
  });
});
