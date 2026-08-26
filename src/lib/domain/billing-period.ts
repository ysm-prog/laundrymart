/**
 * Which billing period a job falls in. No database, no clock, no I/O.
 *
 * **The rule the running draft turns on.** A job's approved charges are placed
 * on its customer's *open draft*, and the draft is keyed on
 * `(customer, period start, period end)`. So "which period?" is the question
 * that decides whether August's eleventh job joins August's invoice or opens a
 * twelfth one — and it has to be answered the same way by the approval, by the
 * bulk generate, by the month-end run and by the screen that shows the drafts.
 *
 *     billing_method              a job completed 2026-08-14 belongs to
 *     ─────────────────────────   ────────────────────────────────────────
 *     monthly_consolidated        2026-08-01 → 2026-08-31
 *     fortnightly_consolidated    2026-08-03 → 2026-08-16
 *     weekly_consolidated         2026-08-10 → 2026-08-16
 *     invoice_per_job             — none, the job is its own invoice
 *     manual                      — none, a person decides each time
 *
 * It lives in `lib/domain/` rather than beside the writer for the reason this
 * repository records three times over: `lib/invoices/*` reaches `recordAudit` →
 * `lib/env`, which throws without a configured environment, so a rule stated
 * there is a rule no unit test can import — and two payload contracts have
 * shipped broken here behind a green `verify` for exactly that reason.
 *
 * **Dates arrive already resolved in the business timezone.** Callers pass
 * `toZonedDate(job.completed_at)`, never a raw `timestamptz`. A job finished at
 * 09:00 Adelaide on 1 September is a September job, and composing that boundary in
 * UTC is how it would land on August's invoice — silently, on the wrong bill.
 */

import { addDays, daysBetween, parseIso, startOfIsoWeek, toIso, type IsoDate } from "@/lib/domain/dates";
import { isBillingMethod, type BillingMethod } from "@/lib/domain/billing";

export type BillingPeriod = { start: IsoDate; end: IsoDate };

/**
 * The Monday every fortnight is counted from.
 *
 * A fortnight has no natural boundary the way a month or an ISO week does, so
 * one has to be chosen. This is 5 January 1970 — a Monday, comfortably before
 * any row in this system — and it is **fixed rather than configurable** on
 * purpose: the same job must land in the same fortnight whenever the question is
 * asked, including by a screen re-rendering it a year later. A laundry that
 * bills fortnightly from a particular Monday of its own needs a column on the
 * customer; nobody has asked for one, and inventing it now would be a second
 * answer to "which fortnight is this?".
 */
export const FORTNIGHT_ANCHOR: IsoDate = "1970-01-05";

/** The calendar month containing `date`. */
export function monthOf(date: IsoDate): BillingPeriod {
  const d = parseIso(date);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { start: toIso(start), end: toIso(end) };
}

/** The ISO week (Monday–Sunday) containing `date`. */
export function weekOf(date: IsoDate): BillingPeriod {
  const start = startOfIsoWeek(date);
  return { start, end: addDays(start, 6) };
}

/** The fortnight containing `date`, counted from {@link FORTNIGHT_ANCHOR}. */
export function fortnightOf(date: IsoDate): BillingPeriod {
  const monday = startOfIsoWeek(date);
  const weeks = Math.floor(daysBetween(FORTNIGHT_ANCHOR, monday) / 7);
  // `weeks` is never negative for any date this system holds, but floor-mod
  // rather than `%` so a date before the anchor still lands in a real fortnight
  // instead of one starting a week in the future.
  const offset = ((weeks % 2) + 2) % 2;
  const start = addDays(monday, -7 * offset);
  return { start, end: addDays(start, 13) };
}

/**
 * The period a job belongs to, or `null` when its customer's method does not
 * consolidate.
 *
 * `null` is a real answer and not a failure. `invoice_per_job` means the job is
 * its own invoice, and `manual` means nobody decides but a person — in both
 * cases there is no running draft to look up, and the callers say so.
 *
 * An unrecognised method reads as monthly, the same safe default
 * `groupJobsForInvoicing` takes: the mistake that direction avoids is a customer
 * suddenly receiving fifteen separate invoices, which is the one they notice.
 */
export function billingPeriodFor(
  method: BillingMethod | string | null | undefined,
  completedOn: IsoDate | null | undefined,
): BillingPeriod | null {
  if (!completedOn) return null;
  const resolved: BillingMethod = typeof method === "string" && isBillingMethod(method)
    ? method
    : "monthly_consolidated";

  switch (resolved) {
    case "weekly_consolidated": return weekOf(completedOn);
    case "fortnightly_consolidated": return fortnightOf(completedOn);
    case "monthly_consolidated": return monthOf(completedOn);
    case "invoice_per_job":
    case "manual":
      return null;
  }
}

/**
 * Whether an approved job should be placed on a running draft on its own.
 *
 * `manual` is the one that should not, and that is the entire meaning of the
 * setting — a person decides each time. It is deliberately **not** a second
 * tenant-level "auto-draft" switch: `billing_method` already answers this
 * question, and two answers to one question is the duplication this codebase
 * argues against everywhere else.
 *
 * `invoice_per_job` *is* placed automatically — as its own invoice. The shape
 * differs; the moment does not.
 */
export function placesAutomatically(method: BillingMethod | string | null | undefined): boolean {
  const resolved = typeof method === "string" && isBillingMethod(method)
    ? method
    : "monthly_consolidated";
  return resolved !== "manual";
}

/** Whether two periods are the same window. Both halves, so a shifted end shows. */
export function samePeriod(a: BillingPeriod | null, b: BillingPeriod | null): boolean {
  if (!a || !b) return a === b;
  return a.start === b.start && a.end === b.end;
}

/**
 * How a period reads on screen: "August 2026", "Week of 10 Aug", "3–16 Aug".
 *
 * A whole calendar month is named, because that is what an operator asked for
 * and "1 Aug – 31 Aug" makes them check. Anything else states its two ends,
 * because a fortnight has no name.
 */
export function describePeriod(period: BillingPeriod, locale = "en-AU"): string {
  const month = monthOf(period.start);
  if (month.start === period.start && month.end === period.end) {
    return new Intl.DateTimeFormat(locale, {
      month: "long", year: "numeric", timeZone: "UTC",
    }).format(parseIso(period.start));
  }
  const short = (date: IsoDate) => new Intl.DateTimeFormat(locale, {
    day: "numeric", month: "short", timeZone: "UTC",
  }).format(parseIso(date));
  return `${short(period.start)} – ${short(period.end)}`;
}
