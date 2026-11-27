import { isRealIsoDate } from "@/lib/domain/dates";
import {
  ITEM_TYPES, RECEIVED_VIA, type OrderItemInput, type ReceivedVia,
} from "@/lib/domain/laundry-orders";

/**
 * What a job form hands back through a redirect (2026-11-23).
 *
 * A refused save and the customer quick-create both come back to the job form
 * by a redirect, so anything held only in the browser is gone. These are the
 * answers that cost real work to give again, or real attention to notice were
 * lost: the customer chosen, the day the laundry was received, and the return
 * date the counter picked. A job entered for last Tuesday that came back
 * reading today would be saved as received today with nothing on screen
 * saying so.
 *
 * A plain module rather than part of `actions.ts`, because the form builds the
 * quick-create's return address with it in the browser, and a `"use server"`
 * module can export nothing but server actions. Every value is re-validated
 * here because it came off a form: only a well-formed uuid and real dates are
 * ever put in the URL.
 */
export type CarriedAnswers = {
  customer?: string | null;
  received?: string | null;
  /** The expected delivery date. */
  due?: string | null;
  /** The expected collection date, for a customer pickup. */
  collect?: string | null;
  /**
   * Whether the job is delivered back (`true`) or collected by the customer
   * (`false`). Without it a refused customer pickup comes back as a delivery,
   * hiding the collection date it was handed (2026-11-24).
   */
  delivery?: boolean | null;
  /**
   * How the laundry arrived, and for a driver pickup the day and the driver
   * (`?via=`, `?picked=`, `?collector=`). Without them a refused save, and above
   * all a refused take-in that loses its `?pickup=`, reopens as a counter
   * drop-off and a corrected save records the wrong channel (2026-11-24).
   */
  via?: string | null;
  picked?: string | null;
  collector?: string | null;
  /**
   * The laundry list as the form posted it (its hidden `items` field), so a
   * refused save or a quick-created customer does not cost the counter every
   * row they typed (2026-11-24). Carried only while it fits
   * (`MAX_CARRIED_ROWS`); a longer list is dropped rather than truncated.
   */
  rows?: string | null;
  /**
   * A job booked by the lot (0066): whether the Laundry by Lot switch was on,
   * the number of lots and the item notes (`?booking=lot`, `?lots=`,
   * `?lotnotes=`). Without them a refused lot booking reopens as an itemised
   * job with one empty row, and the counter has to find the switch again.
   */
  booking?: string | null;
  lots?: string | null;
  lotNotes?: string | null;
};

/** The longest lot note carried in the URL; a longer one is cut rather than dropped. */
export const MAX_CARRIED_LOT_NOTES = 500;

/**
 * The longest laundry list carried in the URL, in characters of JSON. A dozen
 * rows is well inside it; anything longer would push the redirect towards the
 * size proxies refuse, so it is not carried at all rather than cut in half.
 */
export const MAX_CARRIED_ROWS = 3000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function carryAnswers(path: string, answers: CarriedAnswers): string {
  const [base = path, existing] = path.split("?");
  const query = new URLSearchParams(existing);
  if (answers.customer && UUID.test(answers.customer)) query.set("customer", answers.customer);
  for (const key of ["received", "due", "collect"] as const) {
    const value = answers[key];
    if (isRealIsoDate(value)) query.set(key, value);
  }
  if (typeof answers.delivery === "boolean") query.set("delivery", answers.delivery ? "yes" : "no");
  const via = carriedVia(answers.via);
  if (via) query.set("via", via);
  // A pickup's day and driver mean nothing for any other channel.
  if (via === "driver_pickup") {
    if (isRealIsoDate(answers.picked)) query.set("picked", answers.picked);
    if (answers.collector && UUID.test(answers.collector)) query.set("collector", answers.collector);
  }
  const rows = carriedItems(answers.rows);
  const encoded = rows ? JSON.stringify(rows) : null;
  // Re-checked after re-serialising, so the page reading it back keeps it.
  if (encoded && encoded.length <= MAX_CARRIED_ROWS) query.set("rows", encoded);
  // Standard is carried too: editing a lot booking, switching it off and being
  // refused must not reopen it as the lot booking it was stored as.
  if (answers.booking === "standard") query.set("booking", "standard");
  if (answers.booking === "lot") {
    query.set("booking", "lot");
    // Carried as typed — a save refused for "0" lots comes back saying 0, so the
    // box the toast talks about holds the value it talks about — but only while
    // it is a short run of digits, so the URL never carries anything else.
    const lots = answers.lots?.trim();
    if (lots && /^\d{1,4}$/.test(lots)) query.set("lots", lots);
    const notes = answers.lotNotes?.trim();
    if (notes) query.set("lotnotes", notes.slice(0, MAX_CARRIED_LOT_NOTES));
  }
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

/** The answers a posted job form carries, read off its fields. */
export function answersFromForm(formData: FormData): CarriedAnswers {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : null;
  };
  return {
    customer: text("customer_id"),
    received: text("received_date"),
    due: text("expected_delivery_date"),
    collect: text("expected_collection_date"),
    // The job form posts `delivery_required=on` only for a delivery, so its
    // absence is an answer: the customer collects.
    delivery: formData.get("delivery_required") === "on",
    via: text("received_via"),
    picked: text("pickup_date"),
    collector: text("pickup_driver_id"),
    rows: text("items"),
    booking: text("booking_type"),
    lots: text("lot_count"),
    lotNotes: text("lot_notes"),
  };
}

/**
 * The path with one query parameter taken off. A take-in refused because its
 * customer is unusable must not come back to `?pickup=`, which re-seeds that
 * very customer from the collection.
 */
export function withoutParam(path: string, key: string): string {
  const [base = path, existing] = path.split("?");
  const query = new URLSearchParams(existing);
  query.delete(key);
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

/** `?delivery=yes|no` read back; anything else is no answer at all. */
export function carriedDelivery(value: string | null | undefined): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

/** `?via=` read back: one of the stored channels, or no answer at all. */
export function carriedVia(value: string | null | undefined): ReceivedVia | undefined {
  return (RECEIVED_VIA as readonly string[]).includes(value ?? "") ? (value as ReceivedVia) : undefined;
}

/** `?booking=` read back: `standard` or `lot`, or no answer at all. */
export function carriedBooking(value: string | null | undefined): "standard" | "lot" | undefined {
  return value === "lot" || value === "standard" ? value : undefined;
}

/** `?lots=` read back: up to four digits, or no answer at all. */
export function carriedLots(value: string | null | undefined): string | undefined {
  return value && /^\d{1,4}$/.test(value) ? value : undefined;
}

/** A carried uuid (`?collector=`) read back, or nothing. */
export function carriedUuid(value: string | null | undefined): string | undefined {
  return value && UUID.test(value) ? value : undefined;
}

const optionalString = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
const optionalNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * `?rows=` read back into laundry rows, or nothing. Lenient on purpose: a save
 * is often refused *because* of a row, and the counter needs that row back to
 * fix it, so nothing here is validated beyond its shape — `createOrder` and
 * `updateOrder` validate it again on the next save. Rows that say nothing at
 * all are left out, so an empty form does not come back as a list.
 */
export function carriedItems(value: string | null | undefined): OrderItemInput[] | undefined {
  if (!value || value.length > MAX_CARRIED_ROWS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const items = parsed.flatMap((entry): OrderItemInput[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const item: OrderItemInput = {
      item_id: typeof row.item_id === "string" && UUID.test(row.item_id) ? row.item_id : null,
      item_type: (ITEM_TYPES as readonly unknown[]).includes(row.item_type) ? String(row.item_type) : "other",
      custom_description: optionalString(row.custom_description),
      quantity_type: row.quantity_type === "bulk_lot" ? "bulk_lot" : "exact",
      exact_quantity: optionalNumber(row.exact_quantity),
      bag_count: optionalNumber(row.bag_count),
      estimated_quantity: optionalNumber(row.estimated_quantity),
      notes: optionalString(row.notes),
      ownership: row.ownership === "rental" || row.ownership === "own" ? row.ownership : null,
    };
    const says = item.item_id || item.custom_description || item.notes
      || item.exact_quantity != null || item.bag_count != null || item.estimated_quantity != null;
    return says ? [item] : [];
  });
  return items.length ? items : undefined;
}
