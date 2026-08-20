import { describe, expect, it } from "vitest";
import { previousMonth } from "@/lib/domain/dates";

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
