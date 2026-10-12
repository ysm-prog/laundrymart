import { describe, expect, it } from "vitest";
import {
  creditRefusal, reversalRefusal, settledStatus, unsettleHeaderOnly, voidRefusal,
} from "../payment-gate";
import {
  formatAbn, invoiceProfileGaps, invoiceTotalsRows, normaliseAbn, normaliseBsb,
  parseInvoiceProfile, paymentInstructions,
} from "../invoice-profile";
import { jobStatusOnInvoice } from "../billing";

// INV00006 from the 12 October test: $74.80, $30 paid, CN00001 $11, CN00002 $70.
const inv6 = { status: "part_paid", invoiceType: "consolidated", total: 74.8, amountPaid: 30 };

describe("credit notes are capped at what is still owed", () => {
  it("accepts the first $11", () => {
    expect(creditRefusal({ ...inv6, alreadyCredited: 0, amount: 11 })).toBeNull();
  });
  it("refuses the $70 that took the total past the invoice", () => {
    expect(creditRefusal({ ...inv6, alreadyCredited: 11, amount: 70 }))
      .toBe("Only $33.80 can still be credited ($74.80 invoiced, $30.00 paid, $11.00 already credited).");
  });
  it("allows exactly what is left", () => {
    expect(creditRefusal({ ...inv6, alreadyCredited: 11, amount: 33.8 })).toBeNull();
  });
  it("names the remedy on a fully paid invoice", () => {
    expect(creditRefusal({ ...inv6, status: "paid", amountPaid: 74.8, alreadyCredited: 0, amount: 1 }))
      .toMatch(/Reverse a payment first/);
  });
  it("refuses a draft, a void and a credit", () => {
    expect(creditRefusal({ ...inv6, status: "draft", alreadyCredited: 0, amount: 1 })).toMatch(/draft/);
    expect(creditRefusal({ ...inv6, status: "void", alreadyCredited: 0, amount: 1 })).toMatch(/void/);
    expect(creditRefusal({ ...inv6, invoiceType: "credit", alreadyCredited: 0, amount: 1 })).toMatch(/credit/);
  });
});

describe("a credit note drives the status like a payment", () => {
  it("part paid when payments and credits leave a balance", () => {
    expect(settledStatus({ status: "issued", total: 74.8, amountPaid: 30, amountCredited: 11 }))
      .toEqual({ status: "part_paid", paid: false });
  });
  it("paid when a credit clears what payments left", () => {
    expect(settledStatus({ status: "part_paid", total: 74.8, amountPaid: 30, amountCredited: 44.8 }))
      .toEqual({ status: "paid", paid: true });
  });
  it("back to issued when the only payment is reversed", () => {
    expect(settledStatus({ status: "paid", total: 74.8, amountPaid: 0, amountCredited: 0 }))
      .toEqual({ status: "issued", paid: false });
  });
  it("keeps overdue while money is owed", () => {
    expect(settledStatus({ status: "overdue", total: 10, amountPaid: 2, amountCredited: 0 }).status).toBe("overdue");
  });
  it("leaves a draft and a void alone", () => {
    expect(settledStatus({ status: "draft", total: 10, amountPaid: 10, amountCredited: 0 }).status).toBe("draft");
    expect(settledStatus({ status: "void", total: 10, amountPaid: 10, amountCredited: 0 }).status).toBe("void");
  });
});

describe("a paid or credited invoice is not voided", () => {
  it("refuses with payments", () => {
    expect(voidRefusal({ status: "paid", paymentCount: 2, amountPaid: 74.8, creditNoteCount: 2 }))
      .toMatch(/Reverse the payments first/);
  });
  it("refuses a MYOB import whose paid-up figure has no payment rows", () => {
    expect(voidRefusal({ status: "part_paid", paymentCount: 0, amountPaid: 5, creditNoteCount: 0 }))
      .toMatch(/Payments/);
  });
  it("refuses with credit notes", () => {
    expect(voidRefusal({ status: "issued", paymentCount: 0, amountPaid: 0, creditNoteCount: 1 }))
      .toMatch(/Void the credit notes first/);
  });
  it("allows a clean invoice", () => {
    expect(voidRefusal({ status: "issued", paymentCount: 0, amountPaid: 0, creditNoteCount: 0 })).toBeNull();
  });
});

describe("reversing a payment", () => {
  it("refuses one already in Xero", () => {
    expect(reversalRefusal({ headerOnly: false, amountPaid: 30, amount: 30, xeroPosted: true }))
      .toMatch(/Xero/);
  });
  it("refuses taking a MYOB header below zero", () => {
    expect(reversalRefusal({ headerOnly: true, amountPaid: 10, amount: 30, xeroPosted: false }))
      .toMatch(/below zero/);
  });
  it("takes the payment back off a header-only paid-up figure", () => {
    expect(unsettleHeaderOnly(250, 100)).toBe(150);
    expect(reversalRefusal({ headerOnly: true, amountPaid: 250, amount: 100, xeroPosted: false })).toBeNull();
  });
});

describe("the invoice profile", () => {
  it("parses what was saved and survives junk", () => {
    expect(parseInvoiceProfile({ invoiceProfile: { addressLines: ["1 Mill Rd", " "], bsb: "062-000" } }))
      .toMatchObject({ addressLines: ["1 Mill Rd"], bsb: "062-000", accountNumber: null });
    expect(parseInvoiceProfile({ invoiceProfile: "nonsense" }).addressLines).toEqual([]);
    expect(parseInvoiceProfile(null).bsb).toBeNull();
  });
  it("normalises an ABN and a BSB", () => {
    expect(normaliseAbn("51 824 753 556")).toBe("51824753556");
    expect(normaliseAbn("123")).toBeNull();
    expect(formatAbn("51824753556")).toBe("51 824 753 556");
    expect(normaliseBsb("062000")).toBe("062-000");
    expect(normaliseBsb("06200")).toBeNull();
  });
  it("prints bank details only when all three are known", () => {
    const full = { ...parseInvoiceProfile(null), bankAccountName: "ATS", bsb: "062-000", accountNumber: "1234" };
    expect(paymentInstructions(full, "INV00006")).toContain("Please quote INV00006 as the payment reference.");
    expect(paymentInstructions({ ...full, bsb: null }, "INV00006")).toEqual([]);
  });
  it("names what a tax invoice is missing", () => {
    expect(invoiceProfileGaps(null, parseInvoiceProfile(null))).toHaveLength(3);
    expect(invoiceProfileGaps(null, parseInvoiceProfile(null))[0]).toMatch(/ABN/);
  });
});

describe("the totals block cannot read as a sum that does not add up", () => {
  it("leads with the GST-inclusive total and states the GST as part of it", () => {
    const rows = invoiceTotalsRows({ total: 74.8, taxAmount: 6.8, amountPaid: 0, amountCredited: 0, balance: 74.8 });
    expect(rows.map((r) => r.label)).toEqual(["Total (inc GST)", "Includes GST of", "Amount ex GST"]);
    expect(rows[2]?.value).toBe(68);
  });
  it("adds paid, credited and balance when there are any", () => {
    const rows = invoiceTotalsRows({ total: 74.8, taxAmount: 6.8, amountPaid: 30, amountCredited: 11, balance: 33.8 });
    expect(rows.slice(3).map((r) => [r.label, r.value])).toEqual([
      ["Paid", 30], ["Credited", 11], ["Balance due", 33.8],
    ]);
  });
});

describe("a job's state on its invoice reads from the invoice", () => {
  it("is not 'On a draft invoice' once the invoice is issued or paid", () => {
    expect(jobStatusOnInvoice("invoice_generated", "issued")).toBe("Invoice issued");
    expect(jobStatusOnInvoice("invoice_generated", "part_paid")).toBe("Part paid");
    expect(jobStatusOnInvoice("invoice_generated", "paid")).toBe("Paid");
    expect(jobStatusOnInvoice("invoice_generated", "draft")).toBe("On a draft invoice");
  });
});

import { chargeSourceLabel } from "@/app/(app)/orders/job-charges";
import { readFileSync } from "node:fs";

describe("a charge says where its price came from", () => {
  it("labels by source, not 'Added by hand' for everything off the price list", () => {
    expect(chargeSourceLabel({ source_agreement_line_id: "x", pricing_model: "per_item" })).toBe("From the rate card");
    expect(chargeSourceLabel({ source_agreement_line_id: null, pricing_model: "per_item" })).toBe("From the price list");
    expect(chargeSourceLabel({ source_agreement_line_id: null, pricing_model: null })).toBe("Added by hand");
  });
  it("the pricer writes no provenance into the customer-facing description", () => {
    const source = readFileSync(new URL("../job-pricing.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\(price list\)`/);
  });
});
