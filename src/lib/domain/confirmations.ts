/**
 * The sentences in front of the steps that cannot be taken back (brief 1.6,
 * gaps G9 and G17). Pure, so the screens share one wording and a test pins it
 * — the Help page promises these confirmations, and until 18 October 2026 most
 * of them did not exist.
 *
 * Each names the number, the amount and the consequence, because the person
 * reading it is about to commit and needs the fact rather than "Are you sure?".
 */

import { formatMoney } from "./pricing";

/** Approving one job: the freeze. */
export function approveJobConfirmation(orderNumber: string, value: number): string {
  return `Approve ${formatMoney(value)} for ${orderNumber}? Prices freeze and go onto the draft.`;
}

/** Approving a selection on the billing queue. */
export function approveSelectionConfirmation(count: number, value: number): string {
  return count === 1
    ? `Approve ${formatMoney(value)} for this job? Its prices freeze and go onto the customer’s draft invoice.`
    : `Approve ${count} jobs totalling ${formatMoney(value)}? Their prices freeze and go onto each customer’s draft invoice.`;
}

/**
 * The question a void asks about the work on it: bill it again, or not at all.
 * Names the jobs, because "the jobs" is not something a person can check.
 */
export function voidRebillQuestion(orderNumbers: readonly string[]): string | null {
  if (orderNumbers.length === 0) return null;
  const shown = orderNumbers.slice(0, 4).join(", ")
    + (orderNumbers.length > 4 ? ` and ${orderNumbers.length - 4} more` : "");
  return `Put ${shown} back in the billing queue to bill again?`;
}

/**
 * Reading the answer posted by the void form. Absent — a void with no jobs on
 * it, or an older form — keeps today's behaviour, which is to bill again.
 */
export function parseRebill(value: FormDataEntryValue | null | undefined): boolean {
  return value !== "no";
}
