import { describe, expect, it } from "vitest";
import {
  PERIOD_PRESETS, PERIOD_PRESET_LABELS, currentMonth, currentWeek, isPeriodPreset,
  periodFor, presetForRange, previousMonth, previousWeek,
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
    expect(isPeriodPreset("yesterday")).toBe(false);
  });
});
