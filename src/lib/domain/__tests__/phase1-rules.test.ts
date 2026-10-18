import { describe, expect, it } from "vitest";
import {
  approveJobConfirmation, approveSelectionConfirmation, parseRebill, voidRebillQuestion,
} from "../confirmations";
import {
  TEST_DATA_REASON, looksLikeTestCustomer, matchCustomers, normaliseCustomerKey, parseCustomerList,
} from "../test-data";
import {
  DEFAULT_AR_TRUSTED_FROM, arTrustedFrom, isUnreconciledImport, trustedReceivablesFilter,
} from "../receivables";
import { PERIOD_INVOICE_STATE_LABELS, invoiceIsIssued, periodInvoiceState } from "../billing";
import { RECEIVED_FUTURE_TOLERANCE_MINUTES, receivedInFuture } from "../laundry-orders";

describe("the confirmations in front of the irreversible steps (brief 1.6)", () => {
  it("says the amount and that approving freezes the price", () => {
    expect(approveJobConfirmation("LJ00032", 25.08))
      .toBe("Approve $25.08 for LJ00032? Prices freeze and go onto the draft.");
  });
  it("counts a bulk approval and totals it", () => {
    expect(approveSelectionConfirmation(3, 120)).toMatch(/^Approve 3 jobs totalling \$120\.00\?/);
    expect(approveSelectionConfirmation(1, 12)).toMatch(/^Approve \$12\.00 for this job\?/);
  });
  it("names the jobs a void would put back in the queue", () => {
    expect(voidRebillQuestion(["LJ00032"])).toBe("Put LJ00032 back in the billing queue to bill again?");
    expect(voidRebillQuestion(["LJ1", "LJ2", "LJ3", "LJ4", "LJ5", "LJ6"]))
      .toBe("Put LJ1, LJ2, LJ3, LJ4 and 2 more back in the billing queue to bill again?");
    expect(voidRebillQuestion([])).toBeNull();
  });
  it("reads the answer, keeping today's behaviour when none was given", () => {
    expect(parseRebill("no")).toBe(false);
    expect(parseRebill("yes")).toBe(true);
    expect(parseRebill(null)).toBe(true);
  });
});

describe("the test-data clean-up's list (brief 1.8)", () => {
  const customers = [
    { id: "a", customer_number: "CUST00515", business_name: "ZZ TEST – Claude BA" },
    { id: "b", customer_number: "CUST00100", business_name: "Jay" },
    { id: "c", customer_number: "CUST00101", business_name: "Jay's Bakery" },
    { id: "d", customer_number: "CUST00102", business_name: "Test1" },
  ];

  it("reads one entry per line or comma, without blanks or repeats", () => {
    expect(parseCustomerList("Jay\n\n  Test1 , jay\nCUST00515")).toEqual(["Jay", "Test1", "CUST00515"]);
    expect(parseCustomerList(null)).toEqual([]);
  });

  it("matches a name exactly — 'Jay' never catches 'Jay's Bakery'", () => {
    const { matched, notFound } = matchCustomers(["Jay", "Nobody"], customers);
    expect(matched.map((row) => row.id)).toEqual(["b"]);
    expect(notFound).toEqual(["Nobody"]);
  });

  it("matches a customer number, and a hyphen typed for an en dash", () => {
    expect(matchCustomers(["cust00515"], customers).matched.map((row) => row.id)).toEqual(["a"]);
    expect(matchCustomers(["ZZ TEST - Claude BA"], customers).matched.map((row) => row.id)).toEqual(["a"]);
    expect(normaliseCustomerKey("  ZZ   TEST —  x ")).toBe("zz test - x");
  });

  it("suggests customers whose own names look like test data, and nothing else", () => {
    expect(looksLikeTestCustomer("Test1")).toBe(true);
    expect(looksLikeTestCustomer("ZZ TEST Demo Laundry")).toBe(true);
    expect(looksLikeTestCustomer("Testing Laboratories")).toBe(false);
    expect(looksLikeTestCustomer("Core IT")).toBe(false);
  });

  it("voids with the reason the brief names", () => {
    expect(TEST_DATA_REASON).toBe("Test data");
  });
});

describe("imported balances on Today (brief 1.9)", () => {
  it("defaults to the Xero cut-over and reads a saved date", () => {
    expect(DEFAULT_AR_TRUSTED_FROM).toBe("2026-10-01");
    expect(arTrustedFrom({})).toBe("2026-10-01");
    expect(arTrustedFrom({ receivables: { ar_trusted_from: "2026-07-01" } })).toBe("2026-07-01");
    expect(arTrustedFrom({ receivables: { ar_trusted_from: "soon" } })).toBe("2026-10-01");
  });
  it("marks an import from before the date, and never an app invoice", () => {
    expect(isUnreconciledImport({ source: "import", issue_date: "2025-03-01" }, "2026-10-01")).toBe(true);
    expect(isUnreconciledImport({ source: "import", issue_date: "2026-10-05" }, "2026-10-01")).toBe(false);
    expect(isUnreconciledImport({ source: "app", issue_date: "2025-03-01" }, "2026-10-01")).toBe(false);
  });
  it("counts app invoices and trusted imports, in one filter", () => {
    expect(trustedReceivablesFilter("2026-10-01")).toBe("source.eq.app,issue_date.gte.2026-10-01");
  });
});

describe("a period's invoice state reads the invoices (brief 1.4)", () => {
  it("calls a draft a draft, never invoiced — INV00004 and INV00005", () => {
    expect(periodInvoiceState({ jobCount: 2, issuedCount: 0, draftCount: 2 })).toBe("draft");
    expect(PERIOD_INVOICE_STATE_LABELS.draft).toBe("Draft – not issued");
  });
  it("is invoiced only once every job is on an issued invoice", () => {
    expect(periodInvoiceState({ jobCount: 2, issuedCount: 2, draftCount: 0 })).toBe("invoiced");
    expect(periodInvoiceState({ jobCount: 3, issuedCount: 1, draftCount: 2 })).toBe("part_invoiced");
    expect(periodInvoiceState({ jobCount: 3, issuedCount: 0, draftCount: 0 })).toBe("not_invoiced");
  });
  it("treats a draft and a void as not issued", () => {
    expect(invoiceIsIssued("draft")).toBe(false);
    expect(invoiceIsIssued("void")).toBe(false);
    expect(invoiceIsIssued("overdue")).toBe(true);
    expect(invoiceIsIssued(undefined)).toBe(false);
  });
});

describe("a receipt from the future (brief 1.5)", () => {
  const now = new Date("2026-10-17T02:00:00Z");
  it("refuses LJ00031's two days ahead", () => {
    expect(receivedInFuture("2026-10-19T01:05:00Z", now)).toBe(true);
  });
  it("allows the clock drift and anything earlier", () => {
    expect(RECEIVED_FUTURE_TOLERANCE_MINUTES).toBe(15);
    expect(receivedInFuture("2026-10-17T02:14:00Z", now)).toBe(false);
    expect(receivedInFuture("2026-10-17T02:16:00Z", now)).toBe(true);
    expect(receivedInFuture("2026-10-16T09:00:00Z", now)).toBe(false);
  });
});
