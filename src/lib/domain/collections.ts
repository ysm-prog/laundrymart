import { isoWeekday } from "./dates";

/**
 * The standing weekly collection: who is due, on which day, and on whose round.
 *
 * The owner's description of how this laundry works, 2026-09-08: *"Customer
 * gives us towels weekly, we bill monthly per item collected."* The **billing**
 * half of that already worked — prices are per item code, and since 0040 every
 * approved job joins the customer's running monthly draft. What was missing was
 * the weekly half: nothing recorded that a customer is collected at all, so with
 * 451 active customers the round has to remember, and a customer that is missed
 * is missed silently.
 *
 * **This is deliberately not a service agreement.** `service_agreements` exists,
 * is unit-tested and holds 0 rows, and adopting it here would have billed this
 * laundry *wrongly* rather than merely awkwardly: a contract's `per_item` line
 * bills `standard_quantity × visits` — a fixed assumed quantity times the number
 * of *scheduled* visits (`invoicing.ts`). It bills the pattern. Since 0040 the
 * contract charges and the job charges land on the same monthly draft, so a
 * weekly towel contract plus the actual jobs would bill the same towels twice.
 *
 * So the schedule carries **no price at all**, which is the whole point: what
 * the customer pays still comes from what was collected. The rules below decide
 * only *who is due* and *whether they can be put on a round*.
 */

/** ISO 8601: 1 = Monday … 7 = Sunday, matching Postgres `isodow`. */
export const WEEKDAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
] as const;

/** True for a value the `chk_customers_collection_weekday` constraint accepts. */
export function isCollectionWeekday(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7;
}

export function weekdayName(weekday: number | null | undefined): string | null {
  return WEEKDAYS.find((day) => day.value === weekday)?.label ?? null;
}

/**
 * `undefined` as well as `null`, deliberately: not every read of a customer
 * selects these two columns, and a screen that did not ask has no schedule to
 * show — which is the same answer as one that has none. Requiring `null` would
 * make the type demand a cast at exactly the call sites least likely to have
 * checked, which is how a `?.` gets added and a real schedule stops rendering.
 */
export type CollectionSchedule = {
  collection_weekday?: number | null;
  collection_board_id?: string | null;
};

/**
 * The arrangement in one sentence, for a customer's record and the office list.
 *
 * A day with no round is a *legal and expected* state — it is exactly the "due,
 * but nobody is going" list the screen exists to surface — so it gets its own
 * wording rather than being described as though it were set up. A round with no
 * day is the meaningless half: the database allows it (0047 polices only what it
 * can answer from another row) and the sentence is what tells somebody it does
 * nothing.
 */
export function describeCollectionSchedule(
  schedule: CollectionSchedule, boardName?: string | null,
): string {
  const day = weekdayName(schedule.collection_weekday);
  if (!day) {
    return schedule.collection_board_id
      ? "A round is set but no day is, so nothing is ever due. Choose a collection day."
      : "No standing collection.";
  }
  return boardName
    ? `Collected every ${day} by ${boardName}.`
    : `Collected every ${day}. No round is set, so this will not appear on anyone's van.`;
}

/** True when this customer's standing collection falls on `date`. */
export function isDueOn(schedule: CollectionSchedule, date: string): boolean {
  return isCollectionWeekday(schedule.collection_weekday)
    && schedule.collection_weekday === isoWeekday(date);
}

/**
 * What can be done about one due customer, and why.
 *
 * Four answers rather than a boolean, because they want three different actions
 * on two different screens and one sentence for all of them would send somebody
 * to the wrong one. This is the same call `UNPRICED_REASON_TEXT` makes about
 * laundry nobody can price.
 */
export type CollectionDueState = "on_the_run" | "ready" | "no_round" | "paused";

export const COLLECTION_DUE_TEXT: Record<CollectionDueState, string> = {
  on_the_run: "already on the round for this day",
  ready: "waiting to be put on the round",
  no_round: "due, but no round is set — choose one on the customer's record",
  paused: "not collected while the customer is paused",
};

/**
 * A standing collection resumes only for an **active** customer.
 *
 * On hold, inactive and prospect are all answers somebody in the office decided,
 * and a weekly arrangement that quietly restarted for a paused customer would
 * send a van to a business that had asked to stop. They stay *listed* with the
 * reason — the fix is on their record, and hiding them would make a customer who
 * has come back look like one who was never set up.
 *
 * This is narrower than `isPickableCustomer`, which answers a different
 * question: that one is "may somebody choose this customer for a job they are
 * typing in", and a person deciding is not a schedule deciding for them.
 */
export function collectionDueState(
  input: { status: string | null; boardId: string | null; hasStop: boolean },
): CollectionDueState {
  if (input.hasStop) return "on_the_run";
  if (input.status !== "active") return "paused";
  if (!input.boardId) return "no_round";
  return "ready";
}

/** The customers a "create the collection stops" press would actually act on. */
export function collectionsToRaise<T extends { status: string | null; boardId: string | null; hasStop: boolean }>(
  due: readonly T[],
): T[] {
  return due.filter((entry) => collectionDueState(entry) === "ready");
}
