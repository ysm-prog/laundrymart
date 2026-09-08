import { describe, expect, it } from "vitest";
import {
  COLLECTION_DUE_TEXT, WEEKDAYS, collectionDueState, collectionsToRaise,
  describeCollectionSchedule, isCollectionWeekday, isDueOn, weekdayName,
} from "../collections";

describe("the weekday", () => {
  it("is ISO: Monday is 1 and Sunday is 7", () => {
    expect(WEEKDAYS[0]).toEqual({ value: 1, label: "Monday" });
    expect(WEEKDAYS[6]).toEqual({ value: 7, label: "Sunday" });
  });

  it("accepts exactly what the database constraint accepts", () => {
    // The two halves must agree or a form offers a value the write refuses.
    expect(isCollectionWeekday(1)).toBe(true);
    expect(isCollectionWeekday(7)).toBe(true);
    expect(isCollectionWeekday(0)).toBe(false);
    expect(isCollectionWeekday(8)).toBe(false);
    expect(isCollectionWeekday(2.5)).toBe(false);
    expect(isCollectionWeekday("3")).toBe(false);
    expect(isCollectionWeekday(null)).toBe(false);
  });

  it("names a day, and answers null rather than guessing at one it has no name for", () => {
    expect(weekdayName(3)).toBe("Wednesday");
    expect(weekdayName(null)).toBeNull();
    expect(weekdayName(9)).toBeNull();
  });
});

describe("who is due on a date", () => {
  // 2026-09-08 is a Tuesday; 2026-09-13 is a Sunday.
  it("matches the ISO weekday of the date", () => {
    expect(isDueOn({ collection_weekday: 2, collection_board_id: null }, "2026-09-08")).toBe(true);
    expect(isDueOn({ collection_weekday: 3, collection_board_id: null }, "2026-09-08")).toBe(false);
  });

  it("treats Sunday as 7, not 0 — the off-by-one that would silently skip a day", () => {
    expect(isDueOn({ collection_weekday: 7, collection_board_id: null }, "2026-09-13")).toBe(true);
    expect(isDueOn({ collection_weekday: 0, collection_board_id: null }, "2026-09-13")).toBe(false);
  });

  it("is never due when no day is set, whatever else is", () => {
    expect(isDueOn({ collection_weekday: null, collection_board_id: "b1" }, "2026-09-08")).toBe(false);
  });
});

describe("what can be done about a due customer", () => {
  const base = { status: "active", boardId: "b1", hasStop: false };

  it("is ready when the customer is active, has a round, and has no stop yet", () => {
    expect(collectionDueState(base)).toBe("ready");
  });

  it("says so when the stop already exists, so pressing again is safe and visible", () => {
    expect(collectionDueState({ ...base, hasStop: true })).toBe("on_the_run");
  });

  it("does not resume a standing collection for a paused customer", () => {
    // A weekly arrangement that quietly restarted for a business that asked to
    // stop would send a van to a customer who had said no.
    for (const status of ["on_hold", "inactive", "prospect", "archived", null]) {
      expect(collectionDueState({ ...base, status })).toBe("paused");
    }
  });

  it("distinguishes 'no round' from 'paused', because the fixes differ", () => {
    expect(collectionDueState({ ...base, boardId: null })).toBe("no_round");
    expect(COLLECTION_DUE_TEXT.no_round).not.toBe(COLLECTION_DUE_TEXT.paused);
  });

  it("counts an existing stop before anything else, so a paused customer already on the van is not reported as skipped", () => {
    expect(collectionDueState({ status: "on_hold", boardId: "b1", hasStop: true })).toBe("on_the_run");
  });
});

describe("what a press would actually create", () => {
  it("is only the ready ones", () => {
    const due = [
      { id: "a", status: "active", boardId: "b1", hasStop: false },
      { id: "b", status: "active", boardId: "b1", hasStop: true },
      { id: "c", status: "active", boardId: null, hasStop: false },
      { id: "d", status: "on_hold", boardId: "b1", hasStop: false },
    ];
    expect(collectionsToRaise(due).map((entry) => entry.id)).toEqual(["a"]);
  });
});

describe("the arrangement in a sentence", () => {
  it("names the day and the round", () => {
    expect(describeCollectionSchedule({ collection_weekday: 4, collection_board_id: "b1" }, "Board 2"))
      .toBe("Collected every Thursday by Board 2.");
  });

  it("says a day with no round will not reach a van — a legal state, not a broken one", () => {
    const text = describeCollectionSchedule({ collection_weekday: 4, collection_board_id: null });
    expect(text).toContain("Thursday");
    expect(text).toContain("No round is set");
  });

  it("says a round with no day does nothing, because the database allows it", () => {
    // 0047 polices only what it can answer from another row; this sentence is
    // what tells somebody the half the database let through is inert.
    expect(describeCollectionSchedule({ collection_weekday: null, collection_board_id: "b1" }))
      .toContain("no day is");
  });

  it("says nothing decorative when there is no arrangement at all", () => {
    expect(describeCollectionSchedule({ collection_weekday: null, collection_board_id: null }))
      .toBe("No standing collection.");
  });
});
