/**
 * Date helpers for the service calendar.
 *
 * Everything is an ISO `YYYY-MM-DD` string handled in UTC. Service days are
 * calendar facts, not instants — doing the arithmetic in UTC keeps a Sydney
 * daylight-saving change from shifting a Monday pickup onto Sunday.
 */

export type IsoDate = string;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseIso(date: IsoDate): Date {
  if (!ISO.test(date)) throw new Error(`Expected YYYY-MM-DD, received "${date}"`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date "${date}"`);
  return parsed;
}

export function toIso(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = parseIso(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  const day = parseIso(date).getUTCDay();
  return day === 0 ? 7 : day;
}

export function isWeekend(date: IsoDate): boolean {
  return isoWeekday(date) >= 6;
}

/** Monday of the week containing `date`. */
export function startOfIsoWeek(date: IsoDate): IsoDate {
  return addDays(date, -(isoWeekday(date) - 1));
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / 86_400_000);
}

/** All dates from `from` to `to` inclusive. Empty when the range is inverted. */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  const span = daysBetween(from, to);
  for (let i = 0; i <= span; i += 1) out.push(addDays(from, i));
  return out;
}

/** The `nth` occurrence of `weekday` in the month of `date`. nth = -1 means last. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): IsoDate | null {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const matches: IsoDate[] = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    first.setUTCDate(day);
    const iso = toIso(first);
    if (isoWeekday(iso) === weekday) matches.push(iso);
  }
  if (nth === -1) return matches[matches.length - 1] ?? null;
  return matches[nth - 1] ?? null;
}

export function formatIso(date: IsoDate, locale = "en-AU"): string {
  return parseIso(date).toLocaleDateString(locale, {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}
