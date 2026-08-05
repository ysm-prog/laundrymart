import { describe, expect, it } from "vitest";
import {
  RUN_START_GRACE_MINUTES, daysBetween, minutesOfDay, minutesOfDayIn, runIsLate,
} from "@/lib/notifications/sweep-rules";

/**
 * The sweep decides who gets interrupted, so its arithmetic is worth pinning
 * down away from a database and a clock. Every function here takes "now" as an
 * argument for exactly that reason.
 */
describe("minutesOfDay", () => {
  it("reads a Postgres time value with or without seconds", () => {
    expect(minutesOfDay("06:30")).toBe(390);
    expect(minutesOfDay("06:30:00")).toBe(390);
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("23:59")).toBe(1439);
  });

  it("returns null for anything it cannot trust", () => {
    for (const input of [null, undefined, "", "nope", "25:00", "10:61", "1000"]) {
      expect(minutesOfDay(input)).toBeNull();
    }
  });
});

describe("minutesOfDayIn", () => {
  it("reads the wall clock in Sydney, not in UTC", () => {
    // 2026-08-05 is winter in Sydney: AEST, UTC+10.
    const instant = new Date("2026-08-05T00:30:00.000Z");
    expect(minutesOfDayIn(instant, "Australia/Sydney")).toBe(10 * 60 + 30);
    expect(minutesOfDayIn(instant, "UTC")).toBe(30);
  });

  it("follows daylight saving rather than a fixed offset", () => {
    // January is AEDT, UTC+11 — an hour further ahead than the test above.
    const summer = new Date("2026-01-15T00:30:00.000Z");
    expect(minutesOfDayIn(summer, "Australia/Sydney")).toBe(11 * 60 + 30);
  });

  it("does not roll past midnight into a negative", () => {
    const instant = new Date("2026-08-05T15:00:00.000Z"); // 01:00 next day in Sydney
    expect(minutesOfDayIn(instant, "Australia/Sydney")).toBe(60);
  });
});

describe("runIsLate", () => {
  const sixAm = 6 * 60;

  it("says nothing until the grace period is spent", () => {
    expect(runIsLate("06:00", sixAm)).toBe(false);
    expect(runIsLate("06:00", sixAm + RUN_START_GRACE_MINUTES - 1)).toBe(false);
    expect(runIsLate("06:00", sixAm + RUN_START_GRACE_MINUTES)).toBe(true);
  });

  it("never calls a run late when nothing promised a start time", () => {
    // Nothing in the schema says when this run should leave, so there is no
    // window for it to be past — the same call §10b records for turnaround.
    expect(runIsLate(null, 23 * 60)).toBe(false);
    expect(runIsLate(undefined, 23 * 60)).toBe(false);
    expect(runIsLate("", 23 * 60)).toBe(false);
  });

  it("honours an explicit grace period", () => {
    expect(runIsLate("06:00", sixAm + 10, 5)).toBe(true);
    expect(runIsLate("06:00", sixAm + 10, 30)).toBe(false);
  });
});

describe("daysBetween", () => {
  it("counts whole days forward and backward", () => {
    expect(daysBetween("2026-08-01", "2026-08-08")).toBe(7);
    expect(daysBetween("2026-08-08", "2026-08-01")).toBe(-7);
    expect(daysBetween("2026-08-05", "2026-08-05")).toBe(0);
  });

  it("crosses a month, a year and a leap day without drifting", () => {
    expect(daysBetween("2026-01-31", "2026-02-01")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2); // 2028 is a leap year
  });

  it("ignores a timestamp tail and survives junk", () => {
    expect(daysBetween("2026-08-01T13:00:00Z", "2026-08-02T01:00:00Z")).toBe(1);
    expect(daysBetween("nope", "2026-08-01")).toBe(0);
  });
});
