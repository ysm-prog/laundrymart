import { isRealIsoDate } from "@/lib/domain/dates";
import { RECEIVED_VIA, type ReceivedVia } from "@/lib/domain/laundry-orders";

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
};

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

/** A carried uuid (`?collector=`) read back, or nothing. */
export function carriedUuid(value: string | null | undefined): string | undefined {
  return value && UUID.test(value) ? value : undefined;
}
