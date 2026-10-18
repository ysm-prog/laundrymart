import type { BillingStatus } from "./billing";
import type { OrderStatus } from "./laundry-orders";

/**
 * The Laundry board (Darshan's review, brief 3.3).
 *
 * One view of every live job in five columns. **The database statuses stay
 * exactly as they are** — seven operational and seven billing — and this file
 * is the whole of the merge: which column a job is drawn in, and which of the
 * three bulk actions it is eligible for. Pure, so the board, the bulk actions
 * and the tests read one rule.
 */
export const BOARD_COLUMNS = [
  { key: "plant", label: "In the plant", hint: "New and in progress" },
  { key: "ready", label: "Ready", hint: "Washed and waiting for its round, or for the customer" },
  { key: "out", label: "Out", hint: "On a van today" },
  { key: "delivered", label: "Delivered", hint: "Finished, not on an invoice yet" },
  { key: "billed", label: "Billed", hint: "On a draft, sent or paid" },
] as const;

export type BoardColumn = (typeof BOARD_COLUMNS)[number]["key"];

export type BoardJob = {
  status: OrderStatus | string;
  billing_status: BillingStatus | string;
  delivery_required: boolean;
  assigned_board_id: string | null;
};

const BILLED = new Set(["invoice_generated", "invoice_sent", "paid", "not_billable"]);

/**
 * The column a job is drawn in, or null for one the board leaves out.
 *
 * `assigned` sits under Ready rather than Out: a job on tomorrow's round has
 * not left the building, and the board's question is *where is the laundry*.
 * The card says which round it is on. `not_billable` is Billed because the
 * money question about it is settled; the card says so.
 */
export function boardColumn(job: BoardJob): BoardColumn | null {
  switch (job.status) {
    case "new":
    case "in_progress":
      return "plant";
    case "ready_for_delivery":
    case "assigned":
      return "ready";
    case "out_for_delivery":
      return "out";
    case "completed":
      return BILLED.has(job.billing_status) ? "billed" : "delivered";
    default:
      return null; // cancelled, and anything a later migration adds
  }
}

/** Mark ready: anything still in the plant. */
export function canMarkReady(job: BoardJob): boolean {
  return job.status === "new" || job.status === "in_progress";
}

/** Assign: a delivery job that is ready and not yet on a van (a reassignment is fine). */
export function canAssign(job: BoardJob): boolean {
  return job.delivery_required && (job.status === "ready_for_delivery" || job.status === "assigned");
}

/** Approve: finished, waiting for review, with charges on it — approving an unpriced job is refused. */
export function canApprove(job: BoardJob & { charge_count: number }): boolean {
  return job.status === "completed" && job.billing_status === "awaiting_review" && job.charge_count > 0;
}

/**
 * What a docket scan typed, as a job number to look up.
 *
 * A handheld scanner types the barcode's text and presses Enter. Code 128
 * carries the job number exactly (`LJ00032`), but a person typing it by hand
 * types `lj32` or `LJ 00032` — so the rule trims, upper-cases, drops spaces and
 * zero-pads the digits to the five `next_number()` issues. Anything that is not
 * letters-then-digits is refused rather than guessed at.
 */
export function normaliseDocket(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/\s+/g, "");
  const match = /^([A-Z]{1,4})(\d{1,8})$/.exec(compact);
  if (!match) return null;
  const [, prefix, digits] = match;
  return `${prefix}${digits!.padStart(5, "0")}`;
}

/** The short billing word on a card in the Delivered and Billed columns. */
export function boardBillingLabel(job: BoardJob & { billing_hold_reason?: string | null }): string | null {
  if (job.status !== "completed") return null;
  if (job.billing_hold_reason === "needs_price") return "Needs a price";
  switch (job.billing_status) {
    case "awaiting_review": return "To check";
    case "approved": return "Approved";
    case "invoice_generated": return "On a draft";
    case "invoice_sent": return "Sent";
    case "paid": return "Paid";
    case "not_billable": return "Not billed";
    default: return null;
  }
}
