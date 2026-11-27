import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOT_LINE_DESCRIPTION, LOT_PRICING_MODEL, MAX_LOTS, STANDARD_LOT_PRICE_EX_GST,
  bookingColumns, describeLots, lotChargeLine, lotPricing, readBookingForm, readLotCount,
} from "@/lib/domain/lot-booking";
import { consolidateChargeLines, jobInvoiceLines, type ChargeEntry } from "@/lib/domain/invoice-consolidation";
import { cleanPricingVerdict } from "@/lib/domain/automation";
import { pricingSourceLabel } from "@/lib/domain/job-pricing";
import { summariseItems } from "@/lib/domain/laundry-orders";
import { answersFromForm, carriedBooking, carriedLots, carryAnswers } from "@/app/(app)/orders/carry";

const root = join(__dirname, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the standard lot price", () => {
  it("is $40.00 excluding GST", () => {
    expect(STANDARD_LOT_PRICE_EX_GST).toBe(40);
  });

  it("is the same number the database fixes on a booking (0066)", () => {
    const sql = read("supabase/migrations/0066_laundry_by_lot.sql");
    const match = /function public\.standard_lot_price_ex_gst\(\)[\s\S]*?select ([\d.]+)::numeric/.exec(sql);
    expect(match?.[1]).toBeDefined();
    expect(Number(match![1])).toBe(STANDARD_LOT_PRICE_EX_GST);
  });
});

describe("lotPricing — the client's table", () => {
  it.each([
    [1, 40, 4, 44],
    [2, 80, 8, 88],
    [5, 200, 20, 220],
    [10, 400, 40, 440],
    [20, 800, 80, 880],
  ])("%i lots: $%i + $%i GST = $%i", (lots, ex, gst, inc) => {
    const price = lotPricing(lots, STANDARD_LOT_PRICE_EX_GST, 0.1);
    expect(price.unitPriceExGst).toBe(40);
    expect(price.totalExGst).toBe(ex);
    expect(price.gstAmount).toBe(gst);
    expect(price.totalIncGst).toBe(inc);
  });

  it("keeps the total as ex plus GST to the cent at a price that is not round", () => {
    const price = lotPricing(3, 33.33, 0.1);
    expect(price.totalExGst).toBe(99.99);
    expect(price.gstAmount).toBe(10);
    expect(price.totalIncGst).toBe(109.99);
  });
});

describe("readLotCount", () => {
  it("accepts a positive whole number", () => {
    expect(readLotCount("10")).toEqual({ ok: true, lots: 10 });
    expect(readLotCount(" 3 ")).toEqual({ ok: true, lots: 3 });
  });

  it.each(["0", "-2", "2.5", "1e3", "abc", "", "   "])("refuses %j", (raw) => {
    expect(readLotCount(raw).ok).toBe(false);
  });

  it("refuses more than the database accepts", () => {
    expect(readLotCount(String(MAX_LOTS)).ok).toBe(true);
    expect(readLotCount(String(MAX_LOTS + 1)).ok).toBe(false);
  });
});

describe("readBookingForm", () => {
  it("is standard when the switch is off or the field is absent", () => {
    expect(readBookingForm({})).toEqual({ ok: true, type: "standard" });
    // A count left in a box must not turn a standard job into a lot booking.
    expect(readBookingForm({ booking_type: "standard", lot_count: "5" })).toEqual({ ok: true, type: "standard" });
  });

  it("reads a lot booking with its notes", () => {
    expect(readBookingForm({ booking_type: "lot", lot_count: "10", lot_notes: "  Two wet  " }))
      .toEqual({ ok: true, type: "lot", lots: 10, notes: "Two wet" });
    expect(readBookingForm({ booking_type: "lot", lot_count: "1", lot_notes: "" }))
      .toEqual({ ok: true, type: "lot", lots: 1, notes: null });
  });

  it("refuses a lot booking without a valid count", () => {
    expect(readBookingForm({ booking_type: "lot", lot_count: "0" }).ok).toBe(false);
    expect(readBookingForm({ booking_type: "lot" }).ok).toBe(false);
  });

  it("writes the three columns the check constraint expects", () => {
    expect(bookingColumns({ ok: true, type: "standard" }))
      .toEqual({ booking_type: "standard", lot_count: null, lot_notes: null });
    expect(bookingColumns({ ok: true, type: "lot", lots: 4, notes: "x" }))
      .toEqual({ booking_type: "lot", lot_count: 4, lot_notes: "x" });
  });
});

describe("the invoice line for lots", () => {
  const stored = { unit_price_ex_gst: "40.00", gst_rate: "0.1000", total_ex_gst: "400.00", gst_amount: "40.00", total_inc_gst: "440.00" };

  it("carries 10 lots at the GST-inclusive unit price, totalling the stored figure", () => {
    const line = lotChargeLine(10, stored);
    expect(line.description).toBe(LOT_LINE_DESCRIPTION);
    expect(line.quantity).toBe(10);
    expect(line.unit_price).toBe(44);
    expect(line.amount).toBe(440);
    expect(line.taxable).toBe(true);
    expect(line.pricing_model).toBe(LOT_PRICING_MODEL);
  });

  it("totals as $440.00 including $40.00 GST on the invoice (0043 extracts GST from within)", () => {
    const line = lotChargeLine(10, stored);
    // recalculate_invoice: total = sum of line amounts, tax = total × rate / (1 + rate).
    expect(line.amount).toBe(440);
    expect(Math.round(line.amount * 0.1 / 1.1 * 100) / 100).toBe(40);
  });

  it("is approved automatically like a rate — it is the price fixed on the booking", () => {
    expect(cleanPricingVerdict([lotChargeLine(10, stored)], 0)).toEqual({ clean: true });
  });

  it("is described as the standard lot price", () => {
    expect(pricingSourceLabel([lotChargeLine(10, stored)], null)).toBe("the standard lot price");
  });

  it("merges two jobs' lots into one line on a monthly draft", () => {
    const five = { ...stored, total_ex_gst: "200.00", gst_amount: "20.00", total_inc_gst: "220.00" };
    const entries: ChargeEntry[] = [
      { job: { id: "a", orderNumber: "LJ00001", date: "2026-11-03" }, charge: lotChargeLine(10, stored) },
      { job: { id: "b", orderNumber: "LJ00002", date: "2026-11-10" }, charge: lotChargeLine(5, five) },
    ];
    const lines = consolidateChargeLines(entries);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(15);
    expect(lines[0]!.amount).toBe(660);
    expect(jobInvoiceLines(entries)[0]!.description).toBe(LOT_LINE_DESCRIPTION);
  });
});

describe("summaries", () => {
  it("say how many lots instead of 'No items'", () => {
    expect(summariseItems([], 2, { lotCount: 10 })).toBe("10 lots");
    expect(summariseItems([], 2, { lotCount: 1 })).toBe("1 lot");
    expect(summariseItems([])).toBe("No items");
    expect(describeLots(2)).toBe("2 lots");
  });
});

describe("a refused lot booking comes back as one", () => {
  it("carries the switch, the count and the notes", () => {
    const form = new FormData();
    form.set("booking_type", "lot");
    form.set("lot_count", "0");
    form.set("lot_notes", "Wet");
    const path = carryAnswers("/orders/new", answersFromForm(form));
    const query = new URLSearchParams(path.split("?")[1]);
    expect(carriedBooking(query.get("booking"))).toBe("lot");
    expect(carriedLots(query.get("lots"))).toBe("0");
    expect(query.get("lotnotes")).toBe("Wet");
  });

  it("carries a switch turned off, so an edited lot booking does not reopen as one", () => {
    const path = carryAnswers("/orders/x/edit", { booking: "standard", lots: "5" });
    expect(path).toBe("/orders/x/edit?booking=standard");
  });

  it("never carries anything but digits as the count", () => {
    expect(carryAnswers("/orders/new", { booking: "lot", lots: "<b>" })).toBe("/orders/new?booking=lot");
    expect(carriedLots("12345")).toBeUndefined();
  });
});

describe("the seam between the form and the actions", () => {
  const form = read("src/app/(app)/orders/job-form.tsx");
  const actions = read("src/app/(app)/orders/actions.ts");

  it("posts the three fields readBookingForm reads", () => {
    expect(form).toMatch(/name="booking_type"/);
    expect(form).toMatch(/name="lot_count"/);
    expect(form).toMatch(/name="lot_notes"/);
  });

  it("is a switch, not a checkbox, labelled Laundry by Lot", () => {
    expect(form).toMatch(/<Switch id="laundry-by-lot" label="Laundry by Lot"/);
  });

  it("reads the booking in both createOrder and updateOrder, and never writes a price", () => {
    expect(actions.match(/readBookingForm\(toObject\(formData\)\)/g)).toHaveLength(2);
    expect(actions.match(/\.\.\.bookingColumns\(booking\)/g)).toHaveLength(2);
    expect(actions).not.toMatch(/laundry_order_lot_prices/);
  });
});
