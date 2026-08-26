import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUSINESS_TIMEZONE, OPERATIONS_TIMEZONE, businessToday,
  formatAdelaideDate, formatAdelaideDateTime, formatAdelaideTime,
  getAdelaideDayRange, getAdelaideToday, isAdelaideToday,
} from "@/lib/domain/timezone";

/**
 * The operational day runs on Adelaide time.
 *
 * Every assertion below is a real failure this feature could have shipped. The
 * expected instants were checked against the platform's own tz database rather
 * than worked out by hand, because the whole point of reading the offset out of
 * `Intl` is that nobody has to remember whether Adelaide is +9:30 or +10:30 this
 * week.
 */

afterEach(() => {
  vi.useRealTimers();
});

function at(instant: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(instant));
}

describe("the timezones", () => {
  it("both run on Adelaide, because that is where the business is", () => {
    // Stated as an assertion rather than a comment, so moving either one has to
    // be a decision somebody makes on purpose.
    //
    // **`BUSINESS_TIMEZONE` was `Australia/Sydney` until 2026-08-26.** It came
    // from the skeleton this build started from, not from anything about the
    // client, and it decided the instant composed from a counter's "received
    // today", the day an invoice period ends and the day a notification is
    // filed under — so for half an hour either side of midnight it answered
    // with another state's date.
    expect(BUSINESS_TIMEZONE).toBe("Australia/Adelaide");
    expect(OPERATIONS_TIMEZONE).toBe("Australia/Adelaide");
  });
});

describe("getAdelaideToday", () => {
  it("is Adelaide's day, not UTC's", () => {
    // 00:30 UTC on the 14th is already 10:00 in the morning in Adelaide.
    at("2026-08-14T00:30:00Z");
    expect(getAdelaideToday()).toBe("2026-08-14");

    // 23:00 UTC on the 13th is 08:30 on the 14th in Adelaide — a UTC date would
    // show a driver yesterday's run for the whole of their morning.
    at("2026-08-13T23:00:00Z");
    expect(getAdelaideToday()).toBe("2026-08-14");
  });

  it("agrees with the business day, now that both are Adelaide", () => {
    // 14:00 UTC is midnight in Sydney and 11:30pm the previous day in Adelaide
    // — the half hour a day the two used to disagree, and the window in which
    // the old Sydney business zone filed a counter's work under tomorrow's
    // date. Both answers are Adelaide's now, so they match.
    at("2026-08-14T14:00:00Z");
    expect(getAdelaideToday()).toBe("2026-08-14");
    expect(businessToday()).toBe("2026-08-14");
  });

  it("does not move when the machine's own timezone does", () => {
    at("2026-08-14T02:00:00Z");
    const original = process.env.TZ;
    try {
      for (const zone of ["UTC", "America/New_York", "Australia/Sydney", "Asia/Tokyo"]) {
        process.env.TZ = zone;
        expect(getAdelaideToday(), zone).toBe("2026-08-14");
      }
    } finally {
      process.env.TZ = original;
    }
  });

  it("answers isAdelaideToday against the same clock", () => {
    at("2026-08-14T06:00:00Z");
    expect(isAdelaideToday("2026-08-14")).toBe(true);
    expect(isAdelaideToday("2026-08-13")).toBe(false);
    expect(isAdelaideToday("2026-08-15")).toBe(false);
  });
});

describe("getAdelaideDayRange", () => {
  it("covers midnight to midnight in Adelaide, not in UTC", () => {
    // ACST, +9:30. A UTC midnight-to-midnight filter would put a 9am delivery
    // on the previous day.
    expect(getAdelaideDayRange("2026-08-14")).toEqual({
      start: "2026-08-13T14:30:00.000Z",
      end: "2026-08-14T14:30:00.000Z",
    });
  });

  it("uses the summer offset in summer", () => {
    // ACDT, +10:30.
    expect(getAdelaideDayRange("2026-01-15")).toEqual({
      start: "2026-01-14T13:30:00.000Z",
      end: "2026-01-15T13:30:00.000Z",
    });
  });

  it("gets the short day right when daylight saving begins", () => {
    // Adelaide moves 2am → 3am on the first Sunday in October, so the 4th is a
    // 23-hour day: it opens on ACST and closes on ACDT.
    const range = getAdelaideDayRange("2026-10-04");
    expect(range).toEqual({
      start: "2026-10-03T14:30:00.000Z",
      end: "2026-10-04T13:30:00.000Z",
    });
    const hours = (Date.parse(range.end) - Date.parse(range.start)) / 3_600_000;
    expect(hours).toBe(23);
  });

  it("gets the long day right when daylight saving ends", () => {
    // First Sunday in April, 3am → 2am: a 25-hour day.
    const range = getAdelaideDayRange("2026-04-05");
    expect(range).toEqual({
      start: "2026-04-04T13:30:00.000Z",
      end: "2026-04-05T14:30:00.000Z",
    });
    const hours = (Date.parse(range.end) - Date.parse(range.start)) / 3_600_000;
    expect(hours).toBe(25);
  });

  it("never leaves a gap or an overlap between consecutive days", () => {
    // Across the changeover in both directions: yesterday's end is today's
    // start, exactly. A gap loses a delivery from every report it appears in.
    for (const [first, second] of [
      ["2026-10-03", "2026-10-04"], ["2026-10-04", "2026-10-05"],
      ["2026-04-04", "2026-04-05"], ["2026-04-05", "2026-04-06"],
    ]) {
      expect(getAdelaideDayRange(first!).end, `${first} → ${second}`)
        .toBe(getAdelaideDayRange(second!).start);
    }
  });
});

describe("formatting", () => {
  it("writes dates the Australian way", () => {
    expect(formatAdelaideDate("2026-08-14", "long")).toBe("Friday, 14 August 2026");
    expect(formatAdelaideDate("2026-08-14", "medium")).toBe("Fri, 14 Aug 2026");
    expect(formatAdelaideDate("2026-08-14", "short")).toBe("14 Aug");
  });

  it("does not shift a date-only value by a day", () => {
    // The classic off-by-one: a calendar date has no instant behind it, so it
    // must not be dragged through a zone conversion on the way to the screen.
    expect(formatAdelaideDate("2026-01-01", "medium")).toBe("Thu, 1 Jan 2026");
    expect(formatAdelaideDate("2026-12-31", "medium")).toBe("Thu, 31 Dec 2026");
  });

  it("renders an instant in Adelaide", () => {
    // 22:30 UTC is 8:00am the next morning in Adelaide (ACST).
    expect(formatAdelaideDateTime("2026-08-13T22:15:00Z")).toBe("14 Aug 2026, 7:45 am");
    expect(formatAdelaideTime("2026-08-13T22:15:00Z")).toBe("7:45 am");
  });

  it("says so rather than throwing when there is nothing to render", () => {
    expect(formatAdelaideDate(null)).toBe("—");
    expect(formatAdelaideDate("not a date")).toBe("—");
    expect(formatAdelaideDateTime(undefined)).toBe("—");
    expect(formatAdelaideDateTime("nonsense")).toBe("—");
  });
});
