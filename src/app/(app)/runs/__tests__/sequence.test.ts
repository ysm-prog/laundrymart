import { describe, expect, it } from "vitest";
import {
  SEQUENCE_CONFLICT, SEQUENCE_SAVED, buildSequenceAudit,
  checkSequence, isMovable, isReordered, lockReason, movedCount, moveStop, moveStopTo,
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
    const posted = JSON.stringify({
      board_id: BOARD, date: "2026-08-21", stops: [C, A, B], expected_version: 3,
    });
    const result = parseSequencePlan(posted);
    expect(result.ok).toBe(true);
    expect(result.ok && result.plan.stops).toEqual([C, A, B]);
    expect(result.ok && result.plan.date).toBe("2026-08-21");
    expect(result.ok && result.plan.expected_version).toBe(3);
  });

  it("accepts an already-parsed object too", () => {
    expect(parseSequencePlan(
      { board_id: BOARD, date: "2026-08-21", stops: [A], expected_version: 1 },
    ).ok).toBe(true);
  });

  it("says the order could not be read rather than reporting an empty one", () => {
    const broken = parseSequencePlan("{not json");
    expect(broken.ok).toBe(false);
    expect(broken.ok === false && broken.error).toMatch(/could not be read/i);
  });

  it("refuses a missing date, which is exactly how the planner was broken", () => {
    const result = parseSequencePlan({ board_id: BOARD, stops: [A], expected_version: 1 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/date/i);
  });

  it("refuses an empty order", () => {
    expect(parseSequencePlan(
      { board_id: BOARD, date: "2026-08-21", stops: [], expected_version: 1 },
    ).ok).toBe(false);
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

describe("the concurrency token (§14)", () => {
  // The version is the whole of the protection against two managers editing the
  // same day, so a payload that omits it must not parse. The alternative — a
  // schema that defaults it to 1 — would mean every stale page silently claimed
  // to be current, which is precisely the failure this exists to prevent.
  it("refuses a plan with no version, so a save can never be unversioned", () => {
    const result = parseSequencePlan({ board_id: BOARD, date: "2026-08-21", stops: [A] });
    expect(result.ok).toBe(false);
  });

  it("refuses a version that is not a whole number at or above 1", () => {
    const base = { board_id: BOARD, date: "2026-08-21", stops: [A] };
    expect(parseSequencePlan({ ...base, expected_version: 0 }).ok).toBe(false);
    expect(parseSequencePlan({ ...base, expected_version: 1.5 }).ok).toBe(false);
    expect(parseSequencePlan({ ...base, expected_version: "2" }).ok).toBe(false);
  });

  it("names the run rather than the column when somebody else saved first", () => {
    // Pinned because three places must agree on this sentence: the action's own
    // pre-check, the sentence mapped from the database's refusal when two saves
    // race past it, and the requirement that asked for it.
    expect(SEQUENCE_CONFLICT).toMatch(/updated by another user/i);
    expect(SEQUENCE_CONFLICT).toMatch(/reload/i);
    expect(SEQUENCE_CONFLICT).not.toMatch(/sequence_version|daily_routes|constraint/);
  });

  it("says the run is locked again when a save lands", () => {
    expect(SEQUENCE_SAVED).toBe("Run sequence updated successfully. The run has been locked.");
  });
});

describe("movedCount", () => {
  it("counts nothing when the order is unchanged", () => {
    expect(movedCount([A, B, C], [A, B, C])).toBe(0);
  });

  it("counts every stop whose position actually changed, not the drags", () => {
    // One drag — C to the front — but three stops end up somewhere new. Saying
    // "1 stop moved" would be a wrong answer that looks right.
    expect(movedCount([A, B, C], [C, A, B])).toBe(3);
  });

  it("counts only the two that swapped, leaving the rest alone", () => {
    expect(movedCount([A, B, C], [B, A, C])).toBe(2);
  });
});

describe("what the board actually posts", () => {
  // The producer sends one hidden field holding JSON. This repository has
  // shipped two such payloads broken behind a green `verify` — the job form's
  // items and the dispatch planner's whole board, refused on every press for its
  // entire shipped life — so the round trip is asserted against the exact string
  // the component builds rather than against an object written by hand here.
  const posted = (order: string[], version: number) =>
    JSON.stringify({ board_id: BOARD, date: "2026-08-21", stops: order, expected_version: version });

  it("round-trips the field the component emits", () => {
    const result = parseSequencePlan(posted([C, A, B], 7));
    expect(result.ok).toBe(true);
    expect(result.ok && result.plan).toEqual({
      board_id: BOARD, date: "2026-08-21", stops: [C, A, B], expected_version: 7,
    });
  });

  it("survives a save and reparse of the order it just produced", () => {
    const first = parseSequencePlan(posted([A, B, C], 1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = parseSequencePlan(posted(moveStop(first.plan.stops, C, "up"), 2));
    expect(again.ok && again.plan.stops).toEqual([A, C, B]);
    expect(again.ok && again.plan.expected_version).toBe(2);
  });
});

describe("the audit record (§15, §23)", () => {
  const RUN = "44444444-4444-4444-8444-444444444444";
  const ACTOR = "55555555-5555-4555-8555-555555555555";
  const audit = (over: Partial<Parameters<typeof buildSequenceAudit>[0]> = {}) =>
    buildSequenceAudit({
      boardId: BOARD, date: "2026-08-25", runIds: [RUN],
      previous: [A, B, C], next: [C, A, B],
      actorId: ACTOR, role: "operations_manager", version: 4, ...over,
    });

  it("records every field the requirement names", () => {
    // Driven off the requirement's own list rather than off the implementation,
    // so a field quietly dropped from the record fails here.
    const record = audit();
    expect(record.entity).toBe("daily_route");
    expect(record.entityId).toBe(RUN);
    expect(record.action).toBe("update");
    for (const key of [
      "boardId", "runDate", "previousSequence", "newSequence", "changedBy", "role",
    ] as const) {
      expect(record.metadata[key], `missing ${key}`).toBeDefined();
    }
    expect(record.metadata.boardId).toBe(BOARD);
    expect(record.metadata.runDate).toBe("2026-08-25");
    expect(record.metadata.changedBy).toBe(ACTOR);
    expect(record.metadata.role).toBe("operations_manager");
  });

  it("keeps both orders in full, not a count of what moved", () => {
    // The question an audit log gets asked about a run that went wrong is "what
    // was it before?", and a movement count cannot answer it.
    const record = audit();
    expect(record.metadata.previousSequence).toEqual([A, B, C]);
    expect(record.metadata.newSequence).toEqual([C, A, B]);
  });

  it("does not stamp its own time", () => {
    // `audit_logs.created_at` defaults to now() in the database. A second answer
    // to when this happened would be the wrong one.
    expect(Object.keys(audit().metadata)).not.toContain("timestamp");
    expect(Object.keys(audit().metadata)).not.toContain("at");
  });

  it("copies the orders rather than holding the caller's arrays", () => {
    // The action passes arrays it still owns. A record that aliased them would
    // change after the fact, which is the one thing an audit row must not do.
    const previous = [A, B, C];
    const next = [C, A, B];
    const record = buildSequenceAudit({
      boardId: BOARD, date: "2026-08-25", runIds: [RUN],
      previous, next, actorId: ACTOR, role: "super_admin", version: 2,
    });
    previous.push("mutated");
    next.length = 0;
    expect(record.metadata.previousSequence).toEqual([A, B, C]);
    expect(record.metadata.newSequence).toEqual([C, A, B]);
  });

  it("agrees with the sentence it writes", () => {
    const record = audit();
    expect(record.metadata.movedCount).toBe(movedCount([A, B, C], [C, A, B]));
    expect(record.summary).toContain(`${record.metadata.movedCount} stop(s) moved`);
    expect(record.summary).toContain("2026-08-25");
  });

  it("names the run it changed, falling back to the board when there is none", () => {
    expect(audit({ runIds: [] }).entityId).toBe(BOARD);
    expect(audit().metadata.runIds).toEqual([RUN]);
  });

  it("records the version the save produced, so a trail can be replayed in order", () => {
    expect(audit({ version: 9 }).metadata.sequenceVersion).toBe(9);
  });
});
