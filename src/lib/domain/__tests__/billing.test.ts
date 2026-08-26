import { describe, expect, it } from "vitest";
import {
  BILLING_METHODS, BILLING_METHOD_LABELS, BILLING_STATUSES, BILLING_STATUS_LABELS,
  checkBillingTransition, chargesAreEditable, isBillingMethod,
  isBillingStatus, isConsolidated, nextBillingStatuses, OPEN_BILLING_STATUSES,
  type BillingStatus,
} from "@/lib/domain/billing";
import { sweptByMonthEndRun } from "@/lib/domain/billing-period";

/**
 * The financial lifecycle, held to the same standard as the operational one:
 * every state is labelled, the transition table is asserted in both directions,
 * and the two rules that are easy to get backwards — completion never bills, and
 * an invoiced job never walks back — are pinned explicitly.
 */

const completed = { operationalStatus: "completed", chargeCount: 3 };

describe("billing statuses", () => {
  it("labels and blurbs every status", () => {
    for (const status of BILLING_STATUSES) {
      expect(BILLING_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("recognises its own statuses and nothing else", () => {
    expect(isBillingStatus("awaiting_review")).toBe(true);
    expect(isBillingStatus("overdue")).toBe(false);
    // The operational statuses are a different sequence and must not leak in.
    expect(isBillingStatus("out_for_delivery")).toBe(false);
  });

  it("treats paid and not_billable as terminal", () => {
    expect(nextBillingStatuses("paid")).toEqual([]);
    expect(nextBillingStatuses("not_billable")).toEqual([]);
  });
});

describe("checkBillingTransition", () => {
  it("moves a completed job from awaiting review to approved", () => {
    expect(checkBillingTransition("awaiting_review", "approved", completed)).toEqual({ ok: true });
  });

  it("refuses to approve a job that is not finished", () => {
    const result = checkBillingTransition("awaiting_review", "approved", {
      operationalStatus: "out_for_delivery", chargeCount: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/completed job/i);
  });

  it("refuses to approve a job with no charges on it", () => {
    const result = checkBillingTransition("awaiting_review", "approved", {
      operationalStatus: "completed", chargeCount: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no charges/i);
  });

  it("allows sending an approved job back for review", () => {
    expect(checkBillingTransition("approved", "awaiting_review", completed)).toEqual({ ok: true });
  });

  it("refuses to walk an invoiced job back to review, and says to void instead", () => {
    const result = checkBillingTransition("invoice_generated", "awaiting_review", completed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/void the invoice/i);
  });

  it("refuses to release a job that is still on an invoice", () => {
    // The release path exists so voiding a wrong invoice frees its work to be
    // billed again. Reaching it while the invoice is still standing would let
    // the same job be billed twice, which the unique index would then refuse
    // anyway — but the sentence here is the one a person can act on.
    const result = checkBillingTransition("invoice_generated", "approved", {
      ...completed, onAnInvoice: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/still on an invoice/i);
  });

  it("defaults to refusing a release when the caller has not checked", () => {
    // `onAnInvoice` omitted means "nobody looked", and the conservative answer
    // to that is no — an accidental re-billing is the expensive mistake.
    expect(checkBillingTransition("invoice_sent", "approved", completed).ok).toBe(false);
  });

  it("releases a job once nothing invoices it any more", () => {
    for (const from of ["invoice_generated", "invoice_sent"] as BillingStatus[]) {
      expect(checkBillingTransition(from, "approved", { ...completed, onAnInvoice: false }))
        .toEqual({ ok: true });
    }
  });

  it("keeps generation and sending as separate steps", () => {
    // The whole of phase 5: generating does not send, so `invoice_generated`
    // cannot jump to `paid` via a send that never happened... it can be paid
    // directly (a customer can pay an invoice handed over at the counter), but
    // `invoice_sent` is never skipped *backwards* into.
    expect(nextBillingStatuses("invoice_generated")).toEqual(["invoice_sent", "paid", "approved"]);
    expect(checkBillingTransition("invoice_sent", "invoice_generated", completed).ok).toBe(false);
  });

  it("refuses anything after paid", () => {
    const result = checkBillingTransition("paid", "invoice_sent", completed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/credit note/i);
  });

  it("refuses a move to the state it is already in", () => {
    expect(checkBillingTransition("approved", "approved", completed).ok).toBe(false);
  });

  it("lets any live state be written off, and no terminal one", () => {
    for (const from of ["pending", "awaiting_review", "approved"] as BillingStatus[]) {
      expect(checkBillingTransition(from, "not_billable", completed)).toEqual({ ok: true });
    }
    expect(checkBillingTransition("not_billable", "awaiting_review", completed).ok).toBe(false);
  });

  it("never lets a job skip review on the way to being invoiced", () => {
    expect(checkBillingTransition("pending", "invoice_generated", completed).ok).toBe(false);
    expect(checkBillingTransition("awaiting_review", "invoice_generated", completed).ok).toBe(false);
  });
});

describe("chargesAreEditable", () => {
  it("is true only while the job is awaiting review", () => {
    expect(chargesAreEditable("awaiting_review")).toBe(true);
    for (const status of BILLING_STATUSES.filter((s) => s !== "awaiting_review")) {
      expect(chargesAreEditable(status)).toBe(false);
    }
  });
});

describe("the queue", () => {
  it("is the two states waiting on a person", () => {
    expect(OPEN_BILLING_STATUSES).toEqual(["awaiting_review", "approved"]);
  });
});

describe("billing methods", () => {
  it("labels every method", () => {
    for (const method of BILLING_METHODS) expect(BILLING_METHOD_LABELS[method]).toBeTruthy();
  });

  it("recognises its own methods and nothing else", () => {
    expect(isBillingMethod("monthly_consolidated")).toBe(true);
    expect(isBillingMethod("annually")).toBe(false);
  });

  it("knows which methods roll several jobs onto one invoice", () => {
    expect(isConsolidated("weekly_consolidated")).toBe(true);
    expect(isConsolidated("fortnightly_consolidated")).toBe(true);
    expect(isConsolidated("monthly_consolidated")).toBe(true);
    expect(isConsolidated("invoice_per_job")).toBe(false);
    expect(isConsolidated("manual")).toBe(false);
  });

  it("excludes only `manual` from an automatic run", () => {
    // `manual` means "a person chooses each time", not "never bill them" — so
    // it is the one method the month-end run skips, and the only one. Approving
    // one of their jobs still places it: that is a person choosing.
    for (const method of BILLING_METHODS) {
      expect(sweptByMonthEndRun(method)).toBe(method !== "manual");
    }
  });
});
