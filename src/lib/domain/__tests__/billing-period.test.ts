import { describe, expect, it } from "vitest";
import {
  FORTNIGHT_ANCHOR, billingPeriodFor, describePeriod, fortnightOf, monthOf,
  placesAutomatically, samePeriod, weekOf,
} from "@/lib/domain/billing-period";
import { addDays, daysBetween, isoWeekday } from "@/lib/domain/dates";

describe("monthOf", () => {
  it("spans the whole calendar month", () => {
    expect(monthOf("2026-08-14")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("holds the first and the last day of the month it names", () => {
    expect(monthOf("2026-08-01")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(monthOf("2026-08-31")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("gets February right in a leap year and out of one", () => {
    expect(monthOf("2028-02-10").end).toBe("2028-02-29");
    expect(monthOf("2026-02-10").end).toBe("2026-02-28");
  });

  it("does not run into the next year at December", () => {
    expect(monthOf("2026-12-25")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
  });
});

describe("weekOf", () => {
  it("runs Monday to Sunday", () => {
    // 2026-08-14 is a Friday.
    expect(weekOf("2026-08-14")).toEqual({ start: "2026-08-10", end: "2026-08-16" });
  });

  it("keeps Sunday in the week it ends, not the one it precedes", () => {
    expect(weekOf("2026-08-16")).toEqual({ start: "2026-08-10", end: "2026-08-16" });
    expect(weekOf("2026-08-17").start).toBe("2026-08-17");
  });

  it("always starts on a Monday and spans seven days", () => {
    for (let i = 0; i < 40; i += 1) {
      const week = weekOf(addDays("2026-01-01", i * 9));
      expect(isoWeekday(week.start)).toBe(1);
      expect(daysBetween(week.start, week.end)).toBe(6);
    }
  });
});

describe("fortnightOf", () => {
  it("starts on a Monday and spans fourteen days", () => {
    for (let i = 0; i < 40; i += 1) {
      const period = fortnightOf(addDays("2026-01-01", i * 5));
      expect(isoWeekday(period.start)).toBe(1);
      expect(daysBetween(period.start, period.end)).toBe(13);
    }
  });

  it("is stable: the anchor's own fortnight starts on the anchor", () => {
    expect(fortnightOf(FORTNIGHT_ANCHOR).start).toBe(FORTNIGHT_ANCHOR);
  });

  it("puts two consecutive weeks in the same fortnight and the third in the next", () => {
    const first = fortnightOf("2026-08-03");
    expect(fortnightOf("2026-08-10")).toEqual(first);
    expect(fortnightOf("2026-08-16")).toEqual(first);
    expect(fortnightOf("2026-08-17")).not.toEqual(first);
    expect(fortnightOf("2026-08-17").start).toBe("2026-08-17");
  });

  it("lands a date before the anchor in a fortnight that has already started", () => {
    const period = fortnightOf("1969-12-30");
    expect(period.start <= "1969-12-30").toBe(true);
    expect(period.end >= "1969-12-30").toBe(true);
    expect(isoWeekday(period.start)).toBe(1);
  });
});

describe("billingPeriodFor", () => {
  it("gives the calendar month for a monthly customer", () => {
    expect(billingPeriodFor("monthly_consolidated", "2026-08-14"))
      .toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("gives the ISO week for a weekly customer", () => {
    expect(billingPeriodFor("weekly_consolidated", "2026-08-14"))
      .toEqual({ start: "2026-08-10", end: "2026-08-16" });
  });

  it("gives the fortnight for a fortnightly customer", () => {
    expect(billingPeriodFor("fortnightly_consolidated", "2026-08-14"))
      .toEqual({ start: "2026-08-03", end: "2026-08-16" });
  });

  it("has no period for a per-job customer — the job is its own invoice", () => {
    expect(billingPeriodFor("invoice_per_job", "2026-08-14")).toBeNull();
  });

  it("has no period for a manual customer — a person decides each time", () => {
    expect(billingPeriodFor("manual", "2026-08-14")).toBeNull();
  });

  it("has no period for a job that never finished", () => {
    expect(billingPeriodFor("monthly_consolidated", null)).toBeNull();
    expect(billingPeriodFor("monthly_consolidated", undefined)).toBeNull();
  });

  it("reads an unknown method as monthly rather than as per-job", () => {
    // The safe direction: the mistake it avoids is a customer receiving fifteen
    // invoices where they expected one.
    expect(billingPeriodFor("something_new", "2026-08-14"))
      .toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(billingPeriodFor(null, "2026-08-14"))
      .toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("keeps a job finished on the first of the month out of the previous one", () => {
    // The boundary the business timezone exists for: 09:00 Adelaide on 1 September
    // resolves to 2026-09-01, not to 2026-08-31.
    expect(billingPeriodFor("monthly_consolidated", "2026-09-01"))
      .toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });
});

describe("placesAutomatically", () => {
  it("is false only for manual", () => {
    expect(placesAutomatically("manual")).toBe(false);
    expect(placesAutomatically("monthly_consolidated")).toBe(true);
    expect(placesAutomatically("weekly_consolidated")).toBe(true);
    expect(placesAutomatically("fortnightly_consolidated")).toBe(true);
    expect(placesAutomatically("invoice_per_job")).toBe(true);
  });

  it("treats an unknown method as placing, matching billingPeriodFor's default", () => {
    expect(placesAutomatically("something_new")).toBe(true);
    expect(placesAutomatically(undefined)).toBe(true);
  });
});

describe("samePeriod", () => {
  it("compares both ends", () => {
    const august = { start: "2026-08-01", end: "2026-08-31" };
    expect(samePeriod(august, { ...august })).toBe(true);
    expect(samePeriod(august, { start: "2026-08-01", end: "2026-08-30" })).toBe(false);
    expect(samePeriod(august, null)).toBe(false);
    expect(samePeriod(null, null)).toBe(true);
  });
});

describe("describePeriod", () => {
  it("names a whole calendar month", () => {
    expect(describePeriod({ start: "2026-08-01", end: "2026-08-31" })).toBe("August 2026");
  });

  it("states both ends of anything that is not a whole month", () => {
    expect(describePeriod({ start: "2026-08-03", end: "2026-08-16" })).toBe("3 Aug – 16 Aug");
    expect(describePeriod({ start: "2026-08-05", end: "2026-08-31" })).toBe("5 Aug – 31 Aug");
  });
});
