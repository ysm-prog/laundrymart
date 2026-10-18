import { addDays } from "./dates";
import { isoWeekday, nextDeliveryDay } from "./automation";
import type { OrderItemInput } from "./laundry-orders";

/**
 * Taking laundry in, in about four actions (Darshan's review, brief 3.4).
 *
 * The rules that let the counter accept a default rather than answer a
 * question: when the job is promised back, what the customer usually brings,
 * and what a +/- press does to a count. Pure, so the form, the server action
 * that loads the defaults and the tests read one rule.
 */

/**
 * When a job taken in today is promised back.
 *
 * **A customer on a round** gets that round's next visit: the first day
 * strictly after today that falls on their collection weekday — strictly,
 * because laundry collected on Tuesday's visit goes back on next Tuesday's,
 * not this afternoon. A visit that lands on a public holiday moves to the next
 * day the rounds run (`nextDeliveryDay`'s rule: not a Sunday, not a holiday).
 *
 * **Everyone else** gets today plus the laundry's turnaround, on the next day
 * the rounds run.
 */
export function defaultReturnDate(input: {
  today: string;
  /** ISO weekday 1–7 of the customer's round, or null for no round. */
  roundWeekday: number | null;
  turnaroundDays: number;
  holidays: ReadonlySet<string>;
}): string {
  const { today, roundWeekday, turnaroundDays, holidays } = input;
  if (roundWeekday && roundWeekday >= 1 && roundWeekday <= 7) {
    const ahead = ((roundWeekday - isoWeekday(today) + 7) % 7) || 7;
    return nextDeliveryDay(addDays(today, ahead), today, holidays);
  }
  return nextDeliveryDay(addDays(today, Math.max(0, turnaroundDays)), today, holidays);
}

/**
 * The customer's last job, as rows for a new one.
 *
 * Item, kind, counting method, the counts and Rental/Own come across — that is
 * what the customer usually brings, and the counter adjusts a number rather
 * than re-picking items. Notes and one-off descriptions of "other" laundry are
 * left behind: they described that bag, not this one. A row with nothing to
 * count is dropped rather than carried as a blank.
 */
export function prefillFromLastJob(items: readonly OrderItemInput[]): OrderItemInput[] {
  return items
    .filter((item) => item.item_id || item.item_type !== "other")
    .map((item) => ({
      item_id: item.item_id ?? null,
      item_type: item.item_type,
      custom_description: null,
      quantity_type: item.quantity_type,
      exact_quantity: item.quantity_type === "exact" ? item.exact_quantity ?? null : null,
      bag_count: item.quantity_type === "bulk_lot" ? item.bag_count ?? null : null,
      estimated_quantity: item.quantity_type === "bulk_lot" ? item.estimated_quantity ?? null : null,
      notes: null,
      ownership: item.ownership ?? null,
    }))
    .filter((item) => (item.exact_quantity ?? 0) > 0 || (item.bag_count ?? 0) > 0
      || (item.estimated_quantity ?? 0) > 0 || Boolean(item.item_id));
}

/** A +/- press on a count field: never below 1, blank reads as 0. */
export function stepQuantity(value: string, delta: number): string {
  const current = Number.parseInt(value, 10);
  const base = Number.isFinite(current) ? current : 0;
  return String(Math.max(1, base + delta));
}

/**
 * Which priced line belongs to which form row, for the running total.
 *
 * `priceJob` writes one line per priced row, in row order, and skips a row it
 * could not price; a fuel levy, if any, comes last and belongs to no row. So
 * the lines are walked alongside the rows, matching on the item (or, for a row
 * with no item, the kind of laundry).
 */
export function matchQuoteLines(
  rows: readonly Pick<OrderItemInput, "item_id" | "item_type">[],
  lines: readonly { source_item_id: string | null; source_laundry_item_type: string | null; unit_price: number; amount: number }[],
): Array<{ unitPrice: number; amount: number } | null> {
  const out: Array<{ unitPrice: number; amount: number } | null> = [];
  let next = 0;
  for (const row of rows) {
    const line = lines[next];
    const matches = line
      && line.source_laundry_item_type === row.item_type
      && (row.item_id ? line.source_item_id === row.item_id : true);
    if (matches) {
      out.push({ unitPrice: line.unit_price, amount: line.amount });
      next += 1;
    } else {
      out.push(null);
    }
  }
  return out;
}
