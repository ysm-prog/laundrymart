/**
 * Service calendar — turns a service agreement's pattern into the actual dates
 * a customer is serviced, applying the agreement's public-holiday rule.
 *
 * This is the module the spec warns hardest about (§7.4, §10): if alternate
 * Mondays or holiday rescheduling are wrong, both the routes AND the invoices
 * are wrong. It is pure and fully unit-tested — no database, no clock.
 */
import { z } from "zod";
import {
  addDays, eachDay, isWeekend, isoWeekday, nthWeekdayOfMonth,
  parseIso, startOfIsoWeek, daysBetween, type IsoDate,
} from "./dates";

export const weekdaySchema = z.number().int().min(1).max(7);

export const servicePatternSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("weekly"),
    weekdays: z.array(weekdaySchema).min(1),
  }),
  z.object({
    type: z.literal("alternate_weekly"),
    weekdays: z.array(weekdaySchema).min(1),
    // The week containing anchorDate is a service week; the next one is not.
    anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({
    type: z.literal("monthly_nth"),
    weekday: weekdaySchema,
    nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(-1)]),
  }),
  z.object({
    type: z.literal("custom"),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  }),
]);

export type ServicePattern = z.infer<typeof servicePatternSchema>;

export const HOLIDAY_RULES = ["skip", "next_business_day", "previous_business_day", "service_as_normal"] as const;
export type HolidayRule = (typeof HOLIDAY_RULES)[number];

export const HOLIDAY_RULE_LABELS: Record<HolidayRule, string> = {
  skip: "Skip the service",
  next_business_day: "Move to next business day",
  previous_business_day: "Move to previous business day",
  service_as_normal: "Service as normal",
};

export type ServiceDate = {
  /** The date the visit actually happens. */
  date: IsoDate;
  /** The date the pattern originally produced, when the holiday rule moved it. */
  scheduledDate: IsoDate;
  movedFromHoliday: boolean;
  isWeekend: boolean;
  isPublicHoliday: boolean;
};

export type GenerateOptions = {
  pattern: ServicePattern;
  from: IsoDate;
  to: IsoDate;
  holidayRule?: HolidayRule;
  /** Public holiday dates for the agreement's region. */
  holidays?: readonly IsoDate[];
  /** Clamp to the agreement's own lifetime. */
  startDate?: IsoDate;
  endDate?: IsoDate | null;
};

/** Dates the raw pattern produces, before any holiday handling. */
export function expandPattern(pattern: ServicePattern, from: IsoDate, to: IsoDate): IsoDate[] {
  if (daysBetween(from, to) < 0) return [];

  switch (pattern.type) {
    case "weekly": {
      const wanted = new Set(pattern.weekdays);
      return eachDay(from, to).filter((d) => wanted.has(isoWeekday(d)));
    }
    case "alternate_weekly": {
      const wanted = new Set(pattern.weekdays);
      const anchorWeek = startOfIsoWeek(pattern.anchorDate);
      return eachDay(from, to).filter((d) => {
        if (!wanted.has(isoWeekday(d))) return false;
        const weeks = Math.round(daysBetween(anchorWeek, startOfIsoWeek(d)) / 7);
        // Modulo that stays correct for dates before the anchor.
        return ((weeks % 2) + 2) % 2 === 0;
      });
    }
    case "monthly_nth": {
      const out: IsoDate[] = [];
      const start = parseIso(from);
      const end = parseIso(to);
      let year = start.getUTCFullYear();
      let month = start.getUTCMonth() + 1;
      while (year < end.getUTCFullYear() || (year === end.getUTCFullYear() && month <= end.getUTCMonth() + 1)) {
        const hit = nthWeekdayOfMonth(year, month, pattern.weekday, pattern.nth);
        if (hit && daysBetween(from, hit) >= 0 && daysBetween(hit, to) >= 0) out.push(hit);
        month += 1;
        if (month > 12) { month = 1; year += 1; }
      }
      return out;
    }
    case "custom":
      return [...pattern.dates]
        .filter((d) => daysBetween(from, d) >= 0 && daysBetween(d, to) >= 0)
        .sort();
  }
}

function isBusinessDay(date: IsoDate, holidays: Set<IsoDate>): boolean {
  return !isWeekend(date) && !holidays.has(date);
}

/** Walk in `step` direction until a business day is found (bounded, never loops). */
function shiftToBusinessDay(date: IsoDate, step: 1 | -1, holidays: Set<IsoDate>): IsoDate | null {
  let candidate = date;
  for (let i = 0; i < 14; i += 1) {
    candidate = addDays(candidate, step);
    if (isBusinessDay(candidate, holidays)) return candidate;
  }
  return null;
}

/**
 * The service dates for an agreement across a window, with the holiday rule
 * applied. Results are unique and sorted — a "move to next business day" that
 * lands on an existing service date collapses into one visit, not two.
 */
export function generateServiceDates(options: GenerateOptions): ServiceDate[] {
  const { pattern, holidayRule = "next_business_day" } = options;
  const holidays = new Set(options.holidays ?? []);

  const from = options.startDate && daysBetween(options.startDate, options.from) < 0
    ? options.startDate
    : options.from;
  const to = options.endDate && daysBetween(options.endDate, options.to) > 0
    ? options.endDate
    : options.to;

  const byDate = new Map<IsoDate, ServiceDate>();

  for (const scheduledDate of expandPattern(pattern, from, to)) {
    const onHoliday = holidays.has(scheduledDate);
    let date: IsoDate | null = scheduledDate;
    let moved = false;

    if (onHoliday && holidayRule !== "service_as_normal") {
      if (holidayRule === "skip") {
        date = null;
      } else {
        date = shiftToBusinessDay(scheduledDate, holidayRule === "next_business_day" ? 1 : -1, holidays);
        moved = date !== null;
      }
    }

    if (!date) continue;
    // A move can push a visit past the window; keep the calendar honest.
    if (daysBetween(from, date) < 0 || daysBetween(date, to) < 0) continue;

    const existing = byDate.get(date);
    if (!existing || (existing.movedFromHoliday && !moved)) {
      byDate.set(date, {
        date,
        scheduledDate,
        movedFromHoliday: moved,
        isWeekend: isWeekend(date),
        isPublicHoliday: holidays.has(date),
      });
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function describePattern(pattern: ServicePattern): string {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const list = (days: number[]) => days.map((d) => names[d - 1] ?? "?").join(", ");
  switch (pattern.type) {
    case "weekly":
      return `Every ${list(pattern.weekdays)}`;
    case "alternate_weekly":
      return `Alternate ${list(pattern.weekdays)} (from ${pattern.anchorDate})`;
    case "monthly_nth": {
      const ordinal = pattern.nth === -1 ? "last" : ["first", "second", "third", "fourth", "fifth"][pattern.nth - 1];
      return `Monthly on the ${ordinal} ${names[pattern.weekday - 1]}`;
    }
    case "custom":
      return pattern.dates.length ? `${pattern.dates.length} custom date(s)` : "No dates set";
  }
}

/** Tolerant parse for patterns coming back from jsonb. */
export function parsePattern(value: unknown): ServicePattern {
  const parsed = servicePatternSchema.safeParse(value);
  return parsed.success ? parsed.data : { type: "weekly", weekdays: [] as number[] } as ServicePattern;
}
