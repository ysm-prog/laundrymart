/**
 * Which part of a slow intake answer the job form may still apply (2026-11-24).
 *
 * The job form asks for a customer's intake defaults when a customer is chosen,
 * and again for a new return date when the received date changes. Either answer
 * can arrive after the counter has moved on, so each request records the
 * tickets as they stood when it was sent, and this rule compares them with the
 * tickets when it lands:
 *
 * - `customer` moves each time a customer is chosen;
 * - `date` moves each time a date request is actually *sent* — a date change
 *   that sends nothing must not invalidate a customer answer it never replaces;
 * - `dateLanded` is the `date` ticket of the last date answer that was applied.
 *
 * A plain module, not part of the form, so the rule can be tested by outcome
 * rather than by reading the component's source.
 */
export type IntakeTickets = { customer: number; date: number; dateLanded: number };

/**
 * - `drop`: another customer has been chosen since — none of it is theirs.
 * - `all`: nothing newer is in flight — items, defaults and return date.
 * - `items+defaults`: a date request was sent since and has not landed, or came
 *   back empty — the laundry and the "filled in from" note, but the return date
 *   is left to that date's own answer.
 * - `items`: a newer date answer has already set the defaults and the date.
 */
export type CustomerAnswerUse = "drop" | "all" | "items+defaults" | "items";

export function customerAnswerUse(sent: IntakeTickets, now: IntakeTickets): CustomerAnswerUse {
  if (now.customer !== sent.customer) return "drop";
  if (now.date === sent.date) return "all";
  if (now.dateLanded > sent.date) return "items";
  return "items+defaults";
}

/** A date answer applies only while neither the date nor the customer has moved on. */
export function dateAnswerApplies(sent: IntakeTickets, now: IntakeTickets): boolean {
  return now.date === sent.date && now.customer === sent.customer;
}
