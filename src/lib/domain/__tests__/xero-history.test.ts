import { describe, expect, it } from "vitest";
import {
  classifyXeroInvoice, historyLine, historyRow, invoicesToSettle, looseName, normaliseName,
  openingBaseNumber, openingRow, similarCustomer, taxCodeFor, xeroDay, type HistoryLookups, type XeroInvoice,
} from "../xero-history";
import { isHeaderOnly } from "../payment-gate";

const lookups: HistoryLookups = {
  customerByContact: new Map([["contact-1", "customer-1"]]),
  customerByName: new Map([["sloth cafe", "customer-2"]]),
  customers: [],
  itemByCode: new Map([["gc", "item-1"]]),
  accountByCode: new Map([["4-6000", "account-1"]]),
};

const draft: XeroInvoice = {
  Type: "ACCREC", InvoiceID: "x-1", InvoiceNumber: "00414447", Reference: "MYOB 00414447", Status: "DRAFT",
  Contact: { ContactID: "contact-1", Name: "Sloth Cafe" },
  DateString: "2026-09-25T00:00:00", DueDateString: "2026-10-02T00:00:00", LineAmountTypes: "Exclusive",
  TotalTax: 4.4, Total: 48.4,
  LineItems: [
    { Description: "Glass Cloths", Quantity: 60, ItemCode: "GC", TaxType: "OUTPUT", TaxAmount: 4.2, LineAmount: 42 },
    { Description: "Temporary Fuel Surcharge", Quantity: 1, ItemCode: "TFSC", AccountCode: "4-6000", TaxType: "OUTPUT", TaxAmount: 0.2, LineAmount: 2 },
  ],
};
const opening: XeroInvoice = {
  Type: "ACCREC", InvoiceID: "x-2", InvoiceNumber: "00318792-OB", Reference: "MYOB 00318792", Status: "AUTHORISED",
  Contact: { Name: "SLOTH  cafe" }, DateString: "2011-05-07T00:00:00", DueDateString: "2011-05-14T00:00:00",
  Total: 0.5, AmountDue: 0.5,
};

describe("telling Xero's invoices apart", () => {
  it("knows a MYOB draft by its number and reference", () => {
    expect(classifyXeroInvoice(draft)).toBe("history");
  });
  it("knows an opening balance, paid or not", () => {
    expect(classifyXeroInvoice(opening)).toBe("opening");
    expect(classifyXeroInvoice({ ...opening, Status: "PAID" })).toBe("opening");
  });
  it("leaves alone what is not MYOB history", () => {
    expect(classifyXeroInvoice({ ...draft, InvoiceNumber: "INV-00415360", Reference: "", Status: "AUTHORISED" })).toBe("other");
    expect(classifyXeroInvoice({ ...draft, Reference: "Somebody's order" })).toBe("other");
    expect(classifyXeroInvoice({ ...draft, Status: "AUTHORISED" })).toBe("other");
    expect(classifyXeroInvoice({ ...opening, Status: "VOIDED" })).toBe("other");
    expect(classifyXeroInvoice({ ...draft, Type: "ACCPAY" })).toBe("other");
  });
  it("reads the invoice an opening balance belongs to", () => {
    expect(openingBaseNumber("00318792-OB")).toBe("00318792");
    expect(openingBaseNumber("00318792")).toBeNull();
    expect(openingBaseNumber(null)).toBeNull();
  });
});

describe("a line, on this app's basis", () => {
  it("puts the GST inside the amount, which Xero's draft holds outside it", () => {
    const line = historyLine(draft.LineItems![0]!, 0, "Exclusive", lookups);
    expect(line).toMatchObject({
      sequence: 1, description: "Glass Cloths", quantity: 60, amount: 46.2, unit_price: 0.77,
      tax_code: "GST", item_id: "item-1", gl_account_id: null,
    });
  });
  it("adds nothing to an amount that already includes it", () => {
    expect(historyLine({ Quantity: 1, TaxAmount: 1, LineAmount: 11 }, 0, "Inclusive", lookups).amount).toBe(11);
  });
  it("carries the account by its Xero code", () => {
    expect(historyLine(draft.LineItems![1]!, 1, "Exclusive", lookups).gl_account_id).toBe("account-1");
  });
  it("adds up to what Xero says the invoice was", () => {
    const row = historyRow(draft, lookups)!;
    expect(row.lines.reduce((sum, line) => sum + line.amount, 0)).toBeCloseTo(row.total, 2);
  });
  it("never leaves a line without a description, which the column refuses", () => {
    expect(historyLine({ ItemCode: "GC", Quantity: 1, LineAmount: 1 }, 0, "Exclusive", lookups).description).toBe("GC");
    expect(historyLine({ Quantity: 1, LineAmount: 1 }, 0, "Exclusive", lookups).description).toBe("Item");
  });
  it("survives a line with no quantity to divide by", () => {
    expect(historyLine({ Quantity: 0, LineAmount: 5 }, 0, "Inclusive", lookups).unit_price).toBe(5);
  });
  it("maps Xero's tax types to the three codes a line carries", () => {
    expect(taxCodeFor({ TaxType: "OUTPUT" })).toBe("GST");
    expect(taxCodeFor({ TaxType: "EXEMPTOUTPUT" })).toBe("FRE");
    expect(taxCodeFor({ TaxType: "BASEXCLUDED" })).toBe("N-T");
    expect(taxCodeFor({ TaxAmount: 2 })).toBe("GST");
    expect(taxCodeFor({})).toBe("FRE");
  });
});

describe("the rows the database takes", () => {
  it("finds the customer by Xero's contact, then by name", () => {
    expect(historyRow(draft, lookups)?.customer_id).toBe("customer-1");
    expect(openingRow(opening, lookups)?.customer_id).toBe("customer-2");
    expect(historyRow({ ...draft, Contact: { Name: "Nobody" } }, lookups)?.customer_id).toBeNull();
  });
  it("drops a due date before the issue date, which the table refuses", () => {
    expect(historyRow({ ...draft, DueDateString: "2026-09-01T00:00:00" }, lookups)?.due_date).toBeNull();
  });
  it("will not file an invoice with no date", () => {
    expect(historyRow({ ...draft, DateString: null }, lookups)).toBeNull();
    expect(xeroDay("nonsense")).toBeNull();
  });
  it("reads what is owed from an opening balance, and nothing from a paid one", () => {
    expect(openingRow(opening, lookups)).toMatchObject({ number: "00318792", due: 0.5, xero_invoice_id: "x-2" });
    expect(openingRow({ ...opening, Status: "PAID", AmountDue: 0 }, lookups)?.due).toBe(0);
  });
  it("compares names the way the MYOB importer does", () => {
    expect(normaliseName("  Barber  Boys x Anthony ")).toBe("barber boys x anthony");
  });
});

describe("a customer whose name is only similar", () => {
  const customers = [
    { id: "a", name: "Prohaul Logistic Services P/L T/As Salty Coconut" },
    { id: "b", name: "Soonta - Port Adelaide Plaza" },
    { id: "c", name: "Fandi Scissor Hands - Elizabeth" },
    { id: "d", name: "Fandi Scissor Hands - Kilburn" },
    { id: "e", name: "Crown Barbers Pty Ltd" },
    { id: "f", name: "Hair Co" },
  ];
  it("finds a trading name inside the legal one", () => {
    expect(similarCustomer("Salty Coconut", customers)?.id).toBe("a");
  });
  it("finds the app's name inside Xero's", () => {
    expect(similarCustomer("Long Rain Pty Ltd Soonta - Port Adelaide Plaza", customers)?.id).toBe("b");
  });
  it("ignores punctuation and a company ending", () => {
    expect(similarCustomer("Crown Barbers", customers)?.id).toBe("e");
    expect(looseName("Crown Barbers Pty Ltd")).toBe(" crown barbers ");
  });
  it("will not guess between two candidates", () => {
    expect(similarCustomer("Fandi Scissor Hands", customers)).toBeNull();
    expect(similarCustomer("Fandi Scissor Hands - Newton", customers)).toBeNull();
  });
  it("matches whole words only", () => {
    expect(similarCustomer("Own Barbers Pty", [{ id: "x", name: "Crown Barbers Pty Ltd" }])).toBeNull();
  });
  it("leaves a short name alone, which is too easily found in somebody else's", () => {
    expect(similarCustomer("Hair Co", customers)).toBeNull();
    expect(similarCustomer("The Hair Co Norwood", customers)).toBeNull();
    expect(similarCustomer(null, customers)).toBeNull();
  });
});

describe("invoicesToSettle", () => {
  it("settles a draft with no opening balance, keeps one with, and flags one in neither", () => {
    expect(invoicesToSettle({
      openInApp: ["A", "B", "C"], drafts: ["A", "B"], openings: ["B"],
    })).toEqual({ settle: ["A"], unknown: ["C"] });
  });
});

describe("isHeaderOnly", () => {
  it("treats an import as header only even once it has lines", () => {
    expect(isHeaderOnly({ source: "import", lineCount: 3 })).toBe(true);
    expect(isHeaderOnly({ source: "import", lineCount: 0 })).toBe(true);
  });
  it("recalculates an app invoice with lines, and not one without", () => {
    expect(isHeaderOnly({ source: "app", lineCount: 3 })).toBe(false);
    expect(isHeaderOnly({ source: "app", lineCount: 0 })).toBe(true);
    expect(isHeaderOnly({ lineCount: null })).toBe(true);
  });
});
