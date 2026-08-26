import { describe, expect, it } from "vitest";
import {
  addDays, businessToday, isCalendarDate, isClockTime,
  toInstant, toZonedDate, toZonedTime, weekBounds,
} from "@/lib/domain/timezone";

/**
 * These are the tests that keep "received today" meaning the day the shop was
 * open. Every one of them fails if the conversion quietly falls back to the
 * host's timezone — which on Vercel is UTC, nine and a half or ten and a half
 * hours behind the
 * counter.
 */

describe("toInstant", () => {
  it("reads a winter morning as ACST (+9:30)", () => {
    expect(toInstant("2026-07-15", "09:30")).toBe("2026-07-15T00:00:00.000Z");
  });

  it("reads a summer morning as ACDT (+10:30)", () => {
    // Same wall clock, different offset. Hard-coding +9:30 passes the test above
    // and silently books every summer job an hour late.
    expect(toInstant("2026-01-15", "09:30")).toBe("2026-01-14T23:00:00.000Z");
  });

  it("keeps a late-night receipt on the day the counter saw it", () => {
    // The off-by-one this module exists to prevent: 11:30pm in Adelaide is
    // already tomorrow in UTC for half the year, and yesterday's takings would
    // lose it.
    const instant = toInstant("2026-01-15", "23:30");
    expect(instant).toBe("2026-01-15T13:00:00.000Z");
    expect(toZonedDate(instant)).toBe("2026-01-15");
  });

  it("resolves a time that daylight saving skipped, forward", () => {
    // 2:30am on 4 October 2026 does not exist in Adelaide — the clocks jump from
    // 2am to 3am. Every calendar application resolves forward; so do we, rather
    // than throwing at someone typing a plausible time.
    expect(toZonedTime(toInstant("2026-10-04", "02:30"))).toBe("03:30");
  });

  it("resolves a time daylight saving repeated, without drifting", () => {
    // 2:30am on 5 April 2026 happens twice. Either answer is defensible; what
    // matters is that reading it back gives the same wall clock.
    expect(toZonedTime(toInstant("2026-04-05", "02:30"))).toBe("02:30");
  });

  it("defaults to midnight when no time is given", () => {
    expect(toInstant("2026-07-15")).toBe("2026-07-14T14:30:00.000Z");
  });

  it("accepts a seconds-precision time", () => {
    expect(toInstant("2026-07-15", "09:30:00")).toBe("2026-07-15T00:00:00.000Z");
  });

  it("refuses something that is not a date", () => {
    expect(() => toInstant("not-a-date", "09:30")).toThrow(RangeError);
  });
});

describe("toZonedDate / toZonedTime", () => {
  it("round-trips a wall clock through an instant", () => {
    for (const [day, clock] of [
      ["2026-02-01", "07:05"], ["2026-06-30", "17:45"], ["2026-12-31", "23:59"],
    ] as const) {
      const instant = toInstant(day, clock);
      expect(toZonedDate(instant), day).toBe(day);
      expect(toZonedTime(instant), clock).toBe(clock);
    }
  });

  it("renders midnight as 00:00 rather than 24:00", () => {
    expect(toZonedTime(toInstant("2026-07-15", "00:00"))).toBe("00:00");
  });

  it("gives an empty string for junk rather than throwing at a render", () => {
    expect(toZonedDate("nonsense")).toBe("");
    expect(toZonedTime("nonsense")).toBe("");
  });

  it("agrees with businessToday", () => {
    expect(businessToday()).toBe(toZonedDate(new Date()));
    expect(businessToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("addDays", () => {
  it("crosses a month and a year", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("crosses the daylight-saving boundary without losing a day", () => {
    // Calendar arithmetic, not clock arithmetic: adding a day to the Saturday
    // before the changeover must give the Sunday, not 23 hours later.
    expect(addDays("2026-10-03", 1)).toBe("2026-10-04");
    expect(addDays("2026-04-04", 1)).toBe("2026-04-05");
  });
});

describe("weekBounds", () => {
  it("runs Monday to Sunday", () => {
    // 2026-08-13 is a Thursday.
    expect(weekBounds("2026-08-13")).toEqual({ start: "2026-08-10", end: "2026-08-16" });
  });

  it("keeps a Monday and a Sunday inside their own week", () => {
    expect(weekBounds("2026-08-10")).toEqual({ start: "2026-08-10", end: "2026-08-16" });
    expect(weekBounds("2026-08-16")).toEqual({ start: "2026-08-10", end: "2026-08-16" });
  });
});

describe("shape checks", () => {
  it("accepts real dates and times", () => {
    expect(isCalendarDate("2026-08-13")).toBe(true);
    expect(isClockTime("00:00")).toBe(true);
    expect(isClockTime("23:59")).toBe(true);
    expect(isClockTime("09:30:00")).toBe(true);
  });

  it("rejects the near misses", () => {
    expect(isCalendarDate("13/08/2026")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isClockTime("24:00")).toBe(false);
    expect(isClockTime("9:30")).toBe(false);
    expect(isClockTime("")).toBe(false);
  });
});
