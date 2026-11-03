import { describe, expect, it } from "vitest";
import {
  buildStatement, countWithoutEmail, monthlyStatementDue, monthlyStatementSkip,
  parseStatementDate, parseStatementSort, statementListView, summariseStatementSends,
  type StatementInvoice, type StatementListRow,
} from "../statement";

const invoice = (over: Partial<StatementInvoice>): StatementInvoice => ({
  id: over.invoice_number ?? "x", invoice_number: "00415360", invoice_type: "consolidated",
  status: "issued", issue_date: "2026-10-20", due_date: "2026-11-03", purchase_order_number: null,
  total: 100, amount_paid: 0, amount_credited: 0, balance: 100, source: "app", ...over,
});

describe("the statement date", () => {
  const options = { asAt: "2026-10-31", trustedFrom: "2026-10-01" };

  it("leaves off invoices issued after it, and counts them", () => {
    const statement = buildStatement([
      invoice({ invoice_number: "Oct", issue_date: "2026-10-31", balance: 40 }),
      invoice({ invoice_number: "Nov", issue_date: "2026-11-01", balance: 25 }),
    ], options);
    expect(statement.rows.map((row) => row.invoiceNumber)).toEqual(["Oct"]);
    expect(statement.total).toBe(40);
    expect(statement.later).toEqual({ count: 1, amount: 25 });
  });

  it("keeps them when asked to include everything open", () => {
    const statement = buildStatement([
      invoice({ invoice_number: "Nov", issue_date: "2026-11-01", balance: 25 }),
    ], { ...options, upToAsAt: false });
    expect(statement.rows).toHaveLength(1);
    expect(statement.later).toEqual({ count: 0, amount: 0 });
  });

  it("keeps an invoice with no issue date, which cannot be placed after anything", () => {
    const statement = buildStatement([invoice({ issue_date: null, balance: 5 })], options);
    expect(statement.rows).toHaveLength(1);
  });

  it("does not count an unreconciled import as later as well as excluded", () => {
    const statement = buildStatement([
      invoice({ source: "import", issue_date: "2011-04-01", balance: 9 }),
    ], { asAt: "2010-01-01", trustedFrom: "2026-10-01" });
    expect(statement.excluded.count).toBe(1);
    expect(statement.later.count).toBe(0);
  });
});

describe("parseStatementDate", () => {
  const today = "2026-11-03";
  it("takes a real past date", () => expect(parseStatementDate("2026-10-31", today)).toBe("2026-10-31"));
  it("caps a future date at today", () => expect(parseStatementDate("2026-12-01", today)).toBe(today));
  it("falls back on junk and on impossible dates", () => {
    expect(parseStatementDate("", today)).toBe(today);
    expect(parseStatementDate(undefined, today)).toBe(today);
    expect(parseStatementDate("31/10/2026", today)).toBe(today);
    expect(parseStatementDate("2026-02-30", today)).toBe(today);
  });
});

describe("parseStatementSort", () => {
  it("knows three orders and defaults to the largest balance", () => {
    expect(parseStatementSort("name")).toBe("name");
    expect(parseStatementSort("overdue")).toBe("overdue");
    expect(parseStatementSort("drop table")).toBe("balance");
    expect(parseStatementSort(undefined)).toBe("balance");
  });
});

const row = (over: Partial<StatementListRow>): StatementListRow => ({
  customerId: over.name ?? "c", name: "Acme", customerNumber: "CUST00001", contactName: null,
  phone: null, billingEmail: "acme@example.com", total: 10, overdue: 0, invoices: 1, ...over,
});

describe("statementListView", () => {
  const rows = [
    row({ name: "Bravo", total: 50, overdue: 0 }),
    row({ name: "Alpha", total: 50, overdue: 20, contactName: "Jill La Pira" }),
    row({ name: "Charlie", total: 90, overdue: 5, customerNumber: "CUST00099" }),
    row({ name: "Empty", total: 0, invoices: 0 }),
  ];

  it("lists only customers with something on their statement, largest first, name breaking ties", () => {
    expect(statementListView(rows, {}).map((r) => r.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("sorts by name or by what is overdue", () => {
    expect(statementListView(rows, { sort: "name" }).map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(statementListView(rows, { sort: "overdue" }).map((r) => r.name)).toEqual(["Alpha", "Charlie", "Bravo"]);
  });

  it("searches the name, number, contact and email, ignoring case", () => {
    expect(statementListView(rows, { q: "la pira" }).map((r) => r.name)).toEqual(["Alpha"]);
    expect(statementListView(rows, { q: "cust00099" }).map((r) => r.name)).toEqual(["Charlie"]);
    expect(statementListView(rows, { q: "  " })).toHaveLength(3);
  });
});

describe("summariseStatementSends", () => {
  it("counts skips apart from failures and names the first failure", () => {
    const result = summariseStatementSends([
      { kind: "sent", customer: "A" },
      { kind: "sent", customer: "B" },
      { kind: "skipped", customer: "C", reason: "no_email" },
      { kind: "skipped", customer: "D", reason: "nothing_owed" },
      { kind: "failed", customer: "E", reason: "the address bounced" },
    ]);
    expect(result).toEqual({
      ok: true,
      message: "Sent 2 statements. 1 owed nothing. 1 had no billing email. 1 could not be sent. E: the address bounced.",
    });
  });

  it("is a failure when nothing went, even if every one was only skipped", () => {
    const result = summariseStatementSends([{ kind: "skipped", customer: "C", reason: "no_email" }]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Sent 0 statements. 1 had no billing email.");
  });

  it("speaks of one statement in the singular", () => {
    expect(summariseStatementSends([{ kind: "sent", customer: "A" }]).message).toBe("Sent 1 statement.");
  });
});

describe("countWithoutEmail", () => {
  it("counts a blank address as none", () => {
    expect(countWithoutEmail([{ billingEmail: null }, { billingEmail: "  " }, { billingEmail: "a@b.c" }])).toBe(2);
  });
});

describe("monthlyStatementDue", () => {
  it("is due on the first three days, dated the last day of the month before", () => {
    expect(monthlyStatementDue("2026-11-01")).toEqual({ period: "2026-10", asAt: "2026-10-31" });
    expect(monthlyStatementDue("2026-11-03")).toEqual({ period: "2026-10", asAt: "2026-10-31" });
    expect(monthlyStatementDue("2026-03-02")).toEqual({ period: "2026-02", asAt: "2026-02-28" });
    expect(monthlyStatementDue("2028-03-01")).toEqual({ period: "2028-02", asAt: "2028-02-29" });
  });

  it("crosses a year boundary", () => {
    expect(monthlyStatementDue("2027-01-01")).toEqual({ period: "2026-12", asAt: "2026-12-31" });
  });

  it("is not due later in the month, so turning it on mid-month sends nothing that day", () => {
    expect(monthlyStatementDue("2026-11-04")).toBeNull();
    expect(monthlyStatementDue("2026-11-18")).toBeNull();
    expect(monthlyStatementDue("nonsense")).toBeNull();
  });
});

describe("monthlyStatementSkip", () => {
  const base = { hasContent: true, billingEmail: "a@b.c", remindersEnabled: true, alreadySent: false };
  it("sends to somebody who owes, has an email and has not been sent this month", () => {
    expect(monthlyStatementSkip(base)).toBeNull();
    expect(monthlyStatementSkip({ ...base, remindersEnabled: null })).toBeNull();
  });
  it("says why it does not", () => {
    expect(monthlyStatementSkip({ ...base, alreadySent: true })).toBe("already_sent");
    expect(monthlyStatementSkip({ ...base, hasContent: false })).toBe("nothing_owed");
    expect(monthlyStatementSkip({ ...base, remindersEnabled: false })).toBe("opted_out");
    expect(monthlyStatementSkip({ ...base, billingEmail: " " })).toBe("no_email");
  });
});
