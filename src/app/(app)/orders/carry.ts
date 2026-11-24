import { isRealIsoDate } from "@/lib/domain/dates";

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
  };
}
