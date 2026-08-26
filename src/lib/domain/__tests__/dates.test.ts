import { describe, expect, it } from "vitest";
import {
  ACTIVITY_PERIOD_PRESETS, BILLING_PERIOD_PRESETS, PERIOD_PRESETS, PERIOD_PRESET_LABELS,
  currentMonth, currentQuarter, currentWeek, financialYear, isPeriodPreset, periodFor,
  periodParams, presetForRange, previousMonth, previousWeek, resolvePeriod,
} from "@/lib/domain/dates";

/**
 * The month-end run's default period.
 *
 * Worth its own tests because every interesting case is a boundary, and the way
 * this fails is silent: a wrong month finds no work and reports "nothing to
 * invoice", which reads as "everything is billed".
 */
describe("previousMonth", () => {
  it("is the whole month before, from any day in the current one", () => {
    expect(previousMonth("2026-09-01")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(previousMonth("2026-09-17")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(previousMonth("2026-09-30")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("crosses the year, which an inline month minus one gets wrong", () => {
    expect(previousMonth("2026-01-01")).toEqual({ start: "2025-12-01", end: "2025-12-31" });
    expect(previousMonth("2026-01-31")).toEqual({ start: "2025-12-01", end: "2025-12-31" });
  });

  it("ends a short month on its own last day", () => {
    expect(previousMonth("2026-03-05")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(previousMonth("2026-05-05")).toEqual({ start: "2026-04-01", end: "2026-04-30" });
  });

  it("handles February in a leap year without a special case", () => {
    expect(previousMonth("2028-03-01")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  it("refuses something that is not a date rather than inventing a period", () => {
    expect(() => previousMonth("not-a-date")).toThrow();
  });
});

describe("period presets", () => {
  it("this month runs 1st to last, and February is right in a leap year", () => {
    expect(currentMonth("2026-08-14")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(currentMonth("2024-02-14")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(currentMonth("2026-02-14")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("weeks run Monday to Sunday", () => {
    // 2026-08-20 is a Thursday.
    expect(currentWeek("2026-08-20")).toEqual({ start: "2026-08-17", end: "2026-08-23" });
    expect(previousWeek("2026-08-20")).toEqual({ start: "2026-08-10", end: "2026-08-16" });
  });

  it("a Sunday belongs to the week that started six days earlier", () => {
    expect(currentWeek("2026-08-23")).toEqual({ start: "2026-08-17", end: "2026-08-23" });
    expect(currentWeek("2026-08-17")).toEqual({ start: "2026-08-17", end: "2026-08-23" });
  });

  it("previous week crosses a year boundary", () => {
    expect(previousWeek("2027-01-07")).toEqual({ start: "2026-12-28", end: "2027-01-03" });
  });

  it("periodFor resolves each preset and gives custom no dates of its own", () => {
    expect(periodFor("last_month", "2026-09-01")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(periodFor("this_month", "2026-09-01")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(periodFor("custom", "2026-09-01")).toBeNull();
  });

  it("today and yesterday are one day each, and yesterday steps over a month end", () => {
    expect(periodFor("today", "2026-09-01")).toEqual({ start: "2026-09-01", end: "2026-09-01" });
    expect(periodFor("yesterday", "2026-09-01")).toEqual({ start: "2026-08-31", end: "2026-08-31" });
  });

  it("all time is unbounded, which is a different answer from no answer", () => {
    // Both `all` and `custom` return null, so a caller has to read the preset to
    // tell "everything" from "the caller kept the dates".
    expect(periodFor("all", "2026-09-01")).toBeNull();
    expect(PERIOD_PRESETS).toContain("all");
  });

  it("presetForRange recognises a bookmarked range rather than falling to custom", () => {
    expect(presetForRange("2026-08-01", "2026-08-31", "2026-09-01")).toBe("last_month");
    expect(presetForRange("2026-08-17", "2026-08-23", "2026-08-20")).toBe("this_week");
    expect(presetForRange("2026-08-03", "2026-08-19", "2026-08-20")).toBe("custom");
  });

  it("every preset has a label", () => {
    for (const preset of PERIOD_PRESETS) {
      expect(PERIOD_PRESET_LABELS[preset]).toBeTruthy();
      expect(isPeriodPreset(preset)).toBe(true);
    }
    expect(isPeriodPreset("last_fortnight")).toBe(false);
    expect(isPeriodPreset("")).toBe(false);
  });

  it("both offered sets are drawn from the canonical presets", () => {
    // A screen may offer fewer windows; it may not invent one, or the same
    // question is asked two ways on two lists.
    for (const preset of [...BILLING_PERIOD_PRESETS, ...ACTIVITY_PERIOD_PRESETS]) {
      expect(PERIOD_PRESETS).toContain(preset);
    }
    // A billing period is one bounded window: "all time" would be an invitation
    // to bill the wrong thing.
    expect(BILLING_PERIOD_PRESETS).not.toContain("all");
    expect(ACTIVITY_PERIOD_PRESETS).toContain("all");
    // Every set ends on Custom, so the escape hatch is always in the same place.
    expect(BILLING_PERIOD_PRESETS.at(-1)).toBe("custom");
    expect(ACTIVITY_PERIOD_PRESETS.at(-1)).toBe("custom");
  });
});

describe("currentQuarter", () => {
  it("is the calendar quarter, which is also the BAS quarter", () => {
    expect(currentQuarter("2026-01-01")).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(currentQuarter("2026-05-17")).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(currentQuarter("2026-08-26")).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(currentQuarter("2026-12-31")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
  });

  it("is right in a leap year, where a month-length table would not be", () => {
    expect(currentQuarter("2028-02-29")).toEqual({ start: "2028-01-01", end: "2028-03-31" });
  });
});

describe("financialYear", () => {
  it("runs 1 July to 30 June, not January to December", () => {
    expect(financialYear("2026-08-26")).toEqual({ start: "2026-07-01", end: "2027-06-30" });
    expect(financialYear("2027-06-30")).toEqual({ start: "2026-07-01", end: "2027-06-30" });
  });

  it("steps to the next year on 1 July, not on 1 January", () => {
    expect(financialYear("2026-06-30")).toEqual({ start: "2025-07-01", end: "2026-06-30" });
    expect(financialYear("2026-07-01")).toEqual({ start: "2026-07-01", end: "2027-06-30" });
    // The calendar new year is mid-FY and must not move it.
    expect(financialYear("2026-01-01")).toEqual({ start: "2025-07-01", end: "2026-06-30" });
  });
});

/**
 * The one reader of a request's period parameters.
 *
 * Everything here arrives off a URL somebody can type, so every case is a
 * "what does junk do" case — and the answer has to be the fallback rather than
 * a throw, which on a server component is a 500 on a list page.
 */
describe("resolvePeriod", () => {
  const today = "2026-08-26";

  it("reads a named preset and resolves it against today", () => {
    expect(resolvePeriod({ period: "last_month" }, today)).toEqual({
      preset: "last_month", range: { start: "2026-07-01", end: "2026-07-31" },
    });
  });

  it("falls back when nothing is asked for, and the caller chooses the fallback", () => {
    expect(resolvePeriod({}, today)).toEqual({ preset: "all", range: null });
    expect(resolvePeriod({}, today, "this_month")).toEqual({
      preset: "this_month", range: { start: "2026-08-01", end: "2026-08-31" },
    });
  });

  it("falls back on junk rather than throwing", () => {
    expect(resolvePeriod({ period: "sometime" }, today, "this_week").preset).toBe("this_week");
    expect(resolvePeriod({ period: "custom", from: "not-a-date", to: "2026-08-26" }, today).preset)
      .toBe("all");
  });

  it("takes a bare from/to pair as a custom range, so an older link still works", () => {
    expect(resolvePeriod({ from: "2026-08-01", to: "2026-08-15" }, today)).toEqual({
      preset: "custom", range: { start: "2026-08-01", end: "2026-08-15" },
    });
  });

  it("refuses half a range and an inverted one", () => {
    // One end alone is a typo, not half a window. Showing an open-ended list
    // for it looks exactly like the filter having been ignored.
    expect(resolvePeriod({ period: "custom", from: "2026-08-01" }, today, "this_month").preset)
      .toBe("this_month");
    expect(resolvePeriod({ period: "custom", from: "2026-08-15", to: "2026-08-01" }, today).preset)
      .toBe("all");
  });

  it("a preset beats stray from/to left in the URL", () => {
    // Pressing a preset chip should not silently keep the dates it replaced.
    expect(resolvePeriod({ period: "today", from: "2026-01-01", to: "2026-01-31" }, today)).toEqual({
      preset: "today", range: { start: today, end: today },
    });
  });

  it("round-trips through periodParams", () => {
    for (const preset of PERIOD_PRESETS) {
      const resolved = resolvePeriod({ period: preset, from: "2026-08-01", to: "2026-08-15" }, today);
      expect(resolvePeriod(periodParams(resolved), today)).toEqual(resolved);
    }
  });

  it("periodParams drops the dates a preset does not need", () => {
    expect(periodParams({ preset: "this_month", range: { start: "x", end: "y" } }))
      .toEqual({ period: "this_month" });
    expect(periodParams({ preset: "custom", range: { start: "2026-08-01", end: "2026-08-15" } }))
      .toEqual({ period: "custom", from: "2026-08-01", to: "2026-08-15" });
  });
});
