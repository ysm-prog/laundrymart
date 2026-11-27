/**
 * Laundry booked by the lot (0066, the client's request of 2026-11-27).
 *
 * Beside the itemised job — an item, a count, a kind of laundry and Rental or
 * Own on every row — a job may be booked as a **number of lots** and a note, at
 * the standard lot price. Nothing about the itemised job changes; a job is one
 * or the other (`booking_type`).
 *
 * The money is the database's: `sync_lot_booking_price` fixes the unit price on
 * the day a job becomes a lot booking and recomputes the totals whenever the
 * count changes. `lotPricing` here is the same arithmetic, for the form's live
 * total and for the invoice line, and `STANDARD_LOT_PRICE_EX_GST` is pinned to
 * the migration's `standard_lot_price_ex_gst()` by a test — two copies of one
 * number, each checked against the other, the arrangement `issueGaps` has with
 * `guard_invoice_issue`.
 *
 * Pure, with no database access, so the rule is reachable from a unit test.
 */

import { round2 } from "@/lib/domain/pricing";
import type { JobChargeLine } from "@/lib/domain/job-pricing";

export const BOOKING_TYPES = ["standard", "lot"] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

/** The standard price of one lot, excluding GST. Changing it is a migration too. */
export const STANDARD_LOT_PRICE_EX_GST = 40;

/** The check constraint's ceiling (0066): a lot count is 1 to 9,999. */
export const MAX_LOTS = 9999;

/** What an invoice line for lots is called. */
export const LOT_LINE_DESCRIPTION = "Laundry Services – Per Lot";

/** The pricing model a lot charge carries, so the invoice and the auto-approval rule can recognise it. */
export const LOT_PRICING_MODEL = "per_lot";

export function isBookingType(value: unknown): value is BookingType {
  return value === "standard" || value === "lot";
}

export type LotPricing = {
  lots: number;
  unitPriceExGst: number;
  totalExGst: number;
  gstAmount: number;
  totalIncGst: number;
};

/**
 * The money for a number of lots, rounded the way the database rounds it:
 * `total_ex = count × unit`, `gst = round(total_ex × rate)`, `total_inc` the sum.
 * GST is worked on the total rather than per lot, so 3 lots at a price that is
 * not a round number cannot drift a cent from the invoice's own extraction.
 */
export function lotPricing(
  lots: number, unitPriceExGst: number = STANDARD_LOT_PRICE_EX_GST, gstRate = 0.1,
): LotPricing {
  const totalExGst = round2(lots * unitPriceExGst);
  const gstAmount = round2(totalExGst * gstRate);
  return {
    lots,
    unitPriceExGst: round2(unitPriceExGst),
    totalExGst,
    gstAmount,
    totalIncGst: round2(totalExGst + gstAmount),
  };
}

/**
 * Read a posted Number of Lots. A positive whole number, or the sentence the
 * person at the counter should read: zero, negative and decimal counts are
 * refused (the database refuses them too, but its message names a constraint).
 */
export function readLotCount(
  raw: unknown,
): { ok: true; lots: number } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (text === "") return { ok: false, error: "Please enter the number of lots." };
  if (!/^\d+$/.test(text)) {
    return { ok: false, error: "The number of lots is a whole number, like 5 — not a decimal or a negative." };
  }
  const lots = Number(text);
  if (lots < 1) return { ok: false, error: "The number of lots must be at least 1." };
  if (lots > MAX_LOTS) return { ok: false, error: `The number of lots cannot be more than ${MAX_LOTS.toLocaleString("en-AU")}.` };
  return { ok: true, lots };
}

/** "10 lots", "1 lot". */
export function describeLots(lots: number): string {
  return `${lots.toLocaleString("en-AU")} ${lots === 1 ? "lot" : "lots"}`;
}

/** The lot price as the database stores it (`laundry_order_lot_prices`). */
export type StoredLotPrice = {
  unit_price_ex_gst: number | string;
  gst_rate: number | string;
  total_ex_gst: number | string;
  gst_amount: number | string;
  total_inc_gst: number | string;
};

/**
 * The one charge a lot booking makes.
 *
 * A line amount in this app is **GST-inclusive** (0043: `recalculate_invoice`
 * extracts the tax from within), so the line carries the inclusive unit price —
 * $44.00 for a $40.00 lot — and the stored inclusive total. On the invoice that
 * reads `10 × $44.00 = $440.00, includes GST $40.00`, which is the same money
 * as `10 × $40.00 + $40.00 GST`; the ex-GST figures stay on the booking.
 *
 * `per_lot` is what lets the line merge with another job's lot line on a
 * monthly draft, and what tells the automatic approval it came from a standard
 * price rather than an item's list price.
 */
export function lotChargeLine(lots: number, price: StoredLotPrice, sequence = 1): JobChargeLine {
  const rate = Number(price.gst_rate);
  const unitInc = round2(Number(price.unit_price_ex_gst) * (1 + rate));
  return {
    sequence,
    description: LOT_LINE_DESCRIPTION,
    charge_type: "wash_only",
    quantity: lots,
    unit_price: unitInc,
    amount: round2(Number(price.total_inc_gst)),
    taxable: rate > 0,
    source_agreement_id: null,
    source_agreement_line_id: null,
    source_item_id: null,
    source_laundry_item_type: null,
    pricing_model: LOT_PRICING_MODEL,
    gl_account_id: null,
  };
}

/** The longest lot note stored. */
export const MAX_LOT_NOTES = 1000;

export type BookingAnswer =
  | { ok: true; type: "standard" }
  | { ok: true; type: "lot"; lots: number; notes: string | null }
  | { ok: false; error: string };

/**
 * The booking half of a posted job form. An absent or unknown `booking_type`
 * is `standard`, so a form that predates Laundry by Lot keeps working exactly
 * as it did. A standard booking ignores whatever lot fields came with it — a
 * count left in a hidden box must not turn into a lot booking.
 */
export function readBookingForm(posted: {
  booking_type?: unknown; lot_count?: unknown; lot_notes?: unknown;
}): BookingAnswer {
  if (posted.booking_type !== "lot") return { ok: true, type: "standard" };
  const count = readLotCount(posted.lot_count);
  if (!count.ok) return count;
  const notes = typeof posted.lot_notes === "string" ? posted.lot_notes.trim() : "";
  if (notes.length > MAX_LOT_NOTES) {
    return { ok: false, error: `Item notes can be up to ${MAX_LOT_NOTES.toLocaleString("en-AU")} characters.` };
  }
  return { ok: true, type: "lot", lots: count.lots, notes: notes || null };
}

/** The three columns a booking writes on `laundry_orders`. */
export function bookingColumns(answer: Extract<BookingAnswer, { ok: true }>): {
  booking_type: BookingType; lot_count: number | null; lot_notes: string | null;
} {
  return answer.type === "lot"
    ? { booking_type: "lot", lot_count: answer.lots, lot_notes: answer.notes }
    : { booking_type: "standard", lot_count: null, lot_notes: null };
}
