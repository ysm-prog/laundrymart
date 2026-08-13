/**
 * Turning what the counter typed into an instant, and back again.
 *
 * The app has no datetime input: dates come from `<input type="date">` and times
 * from `<input type="time">`, both of which hand back wall-clock strings with no
 * zone attached. Postgres stores `received_at` as a `timestamptz`, which is an
 * instant. Something has to bridge the two, and it must not be the browser —
 * a laundry in Sydney has staff, a phone in a car park and a Vercel function in
 * three different notions of "now", and "received today" has to mean the day the
 * shop was open, not the day UTC happened to be in.
 *
 * So the bridge is here, it is pure, and it is tested: no Date-with-locale
 * guessing, no dependency, and one named business timezone the whole module
 * agrees on. `src/lib/format.ts` already defaults to the same zone for display.
 */

export const BUSINESS_TIMEZONE = "Australia/Sydney";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}(:\d{2})?$/;

export function isCalendarDate(value: string): boolean {
  return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

export function isClockTime(value: string): boolean {
  if (!TIME_PATTERN.test(value)) return false;
  const [hours, minutes] = value.split(":").map(Number);
  return hours! >= 0 && hours! <= 23 && minutes! >= 0 && minutes! <= 59;
}

/**
 * How far ahead of UTC the zone is at a given instant, in milliseconds.
 *
 * Reads the zone's own rules back out of `Intl` rather than hard-coding +10/+11,
 * so the AEDT changeover in October is handled by the platform's tz database
 * instead of by us remembering it.
 */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));

  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  // `hour12: false` renders midnight as 24 in some ICU versions; normalise it.
  const hour = field("hour") % 24;
  const asIfUtc = Date.UTC(
    field("year"), field("month") - 1, field("day"), hour, field("minute"), field("second"),
  );
  return asIfUtc - instant;
}

/**
 * A wall-clock date and time in the business timezone → the ISO instant to store.
 *
 * Two passes, because the offset depends on the instant we are still solving
 * for: guess that the wall clock is UTC, look up the offset there, correct, then
 * look the offset up again at the corrected instant. The second pass is what
 * gets the hour after a daylight-saving change right. Times that do not exist
 * (the hour skipped each October) resolve forward, which is the same thing every
 * calendar application does.
 */
export function toInstant(
  date: string, time = "00:00", timeZone = BUSINESS_TIMEZONE,
): string {
  const clock = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (Number.isNaN(clock)) throw new RangeError(`not a date and time: ${date} ${time}`);

  let instant = clock - offsetAt(clock, timeZone);
  instant = clock - offsetAt(instant, timeZone);
  return new Date(instant).toISOString();
}

/** An instant → the calendar date it fell on in the business timezone. */
export function toZonedDate(instant: string | Date, timeZone = BUSINESS_TIMEZONE): string {
  const parsed = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(parsed.getTime())) return "";
  // `en-CA` formats as YYYY-MM-DD, the shape both Postgres and the date input want.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(parsed);
}

/** An instant → the wall-clock time it showed in the business timezone (HH:MM). */
export function toZonedTime(instant: string | Date, timeZone = BUSINESS_TIMEZONE): string {
  const parsed = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, hour12: false, hour: "2-digit", minute: "2-digit",
  }).format(parsed);
}

/** Today's date, in the business timezone. The one "what day is it" in the module. */
export function businessToday(timeZone = BUSINESS_TIMEZONE): string {
  return toZonedDate(new Date(), timeZone);
}

/** The current wall-clock time, for defaulting a time picker. */
export function businessNowTime(timeZone = BUSINESS_TIMEZONE): string {
  return toZonedTime(new Date(), timeZone);
}

/** `date` shifted by whole days, staying a calendar date. */
export function addDays(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(base)) return date;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The Monday–Sunday week `date` falls in. The laundry's week starts on Monday,
 * matching the ISO weekdays the routing patterns already use.
 */
export function weekBounds(date: string): { start: string; end: string } {
  const base = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return { start: date, end: date };
  const isoDay = base.getUTCDay() === 0 ? 7 : base.getUTCDay();
  const start = addDays(date, 1 - isoDay);
  return { start, end: addDays(start, 6) };
}
