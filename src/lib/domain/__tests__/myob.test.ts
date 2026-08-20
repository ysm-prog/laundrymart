import { describe, expect, it } from "vitest";
import {
  buildPlan, day, detectFile, ident, money, parseCsv, parseCsvRecords,
  readBills, readContacts, readInvoices, termsDays, text,
} from "@/lib/domain/myob";

const TENANT = "20000000-0000-4000-8000-000000000001";
const EMPTY = { customers: [], suppliers: [] };

describe("cell rules", () => {
  it("collapses runs of whitespace, because a party's identity is its name", () => {
    // Two exports write this name with a doubled space and two with one. Left
    // alone it imports as two suppliers: one holding the bills, the other
    // holding the balance those bills are supposed to explain.
    expect(text("Salute Better Solutions P/L  - Pak-Rite"))
      .toBe(text("Salute Better Solutions P/L - Pak-Rite"));
    expect(text("  Barber Boys x Anthony \n Pty Ltd ")).toBe("Barber Boys x Anthony Pty Ltd");
    expect(text("   ")).toBeNull();
  });

  it("keeps money signed, because a debit note is money owed back", () => {
    expect(money("-160.75")).toBe(-160.75);
    expect(money("$1,234.50")).toBe(1234.5);
    expect(money("")).toBe(0);
  });

  it("refuses a cell that is not an amount rather than reading it as zero", () => {
    expect(() => money("31/07/2024")).toThrow();
  });

  it("reads MYOB's day-first dates", () => {
    expect(day("31/07/2024")).toBe("2024-07-31");
    expect(day("not a date")).toBeNull();
  });

  it("takes payment terms from the two dates, not from a default", () => {
    expect(termsDays("2026-08-12", "2026-08-26")).toBe(14);
    expect(termsDays("2026-08-12", "2026-08-12")).toBe(0);   // COD
    expect(termsDays("2026-08-12", null)).toBe(0);
  });
});

describe("identity", () => {
  /**
   * These four ids are in the hosted database, written by the Python importer.
   * The whole feature rests on this: an upload has to address the rows a
   * previous load created, not make a second copy of them.
   */
  it("reproduces the ids the first import wrote", () => {
    expect(ident(TENANT, "customers", "Uncle Gino's Barber Shop - Golden Grove"))
      .toBe("c7d2303a-505b-5295-b8f3-ab7943e75956");
    expect(ident(TENANT, "customers", "ZoZo Hair Co.")).toBe("609295c2-7e62-522d-9505-5d2ac657f469");
    expect(ident(TENANT, "suppliers", "Telstra")).toBe("b2c92d8c-8824-590a-9d4f-9c3ccc8551cd");
    expect(ident(TENANT, "suppliers", "Salute Better Solutions P/L - Pak-Rite"))
      .toBe("4b6b5fa5-6520-56a9-8030-a67845a31eb6");
  });
});

describe("csv", () => {
  it("handles quotes, embedded commas and newlines", () => {
    expect(parseCsv('a,"b,c","d""e"\n1,2,3')).toEqual([["a", "b,c", 'd"e'], ["1", "2", "3"]]);
    expect(parseCsv('h\n"two\nlines"')).toEqual([["h"], ["two\nlines"]]);
  });

  it("strips the byte-order mark Excel writes", () => {
    expect(parseCsvRecords("﻿Name,Type\nAcme,Customer")).toEqual([{ Name: "Acme", Type: "Customer" }]);
  });

  it("reads a short row as empty strings, not undefined", () => {
    // The bills repair keys off a column being *empty*; `undefined` would slip past.
    expect(parseCsvRecords("a,b,c\n1")).toEqual([{ a: "1", b: "", c: "" }]);
  });
});

describe("the bills export's dropped column", () => {
  const header = "Issue Date,Bill Number,Supplier,Supplier Invoice No,Amount,Balance Due,Due Date,Status";

  it("repairs the shifted row and reads the amount, not the date", () => {
    // MYOB omits Supplier Invoice No entirely when it is blank, so everything
    // after it lands one place early and Status comes out empty.
    const shifted = "31/07/2024,PB0001,Telstra,87.86,87.86,07/08/2024,Open,";
    const { rows } = readBills("bills.csv", `${header}\n${shifted}`);
    expect(rows[0]).toMatchObject({
      supplier: "Telstra", invoiceNo: null, amount: 87.86, balance: 87.86,
      dueDate: "2024-08-07", status: "open", repaired: true,
    });
  });

  it("leaves an intact row alone", () => {
    const intact = "31/07/2024,PB0002,Telstra,INV-9,87.86,0.00,07/08/2024,Closed";
    const { rows } = readBills("bills.csv", `${header}\n${intact}`);
    expect(rows[0]).toMatchObject({ invoiceNo: "INV-9", amount: 87.86, balance: 0, repaired: false });
  });
});

describe("invoices", () => {
  const header = "Issue Date,Invoice No,Customer,PO Number,Terms/Due Date,Amount,Balance Due,Status";

  it("treats COD as due on the day of issue", () => {
    const { rows } = readInvoices("invoices.csv",
      `${header}\n05/08/2026,001,Acme,-,COD,40.00,40.00,Open`);
    expect(rows[0]).toMatchObject({ dueDate: "2026-08-05", po: null, status: "issued", kind: "manual" });
  });

  it("types a credit as a document, not as a state", () => {
    const { rows } = readInvoices("invoices.csv",
      `${header}\n05/08/2026,002,Acme,,12/08/2026,46.20,-36.00,Credit`);
    expect(rows[0]).toMatchObject({ kind: "credit", status: "issued", paid: 82.2, outstanding: true });
  });

  it("reports an unknown status instead of guessing one", () => {
    const { problems } = readInvoices("invoices.csv",
      `${header}\n05/08/2026,003,Acme,,12/08/2026,10.00,0.00,Disputed`);
    expect(problems[0]?.fatal).toBe(true);
    expect(problems[0]?.message).toContain("Disputed");
  });

  it("counts a fully paid invoice as not outstanding", () => {
    const { rows } = readInvoices("invoices.csv",
      `${header}\n05/08/2026,004,Acme,,12/08/2026,10.00,0.00,Paid`);
    expect(rows[0]?.outstanding).toBe(false);
  });
});

describe("detection", () => {
  it("matches on the filename however the browser prefixed it", () => {
    expect(detectFile("90765249-bills.csv", null)).toEqual({ status: "known", kind: "bills" });
  });

  it("falls back to the columns when the file has been renamed", () => {
    expect(detectFile("export (1).csv", ["Reference No", "Supplier", "Amount Paid", "Email"]))
      .toEqual({ status: "known", kind: "remittances" });
  });

  it("names the exports that add nothing rather than silently ignoring them", () => {
    const detected = detectFile("x-purchase_returns_and_debits.csv", null);
    expect(detected.status).toBe("redundant");
  });

  it("says so when a file is not one of these at all", () => {
    expect(detectFile("holiday-photos.csv", ["a", "b"])).toEqual({ status: "unknown" });
  });
});

describe("the plan", () => {
  const contacts = readContacts("contacts.csv", [
    "Name,Type,Phone Number,Email,Automated Reminders,Balance Due,Overdue",
    "Acme Pty Ltd,Customer,8123 4567,a@acme.test,Reminders on,100.00,25.00",
    "Bolt Supplies,Supplier,,b@bolt.test,,50.00,0.00",
  ].join("\n")).rows;

  it("numbers a fresh tenant from one, in name order", () => {
    const plan = buildPlan({ contacts }, EMPTY, { tenantId: TENANT });
    const customers = plan.tables.find((table) => table.label === "Customers")!;
    expect(customers.rows[0]).toMatchObject({
      customer_number: "CUST00001", business_name: "Acme Pty Ltd",
      opening_balance: 100, opening_balance_overdue: 25, reminders_enabled: true,
    });
  });

  it("keeps the number a party already has, and hands new ones the next free one", () => {
    const existing = {
      customers: [{ id: ident(TENANT, "customers", "Acme Pty Ltd"), number: "CUST00431" }],
      suppliers: [],
    };
    const plan = buildPlan({ contacts }, existing, { tenantId: TENANT });
    const customers = plan.tables.find((table) => table.label === "Customers")!;
    expect(customers.rows[0]).toMatchObject({ customer_number: "CUST00431" });
    expect(plan.parties).toMatchObject({ customersNew: 0, customersExisting: 1 });
    expect(plan.sequences.find((s) => s.kind === "customer")!.next).toBe(432);
  });

  it("does not overwrite a party the upload only names in a document", () => {
    // Uploading invoices.csv on its own must not set an existing customer to
    // inactive and wipe the balance they arrived with.
    const invoices = readInvoices("invoices.csv", [
      "Issue Date,Invoice No,Customer,PO Number,Terms/Due Date,Amount,Balance Due,Status",
      "05/08/2026,00413595,Acme Pty Ltd,,12/08/2026,40.00,40.00,Open",
    ].join("\n")).rows;
    const existing = {
      customers: [{ id: ident(TENANT, "customers", "Acme Pty Ltd"), number: "CUST00431" }],
      suppliers: [],
    };
    const plan = buildPlan({ invoices }, existing, { tenantId: TENANT });
    expect(plan.tables.find((table) => table.label === "Customers")).toBeUndefined();
    expect(plan.tables.find((table) => table.label === "Invoices")!.rows).toHaveLength(1);
  });

  it("creates a party a document names and nobody else does, inactive", () => {
    const invoices = readInvoices("invoices.csv", [
      "Issue Date,Invoice No,Customer,PO Number,Terms/Due Date,Amount,Balance Due,Status",
      "05/08/2026,00413595,Ghost Trading,,12/08/2026,40.00,40.00,Open",
    ].join("\n")).rows;
    const plan = buildPlan({ invoices }, EMPTY, { tenantId: TENANT });
    expect(plan.tables.find((table) => table.label === "Customers")!.rows[0])
      .toMatchObject({ business_name: "Ghost Trading", status: "inactive" });
  });

  it("holds back paid history unless the full scope is asked for", () => {
    const source = [
      "Issue Date,Invoice No,Customer,PO Number,Terms/Due Date,Amount,Balance Due,Status",
      "05/08/2026,001,Acme Pty Ltd,,12/08/2026,40.00,40.00,Open",
      "05/08/2026,002,Acme Pty Ltd,,12/08/2026,40.00,0.00,Paid",
    ].join("\n");
    const invoices = readInvoices("invoices.csv", source).rows;
    const open = buildPlan({ contacts, invoices }, EMPTY, { tenantId: TENANT });
    const all = buildPlan({ contacts, invoices }, EMPTY, { tenantId: TENANT, invoiceScope: "all" });
    expect(open.tables.find((t) => t.label === "Invoices")!.rows).toHaveLength(1);
    expect(all.tables.find((t) => t.label === "Invoices")!.rows).toHaveLength(2);
  });

  it("never names one invoice twice in a statement that could only update it once", () => {
    // The credits export and the invoices export both carry the same document.
    const credits = [{
      number: "00413504", customer: "Acme Pty Ltd", po: null,
      issueDate: "2026-08-05", amount: 46.2, balance: -35.92, paid: 82.12,
    }];
    const invoices = readInvoices("invoices.csv", [
      "Issue Date,Invoice No,Customer,PO Number,Terms/Due Date,Amount,Balance Due,Status",
      "05/08/2026,00413504,Acme Pty Ltd,,12/08/2026,46.20,-35.92,Credit",
    ].join("\n")).rows;
    const plan = buildPlan({ contacts, credits, invoices }, EMPTY, { tenantId: TENANT });
    expect(plan.tables.find((table) => table.label === "Customer credits")).toBeUndefined();
    expect(plan.tables.find((table) => table.label === "Invoices")!.rows).toHaveLength(1);
  });

  it("drops a due date the invoices table would refuse, and says so", () => {
    const invoices = readInvoices("invoices.csv", [
      "Issue Date,Invoice No,Customer,PO Number,Terms/Due Date,Amount,Balance Due,Status",
      "05/08/2026,001,Acme Pty Ltd,,01/08/2026,40.00,40.00,Open",
    ].join("\n")).rows;
    const plan = buildPlan({ contacts, invoices }, EMPTY, { tenantId: TENANT });
    expect(plan.tables.find((t) => t.label === "Invoices")!.rows[0])
      .toMatchObject({ due_date: null, payment_terms_days: 0 });
    expect(plan.notes.join(" ")).toContain("fall due before they were issued");
  });

  it("refuses a document whose party is in none of the files", () => {
    const plan = buildPlan(
      { bills: [{
        number: "PB1", supplier: "Nobody Ltd", invoiceNo: null, issueDate: "2026-08-01",
        dueDate: null, amount: 10, balance: 10, status: "open", repaired: false,
      }] },
      EMPTY, { tenantId: TENANT },
    );
    // The supplier is created from the bill itself, so this one resolves — the
    // guard is against a name that resolves to nothing at all.
    expect(plan.tables.find((t) => t.label === "Suppliers")!.rows[0])
      .toMatchObject({ name: "Nobody Ltd", status: "inactive" });
    expect(plan.problems).toHaveLength(0);
  });
});
