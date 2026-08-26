/**
 * The time-based rules the sweep applies, as pure functions.
 *
 * Kept out of the route so they can be unit-tested without a database, a clock
 * or a cron — the same reason `src/lib/domain/` exists. Everything here takes
 * "now" as an argument; nothing reads the system clock.
 */

/**
 * How long after its planned start a run may sit at the depot before the office
 * is told. Loading, a late driver and a fuel stop all live inside an hour;
 * beyond that, someone should be asked.
 */
export const RUN_START_GRACE_MINUTES = 60;

/** Route states that mean the run has not left yet. */
export const NOT_STARTED_STATUSES = [
  "planned",
  "inspection_pending",
  "inspection_complete",
  "load_confirmed",
] as const;

/** Invoice states that can still be chased. `paid` and `void` cannot. */
export const CHASEABLE_STATUSES = ["issued", "part_paid", "overdue"] as const;

/** Minutes since midnight for a `HH:MM[:SS]` clock time, or null if unparseable. */
export function minutesOfDay(clock: string | null | undefined): number | null {
  if (!clock) return null;
  const [hours, minutes] = clock.split(":");
  const h = Number(hours);
  const m = Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/** Local wall-clock minutes in a time zone, from an absolute instant. */
export function minutesOfDayIn(now: Date, timeZone = "Australia/Adelaide"): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * Is a run late enough to say something about?
 *
 * A run with no planned start time is never late. Nothing in the schema promises
 * when it should leave, and inventing a cutoff would manufacture an alert out of
 * an absence — the same call CLAUDE.md records for the average-turnaround KPI.
 */
export function runIsLate(
  plannedStartTime: string | null | undefined,
  nowMinutes: number,
  graceMinutes: number = RUN_START_GRACE_MINUTES,
): boolean {
  const planned = minutesOfDay(plannedStartTime);
  if (planned === null) return false;
  return nowMinutes >= planned + graceMinutes;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
