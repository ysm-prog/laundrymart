/**
 * A job's *financial* life, with no database in sight.
 *
 * The operational statuses in `laundry-orders.ts` say where the laundry is. This
 * says where the money is, and the two are deliberately separate sequences that
 * touch at exactly one point: **finishing the work puts a job in front of a
 * person, and never bills anybody.**
 *
 * `invoice_generated` is a job's money sitting on a **draft**, not an invoice a
 * customer has: approving places the charges, issuing the draft is what creates
 * the invoice, and sending it is what the customer sees. There is no path from a
 * job to an invoice that skips the draft.
 *
 *   operational   new → in_progress → ready_for_delivery → assigned
 *                     → out_for_delivery → completed
 *   financial     pending → awaiting_review → approved → invoice_generated
 *                     → invoice_sent → paid
 *
 * Same arrangement as everything else in this folder: the table below is a
 * transcription of `guard_laundry_order_billing()` in migration 0017. The
 * database is the boundary; this is what lets the screen say a sentence instead
 * of surfacing a trigger's exception, and what the unit tests hold the two to.
 */

import type { Capability } from "@/lib/roles";

/* --------------------------------------------------------- the lifecycle */

export const BILLING_STATUSES = [
  "pending",
  "awaiting_review",
  "approved",
  "invoice_generated",
  "invoice_sent",
  "paid",
  "not_billable",
] as const;

export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const BILLING_STATUS_LABELS: Record<BillingStatus, string> = {
  pending: "Not yet billable",
  awaiting_review: "Awaiting review",
  approved: "Approved",
  // Not "Invoice generated". Approving puts the charges on a draft, and a label
  // saying an invoice was generated is what made that read as though pressing
  // Approve had created one.
  invoice_generated: "On a draft invoice",
  invoice_sent: "Invoice sent",
  paid: "Paid",
  not_billable: "Not billable",
};

/** One line of explanation per state, for the job page and the queue. */
export const BILLING_STATUS_BLURBS: Record<BillingStatus, string> = {
  pending: "The work is not finished, so there is nothing to bill yet.",
  awaiting_review: "The work is done. Check the charges, then approve them.",
  approved: "The charges are locked in. This job is ready to join its customer\u2019s draft.",
  invoice_generated: "The charges are on a draft invoice. Nothing has been issued or sent.",
  invoice_sent: "The invoice has been emailed to the customer.",
  paid: "The invoice covering this job has been paid in full.",
  not_billable: "This job will not be billed.",
};

export function isBillingStatus(value: string): value is BillingStatus {
  return (BILLING_STATUSES as readonly string[]).includes(value);
}

/**
 * The transition table, mirrored by the guard in 0017.
 *
 * Forward-only with two deliberate exceptions. `approved → awaiting_review` is
 * "send it back", which a reviewer needs while an invoice does not yet exist;
 * and any live state may become `not_billable`, which is writing the work off.
 *
 * Nothing walks back past `invoice_generated`, because at that point the price
 * is on a document. A wrong invoice is voided — and voiding is what releases the
 * job to be billed again (the partial unique index in 0017), so the way back is
 * through the invoice rather than through the job.
 */
const TRANSITIONS: Record<BillingStatus, readonly BillingStatus[]> = {
  pending: ["awaiting_review", "not_billable"],
  awaiting_review: ["approved", "not_billable"],
  approved: ["invoice_generated", "awaiting_review", "not_billable"],
  // `approved` is reachable from both invoiced states, but only once the job is
  // on no invoice — that is what voiding does, and it is the *invoice's* action,
  // never a button on the job. `checkBillingTransition` refuses it while the job
  // is still linked, and so does the guard in 0017.
  invoice_generated: ["invoice_sent", "paid", "approved"],
  invoice_sent: ["paid", "approved"],
  paid: [],
  not_billable: [],
};

/** The billing states a job can move to next. */
export function nextBillingStatuses(from: BillingStatus): BillingStatus[] {
  return [...TRANSITIONS[from]];
}

/**
 * Whether a billing move is allowed, and if not, why — as a sentence somebody
 * can act on rather than a trigger's exception.
 *
 * `operationalStatus` is required because the one cross-lifecycle rule runs in
 * exactly one direction: the work gates the money, never the other way round.
 */
export function checkBillingTransition(
  from: BillingStatus,
  to: BillingStatus,
  context: {
    operationalStatus: string;
    chargeCount: number;
    /**
     * Whether the job is still linked to an invoice. Only consulted on the
     * release path back to `approved`; defaults to true, so a caller that has
     * not checked gets the conservative answer rather than an accidental
     * re-billing.
     */
    onAnInvoice?: boolean;
  },
): { ok: true } | { ok: false; reason: string } {
  if (from === to) {
    return { ok: false, reason: `This job is already ${BILLING_STATUS_LABELS[to].toLowerCase()}.` };
  }
  if (from === "paid") {
    return { ok: false, reason: "This job has been paid for. Raise a credit note if it was wrong." };
  }
  if (from === "not_billable") {
    return { ok: false, reason: "This job was marked not billable, so it has no billing left to do." };
  }
  if (to === "approved") {
    if (context.operationalStatus !== "completed") {
      return { ok: false, reason: "Only a completed job can be approved for billing." };
    }
    if (context.chargeCount === 0) {
      return { ok: false, reason: "This job has no charges to approve. Price it first." };
    }
    // The release path. Coming back from an invoiced state is legitimate only
    // once nothing invoices this job any more, which is what voiding produces.
    if ((from === "invoice_generated" || from === "invoice_sent") && context.onAnInvoice !== false) {
      return {
        ok: false,
        reason: "This job is still on an invoice. Take it off that draft, or void the "
          + "invoice if it has already been issued — either releases the job.",
      };
    }
  }
  if (!TRANSITIONS[from].includes(to)) {
    if (from === "invoice_generated" || from === "invoice_sent") {
      return {
        ok: false,
        reason: "This job is on an invoice. Take it off that draft if the charges were "
          + "wrong, or void the invoice if it has already been issued — either releases "
          + "the job to be billed again.",
      };
    }
    return {
      ok: false,
      reason: `A job cannot go from ${BILLING_STATUS_LABELS[from].toLowerCase()} `
        + `to ${BILLING_STATUS_LABELS[to].toLowerCase()}.`,
    };
  }
  return { ok: true };
}

/** Awaiting a decision from a person, as opposed to waiting on the work or done. */
export const OPEN_BILLING_STATUSES: readonly BillingStatus[] = ["awaiting_review", "approved"];

/** Jobs whose charges are still editable. After this the price is history. */
export function chargesAreEditable(status: BillingStatus): boolean {
  return status === "awaiting_review";
}

/** Which capability each billing act needs. The action re-checks; this drives the UI. */
export const BILLING_CAPABILITIES = {
  review: "billing.read",
  price: "billing.write",
  approve: "invoices.approve",
  generate: "invoices.write",
  send: "invoices.send",
  bulk: "invoices.bulk",
} as const satisfies Record<string, Capability>;

/* ------------------------------------------------------- billing methods */

/**
 * How a customer's completed work becomes invoices.
 *
 * The architectural point, and the reason this is a customer setting rather than
 * a fork in the generator: **a completed job is a billable source**, and whether
 * August produces fifteen invoices or one is a question answered at generation
 * time from this field. Changing a customer from per-job to monthly is one
 * column, not a migration.
 */
export const BILLING_METHODS = [
  "invoice_per_job",
  "weekly_consolidated",
  "fortnightly_consolidated",
  "monthly_consolidated",
  "manual",
] as const;

export type BillingMethod = (typeof BILLING_METHODS)[number];

export const BILLING_METHOD_LABELS: Record<BillingMethod, string> = {
  invoice_per_job: "One invoice per job",  // one draft per job, issued one at a time
  weekly_consolidated: "Weekly consolidated",
  fortnightly_consolidated: "Fortnightly consolidated",
  monthly_consolidated: "Monthly consolidated",
  manual: "Manual",
};

/**
 * What each method means, in the owner's words.
 *
 * Every one of them collects on a **draft** — approving a job never creates an
 * invoice — so what differs is how many jobs share a draft, and (for `manual`)
 * whether the month-end run picks the customer up on its own.
 */
export const BILLING_METHOD_BLURBS: Record<BillingMethod, string> = {
  invoice_per_job: "Every approved job opens a draft of its own.",
  weekly_consolidated: "One draft a week, carrying every job approved in it.",
  fortnightly_consolidated: "One draft a fortnight, carrying every job approved in it.",
  monthly_consolidated: "One draft a month, carrying every job approved in it.",
  manual: "One draft a month, but left out of the month-end run — you issue it yourself.",
};

export function isBillingMethod(value: string): value is BillingMethod {
  return (BILLING_METHODS as readonly string[]).includes(value);
}

/** Methods that roll several jobs onto one invoice. */
export function isConsolidated(method: BillingMethod): boolean {
  return method.endsWith("_consolidated");
}

/*
 * Whether the month-end run picks a customer up on its own is
 * `sweptByMonthEndRun`, in `billing-period.ts`, beside the period rule it travels
 * with. There was a `generatesAutomatically` here saying the same thing to nobody
 * — no caller in `src/`, only its own test — and two answers to one question is
 * the duplication this codebase argues against everywhere else.
 */
