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

/**
 * The zone the *business* runs on: `Australia/Adelaide`.
 *
 * **This was `Australia/Sydney` until 2026-08-26, and that was simply wrong.**
 * The laundry is in Adelaide — its depot, its rounds and its staff are all
 * there — and the Sydney value came from the skeleton this build started from
 * rather than from anything about the client. It decided the instant composed
 * from a counter's "received today", the day an invoice period ends, and the
 * day a notification is filed under, so for half an hour either side of
 * midnight it was answering with somebody else's date.
 *
 * **Moving it re-dated nothing, and that was checked rather than assumed.**
 * The old comment here warned that rows already stored carry the Sydney
 * decision — true, and the reason to look before changing it. What the live
 * project actually holds for the real laundry is **one** app-composed
 * `received_at`, and it is nowhere near midnight; its 646 invoices carry an
 * imported `issue_date`, which is a `DATE` and has no zone to shift. Adelaide
 * and Sydney differ by 30 minutes, so only an instant inside 30 minutes of
 * midnight could change calendar day, and none does.
 */
export const BUSINESS_TIMEZONE = "Australia/Adelaide";

/**
 * The zone the *road* runs on — the same one, now that the business is on it.
 *
 * Kept as its own name rather than folded into `BUSINESS_TIMEZONE`, for two
 * reasons and not out of caution about churn. The questions are genuinely
 * different — one is "what day is this piece of paper filed under", the other
 * is "which runs is a board looking at right now" — and a deployment that ever
 * runs a second depot in another state will need them to part company again.
 * The seam costs nothing while they agree.
 *
 * Both are read out of the platform's tz database via `offsetAt`, so the
 * October changeover is never hard-coded as +9:30 or +10:30.
 */
export const OPERATIONS_TIMEZONE = "Australia/Adelaide";

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

/* ------------------------------------------------- the operational day ---- */

/**
 * The named Adelaide surface. Every one of these is the zone-parameterised
 * primitive above with `OPERATIONS_TIMEZONE` bound — there is no second
 * implementation of "what day is it", and no second offset table.
 */

/** Now. A function rather than a constant so tests can freeze the clock around it. */
export function getAdelaideNow(): Date {
  return new Date();
}

/** Today's calendar date in Adelaide, as `YYYY-MM-DD`. */
export function getAdelaideToday(): string {
  return toZonedDate(getAdelaideNow(), OPERATIONS_TIMEZONE);
}

/** True when `date` (a calendar date) is Adelaide's today. */
export function isAdelaideToday(date: string): boolean {
  return date === getAdelaideToday();
}

/**
 * A calendar date → the half-open instant range covering that Adelaide day.
 *
 * This is the piece that stops a UTC midnight-to-midnight filter from calling
 * an 8:00am Adelaide delivery "the 13th". `start` is inclusive, `end` exclusive,
 * so a `gte(start).lt(end)` pair over a `timestamptz` column selects exactly the
 * rows that happened on that day where the van was.
 */
export function getAdelaideDayRange(date: string): { start: string; end: string } {
  return {
    start: toInstant(date, "00:00", OPERATIONS_TIMEZONE),
    end: toInstant(addDays(date, 1), "00:00", OPERATIONS_TIMEZONE),
  };
}

const AU_LOCALE = "en-AU";

/**
 * A calendar date, written the Australian way.
 *
 * `long` is the page heading ("Friday, 14 August 2026"), `medium` the date
 * control's own label ("Fri, 14 Aug 2026"), `short` a table cell ("14 Aug").
 * Rendered in Adelaide from a UTC-anchored parse, so a date-only value cannot
 * drift a day whichever machine renders it.
 */
export function formatAdelaideDate(
  value: string | null | undefined, style: "long" | "medium" | "short" = "medium",
): string {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "—";

  const options: Intl.DateTimeFormatOptions =
    style === "long" ? { weekday: "long", day: "numeric", month: "long", year: "numeric" }
    : style === "short" ? { day: "numeric", month: "short" }
    : { weekday: "short", day: "numeric", month: "short", year: "numeric" };

  // Date-only values are calendar facts with no instant behind them, so they are
  // formatted in UTC — the zone they were parsed in — exactly as format.ts does.
  const text = new Intl.DateTimeFormat(AU_LOCALE, { ...options, timeZone: "UTC" }).format(parsed);

  // `en-AU` renders "Friday 14 August 2026". A heading reads better with the
  // comma the brief asks for, and the medium style already has one, so the two
  // are made to agree rather than left to differ by locale accident.
  return style === "long" ? text.replace(/^(\w+)\s/, "$1, ") : text;
}

/** An instant → when it happened in Adelaide. Every timestamp a driver reads. */
export function formatAdelaideDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(AU_LOCALE, {
    day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit",
    timeZone: OPERATIONS_TIMEZONE,
  }).format(parsed);
}

/** Just the clock part of an instant, in Adelaide — for a dense activity row. */
export function formatAdelaideTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(AU_LOCALE, {
    hour: "numeric", minute: "2-digit", timeZone: OPERATIONS_TIMEZONE,
  }).format(parsed);
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
