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


/**
 * The calendar quarter `date` falls in — Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec.
 *
 * Those boundaries are also the AU BAS quarter boundaries, so "this quarter"
 * is the same window whichever of the two somebody means by it.
 */
export function currentQuarter(date: IsoDate): { start: IsoDate; end: IsoDate } {
  const d = parseIso(date);
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3);
  const start = new Date(Date.UTC(year, quarter * 3, 1));
  const end = new Date(Date.UTC(year, quarter * 3 + 3, 1));
  end.setUTCDate(end.getUTCDate() - 1);
  return { start: toIso(start), end: toIso(end) };
}

/**
 * The Australian financial year `date` falls in: 1 July → 30 June.
 *
 * Not the calendar year, and not a configurable one. Every business this app
 * serves is Australian — the GST on an invoice line, the ABN validator and the
 * BAS quarters above all already assume it — so a "this year" that ran January
 * to December would be the one date window on the screen that did not match the
 * books it is read against.
 */
export function financialYear(date: IsoDate): { start: IsoDate; end: IsoDate } {
  const d = parseIso(date);
  // Before July the financial year started last July.
  const startYear = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return { start: toIso(new Date(Date.UTC(startYear, 6, 1))), end: toIso(new Date(Date.UTC(startYear + 1, 5, 30))) };
}

/**
 * The quick filters a period is picked with, in the order they are offered.
 *
 * **One canonical set, shared by every screen that asks for a date window.**
 * The alternative — each list page naming the windows that seemed to suit it —
 * is how the same question ends up with a different answer on each screen, and
 * how somebody who has learned one list has to learn the next. Adopted from
 * `ysm-prog/ysm-hub`'s `date-range.js`, which states the same rule for the same
 * reason, so the two products read as one company's software.
 *
 * Two departures from YSM's list, both deliberate:
 *
 *   - **`last_week` and `last_month` are here and `yesterday` sits beside
 *     `today`.** This app's periods are mostly *billing* periods, and the
 *     month-end run bills the month that has finished. Dropping "last month"
 *     to match YSM exactly would take away the one window the business uses
 *     most.
 *   - **`this_fy` is the Australian financial year** (1 July → 30 June), which
 *     is what `financialYear` above records.
 *
 * `all` is an unbounded window and `custom` is whatever two dates somebody
 * typed; both return `null` from `periodFor`, and a caller tells them apart by
 * the preset rather than by the absence.
 */
export const PERIOD_PRESETS = [
  "today", "yesterday", "this_week", "last_week", "this_month", "last_month",
  "this_quarter", "this_fy", "all", "custom",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  this_fy: "This financial year",
  all: "All time",
  custom: "Custom range",
};

/**
 * The presets a screen offers when it has no opinion of its own.
 *
 * `all` is left out: a list that can be unbounded says so itself, because on a
 * screen whose whole job is one billing period an "All time" button is an
 * invitation to bill the wrong thing.
 */
export const BILLING_PERIOD_PRESETS: readonly PeriodPreset[] = [
  "this_week", "last_week", "this_month", "last_month", "this_quarter", "this_fy", "custom",
];

/**
 * The presets an operational list offers: the near windows first, and `all`,
 * because a list of jobs or stops is a thing you legitimately want all of.
 */
export const ACTIVITY_PERIOD_PRESETS: readonly PeriodPreset[] = [
  "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "all", "custom",
];

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
    case "today": return { start: today, end: today };
    case "yesterday": { const day = addDays(today, -1); return { start: day, end: day }; }
    case "this_week": return currentWeek(today);
    case "last_week": return previousWeek(today);
    case "this_month": return currentMonth(today);
    case "last_month": return previousMonth(today);
    case "this_quarter": return currentQuarter(today);
    case "this_fy": return financialYear(today);
    case "all": return null;
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

/** A resolved date window: the preset that produced it, and the dates it means. */
export type ResolvedPeriod = {
  preset: PeriodPreset;
  /** `null` for `all` — an unbounded window, which is not the same as no answer. */
  range: { start: IsoDate; end: IsoDate } | null;
};

/**
 * `?period=&from=&to=` → the window a list should show.
 *
 * The one place a request's period parameters are read, so every screen resolves
 * them identically and a link pasted from one list means the same thing on the
 * next. Total: junk falls back rather than throwing, because these three come
 * straight off a URL somebody can type.
 *
 * **The preset is what is stored, not the dates it resolved to**, which is the
 * difference between a bookmarked "this month" that follows the calendar and one
 * that is stuck on whichever month it was made in. `custom` is the exception and
 * carries its own two dates, and it is also the fallback for a `from`/`to` pair
 * arriving with no preset beside them — an older link, or a hand-typed range.
 */
export function resolvePeriod(
  params: { period?: string; from?: string; to?: string },
  today: IsoDate,
  fallback: PeriodPreset = "all",
): ResolvedPeriod {
  const from = params.from && ISO.test(params.from) ? params.from : undefined;
  const to = params.to && ISO.test(params.to) ? params.to : undefined;
  const asked = params.period && isPeriodPreset(params.period) ? params.period : undefined;

  // A custom range needs both ends and needs them the right way round. One end
  // alone is not half a window — it is a typo, and showing an open-ended list
  // for it would look like the filter had been ignored.
  const custom = from && to && from <= to ? { start: from, end: to } : null;

  if (asked === "custom" || (!asked && custom)) {
    return custom ? { preset: "custom", range: custom } : resolvePeriod({}, today, fallback);
  }
  const preset = asked ?? fallback;
  return { preset, range: periodFor(preset, today) };
}

/** The query parameters a resolved period is spelled with. Presets drop from/to. */
export function periodParams(period: ResolvedPeriod): Record<string, string> {
  if (period.preset !== "custom") return { period: period.preset };
  if (!period.range) return { period: "all" };
  return { period: "custom", from: period.range.start, to: period.range.end };
}
