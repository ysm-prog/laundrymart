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

/**
 * The calendar month before the one `date` falls in.
 *
 * The month-end billing run's default period. It is a helper rather than two
 * expressions at the call site because the interesting case is the one an
 * inline `getMonth() - 1` gets wrong: January's previous month is December of
 * the year before, and a run on 1 January that quietly billed December of the
 * *same* year would find nothing and report "nothing to invoice" — which reads
 * as "everything is billed" rather than as a wrong date.
 *
 * The end is the last day of that month, found by stepping back one day from
 * its successor's first, so no month-length table is needed and February is
 * right in a leap year without being special-cased.
 */
export function previousMonth(date: IsoDate): { start: IsoDate; end: IsoDate } {
  const d = parseIso(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-based; this month.
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  end.setUTCDate(end.getUTCDate() - 1);
  return { start: toIso(start), end: toIso(end) };
}

/**
 * The calendar month `date` falls in.
 *
 * The companion to `previousMonth`, and stated the same way — the end is found
 * by stepping back one day from next month's first, so February is right in a
 * leap year without a month-length table.
 */
export function currentMonth(date: IsoDate): { start: IsoDate; end: IsoDate } {
  const d = parseIso(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  end.setUTCDate(end.getUTCDate() - 1);
  return { start: toIso(start), end: toIso(end) };
}

/** Monday–Sunday of the week `date` falls in. */
export function currentWeek(date: IsoDate): { start: IsoDate; end: IsoDate } {
  const start = startOfIsoWeek(date);
  return { start, end: addDays(start, 6) };
}

/** Monday–Sunday of the week before the one `date` falls in. */
export function previousWeek(date: IsoDate): { start: IsoDate; end: IsoDate } {
  const start = addDays(startOfIsoWeek(date), -7);
  return { start, end: addDays(start, 6) };
}

/** The quick filters the billing screen offers, in the order it offers them. */
export const PERIOD_PRESETS = [
  "this_week", "last_week", "this_month", "last_month", "custom",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
  last_month: "Last month",
  custom: "Custom range",
};

export function isPeriodPreset(value: string): value is PeriodPreset {
  return (PERIOD_PRESETS as readonly string[]).includes(value);
}

/**
 * The dates a preset means, relative to `today`.
 *
 * **`last_month` is the default everywhere a billing period is asked for**, and
 * the reason is the one `previousMonth` records: a run that defaults to the
 * month you are standing in bills 1 September to 1 September on the 1st, finds
 * nothing, and reports "nothing to invoice" — which reads as *everything is
 * billed* rather than as *wrong month*.
 *
 * `custom` has no dates of its own; the caller keeps whatever the person typed.
 */
export function periodFor(preset: PeriodPreset, today: IsoDate): { start: IsoDate; end: IsoDate } | null {
  switch (preset) {
    case "this_week": return currentWeek(today);
    case "last_week": return previousWeek(today);
    case "this_month": return currentMonth(today);
    case "last_month": return previousMonth(today);
    case "custom": return null;
  }
}

/**
 * Which preset a range *is*, if any — so a screen re-opened from a bookmarked
 * URL highlights the button the person pressed rather than falling to Custom.
 */
export function presetForRange(start: IsoDate, end: IsoDate, today: IsoDate): PeriodPreset {
  for (const preset of PERIOD_PRESETS) {
    const range = periodFor(preset, today);
    if (range && range.start === start && range.end === end) return preset;
  }
  return "custom";
}
