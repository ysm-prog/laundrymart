import { describe, expect, it } from "vitest";
import {
  checkSequence, isMovable, isReordered, lockReason, moveStop, moveStopTo,
  parseSequencePlan, type OrderableStop,
} from "../sequence";

const stop = (id: string, over: Partial<OrderableStop> = {}): OrderableStop => ({
  id, status: "assigned", progress_status: "not_started", ...over,
});

const A = "11111111-1111-4111-8111-11111111111a";
const B = "11111111-1111-4111-8111-11111111111b";
const C = "11111111-1111-4111-8111-11111111111c";
const BOARD = "22222222-2222-4222-8222-222222222222";

describe("parseSequencePlan", () => {
  it("reads what the board actually posts", () => {
    // The producer sends one hidden field holding JSON, so the string form is
    // the shape that matters — the planner shipped broken for its whole life
    // because nothing tested the payload its board really emitted.
    const posted = JSON.stringify({ board_id: BOARD, date: "2026-08-21", stops: [C, A, B] });
    const result = parseSequencePlan(posted);
    expect(result.ok).toBe(true);
    expect(result.ok && result.plan.stops).toEqual([C, A, B]);
    expect(result.ok && result.plan.date).toBe("2026-08-21");
  });

  it("accepts an already-parsed object too", () => {
    expect(parseSequencePlan({ board_id: BOARD, date: "2026-08-21", stops: [A] }).ok).toBe(true);
  });

  it("says the order could not be read rather than reporting an empty one", () => {
    const broken = parseSequencePlan("{not json");
    expect(broken.ok).toBe(false);
    expect(broken.ok === false && broken.error).toMatch(/could not be read/i);
  });

  it("refuses a missing date, which is exactly how the planner was broken", () => {
    const result = parseSequencePlan({ board_id: BOARD, stops: [A] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/date/i);
  });

  it("refuses an empty order", () => {
    expect(parseSequencePlan({ board_id: BOARD, date: "2026-08-21", stops: [] }).ok).toBe(false);
  });
});

describe("isMovable / lockReason", () => {
  it("moves a stop nobody has arrived at yet", () => {
    expect(isMovable(stop(A))).toBe(true);
    expect(lockReason(stop(A))).toBeNull();
  });

  it("freezes a stop the round is standing at", () => {
    const arrived = stop(A, { progress_status: "at_customer" });
    expect(isMovable(arrived)).toBe(false);
    expect(lockReason(arrived)).toBe("Round on site");
  });

  it("freezes a delivered or cancelled stop", () => {
    expect(lockReason(stop(A, { status: "completed" }))).toBe("Delivered");
    expect(lockReason(stop(A, { status: "cancelled" }))).toBe("Cancelled");
  });
});

describe("checkSequence", () => {
  const stops = [stop(A), stop(B), stop(C)];

  it("accepts any order of the whole run", () => {
    expect(checkSequence([C, A, B], stops)).toEqual({ ok: true });
    expect(checkSequence([A, B, C], stops)).toEqual({ ok: true });
  });

  it("refuses a stop that is no longer on the run", () => {
    const result = checkSequence([A, B, "33333333-3333-4333-8333-333333333333"], stops);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not on this run/i);
  });

  it("refuses an order that drops a stop, rather than losing the visit", () => {
    const result = checkSequence([A, B], stops);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/missing a stop/i);
  });

  it("refuses the same stop listed twice", () => {
    const result = checkSequence([A, A, B], stops);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/twice/i);
  });

  it("refuses moving a stop the round has already worked", () => {
    const worked = [stop(A, { progress_status: "delivery_completed" }), stop(B), stop(C)];
    const result = checkSequence([B, A, C], worked);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/already worked/i);
  });

  it("still allows reordering the stops after a worked one", () => {
    const worked = [stop(A, { progress_status: "delivery_completed" }), stop(B), stop(C)];
    expect(checkSequence([A, C, B], worked)).toEqual({ ok: true });
  });
});

describe("moveStop", () => {
  it("swaps with the neighbour", () => {
    expect(moveStop([A, B, C], B, "up")).toEqual([B, A, C]);
    expect(moveStop([A, B, C], B, "down")).toEqual([A, C, B]);
  });

  it("does nothing at either end rather than complaining", () => {
    expect(moveStop([A, B, C], A, "up")).toEqual([A, B, C]);
    expect(moveStop([A, B, C], C, "down")).toEqual([A, B, C]);
  });

  it("does nothing for a stop that is not there", () => {
    expect(moveStop([A, B], C, "up")).toEqual([A, B]);
  });
});

describe("moveStopTo", () => {
  it("drops a stop at an arbitrary position", () => {
    expect(moveStopTo([A, B, C], C, 0)).toEqual([C, A, B]);
    expect(moveStopTo([A, B, C], A, 2)).toEqual([B, C, A]);
  });

  it("is a no-op for the same position or an impossible one", () => {
    expect(moveStopTo([A, B, C], A, 0)).toEqual([A, B, C]);
    expect(moveStopTo([A, B, C], A, 9)).toEqual([A, B, C]);
    expect(moveStopTo([A, B, C], A, -1)).toEqual([A, B, C]);
  });
});

describe("isReordered", () => {
  it("knows when nothing changed, so Save can stay disabled", () => {
    expect(isReordered([A, B, C], [A, B, C])).toBe(false);
    expect(isReordered([A, C, B], [A, B, C])).toBe(true);
    expect(isReordered([A, B], [A, B, C])).toBe(true);
  });
});
