import { describe, expect, it } from "vitest";
import {
  describePattern,
  expandPattern,
  generateServiceDates,
  parsePattern,
  type ServicePattern,
} from "../service-calendar";

// March 2026: 2nd is a Monday, so weeks start 2, 9, 16, 23, 30.
const MARCH = { from: "2026-03-01", to: "2026-03-31" } as const;

describe("expandPattern", () => {
  it("expands a Mon/Wed/Fri weekly pattern", () => {
    const dates = expandPattern({ type: "weekly", weekdays: [1, 3, 5] }, MARCH.from, "2026-03-14");
    expect(dates).toEqual([
      "2026-03-02", "2026-03-04", "2026-03-06",
      "2026-03-09", "2026-03-11", "2026-03-13",
    ]);
  });

  it("expands alternate Mondays from the anchor week", () => {
    const pattern: ServicePattern = {
      type: "alternate_weekly", weekdays: [1], anchorDate: "2026-03-02",
    };
    expect(expandPattern(pattern, MARCH.from, MARCH.to)).toEqual([
      "2026-03-02", "2026-03-16", "2026-03-30",
    ]);
  });

  it("keeps alternate weeks aligned for dates before the anchor", () => {
    const pattern: ServicePattern = {
      type: "alternate_weekly", weekdays: [1], anchorDate: "2026-03-30",
    };
    // Counting backwards two weeks at a time from 30 Mar lands on 16 and 2 Mar.
    expect(expandPattern(pattern, MARCH.from, MARCH.to)).toEqual([
      "2026-03-02", "2026-03-16", "2026-03-30",
    ]);
  });

  it("expands 'first Monday of the month' across a quarter", () => {
    const pattern: ServicePattern = { type: "monthly_nth", weekday: 1, nth: 1 };
    expect(expandPattern(pattern, "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-05", "2026-02-02", "2026-03-02", "2026-04-06",
    ]);
  });

  it("expands 'last Friday of the month'", () => {
    const pattern: ServicePattern = { type: "monthly_nth", weekday: 5, nth: -1 };
    expect(expandPattern(pattern, "2026-03-01", "2026-05-31")).toEqual([
      "2026-03-27", "2026-04-24", "2026-05-29",
    ]);
  });

  it("returns nothing for an inverted range", () => {
    expect(expandPattern({ type: "weekly", weekdays: [1] }, "2026-03-31", "2026-03-01")).toEqual([]);
  });

  it("clips custom dates to the window and sorts them", () => {
    const pattern: ServicePattern = {
      type: "custom", dates: ["2026-03-20", "2026-02-01", "2026-03-05"],
    };
    expect(expandPattern(pattern, MARCH.from, MARCH.to)).toEqual(["2026-03-05", "2026-03-20"]);
  });
});

describe("generateServiceDates — holiday handling", () => {
  const weekly: ServicePattern = { type: "weekly", weekdays: [1, 3, 5] };
  const holidays = ["2026-03-09"]; // a Monday

  it("skips the visit when the rule is skip", () => {
    const result = generateServiceDates({
      pattern: weekly, from: "2026-03-09", to: "2026-03-13",
      holidays, holidayRule: "skip",
    });
    expect(result.map((r) => r.date)).toEqual(["2026-03-11", "2026-03-13"]);
  });

  it("services as normal when the rule says so", () => {
    const result = generateServiceDates({
      pattern: weekly, from: "2026-03-09", to: "2026-03-11",
      holidays, holidayRule: "service_as_normal",
    });
    expect(result.map((r) => r.date)).toEqual(["2026-03-09", "2026-03-11"]);
    expect(result[0]?.isPublicHoliday).toBe(true);
    expect(result[0]?.movedFromHoliday).toBe(false);
  });

  it("moves to the next business day and records where it came from", () => {
    const result = generateServiceDates({
      pattern: { type: "weekly", weekdays: [1] }, from: "2026-03-09", to: "2026-03-13",
      holidays, holidayRule: "next_business_day",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      date: "2026-03-10", scheduledDate: "2026-03-09", movedFromHoliday: true,
    });
  });

  it("moves to the previous business day", () => {
    const result = generateServiceDates({
      pattern: { type: "weekly", weekdays: [1] }, from: "2026-03-01", to: "2026-03-13",
      holidays, holidayRule: "previous_business_day",
    });
    expect(result.map((r) => r.date)).toEqual(["2026-03-02", "2026-03-06"]);
  });

  it("steps over a run of consecutive holidays and the weekend", () => {
    const result = generateServiceDates({
      pattern: { type: "weekly", weekdays: [5] }, from: "2026-04-01", to: "2026-04-10",
      // Good Friday 3 Apr plus the following Monday.
      holidays: ["2026-04-03", "2026-04-06"], holidayRule: "next_business_day",
    });
    expect(result[0]).toMatchObject({ date: "2026-04-07", scheduledDate: "2026-04-03" });
  });

  it("collapses a moved visit that lands on an existing service day", () => {
    const result = generateServiceDates({
      pattern: { type: "weekly", weekdays: [1, 2] }, from: "2026-03-09", to: "2026-03-10",
      holidays, holidayRule: "next_business_day",
    });
    // Monday moves onto Tuesday, which is already a service day — one visit.
    expect(result.map((r) => r.date)).toEqual(["2026-03-10"]);
    expect(result[0]?.movedFromHoliday).toBe(false);
  });

  it("drops a visit pushed outside the requested window", () => {
    const result = generateServiceDates({
      pattern: { type: "weekly", weekdays: [1] }, from: "2026-03-09", to: "2026-03-09",
      holidays, holidayRule: "next_business_day",
    });
    expect(result).toEqual([]);
  });

  it("clamps to the agreement's own start and end dates", () => {
    const result = generateServiceDates({
      pattern: weekly, from: "2026-03-01", to: "2026-03-31",
      startDate: "2026-03-10", endDate: "2026-03-13",
    });
    expect(result.map((r) => r.date)).toEqual(["2026-03-11", "2026-03-13"]);
  });

  it("flags weekend services so surcharges can be applied", () => {
    const result = generateServiceDates({
      pattern: { type: "weekly", weekdays: [6] }, from: "2026-03-01", to: "2026-03-14",
    });
    expect(result.every((r) => r.isWeekend)).toBe(true);
  });
});

describe("pattern helpers", () => {
  it("describes each pattern in words", () => {
    expect(describePattern({ type: "weekly", weekdays: [1, 3, 5] })).toBe("Every Mon, Wed, Fri");
    expect(describePattern({ type: "monthly_nth", weekday: 1, nth: 1 })).toBe("Monthly on the first Mon");
    expect(describePattern({ type: "monthly_nth", weekday: 5, nth: -1 })).toBe("Monthly on the last Fri");
    expect(describePattern({ type: "alternate_weekly", weekdays: [2], anchorDate: "2026-03-03" }))
      .toBe("Alternate Tue (from 2026-03-03)");
  });

  it("falls back to an empty weekly pattern for malformed jsonb", () => {
    expect(parsePattern({ type: "nonsense" })).toEqual({ type: "weekly", weekdays: [] });
    expect(parsePattern(null)).toEqual({ type: "weekly", weekdays: [] });
  });

  it("round-trips a valid pattern", () => {
    const pattern = { type: "weekly", weekdays: [2, 4] };
    expect(parsePattern(pattern)).toEqual(pattern);
  });
});
