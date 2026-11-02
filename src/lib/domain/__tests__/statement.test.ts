import { describe, expect, it } from "vitest";
import { buildStatement, statementHasContent, type StatementInvoice } from "../statement";

const invoice = (over: Partial<StatementInvoice>): StatementInvoice => ({
  id: over.invoice_number ?? "x", invoice_number: "00415360", invoice_type: "consolidated",
  status: "issued", issue_date: "2026-10-20", due_date: "2026-11-03", purchase_order_number: null,
  total: 100, amount_paid: 0, amount_credited: 0, balance: 100, source: "app", ...over,
});
const options = { asAt: "2026-11-02", trustedFrom: "2026-10-01" };

describe("buildStatement", () => {
  it("lists what is open, oldest first, and totals it", () => {
    const statement = buildStatement([
      invoice({ invoice_number: "B", issue_date: "2026-10-20", balance: 60, amount_paid: 40 }),
      invoice({ invoice_number: "A", issue_date: "2026-10-05", balance: 20 }),
    ], options);
    expect(statement.rows.map((row) => row.invoiceNumber)).toEqual(["A", "B"]);
    expect(statement.rows[1]).toMatchObject({ total: 100, paid: 40, balance: 60 });
    expect(statement.total).toBe(80);
  });

  it("leaves off drafts, paid and void invoices, and anything with no balance", () => {
    const statement = buildStatement([
      invoice({ invoice_number: "draft", status: "draft" }),
      invoice({ invoice_number: "paid", status: "paid", balance: 0 }),
      invoice({ invoice_number: "void", status: "void" }),
      invoice({ invoice_number: "settled", balance: 0 }),
    ], options);
    expect(statement.rows).toEqual([]);
    expect(statementHasContent(statement)).toBe(false);
  });

  it("ages each balance and adds up the overdue part", () => {
    const statement = buildStatement([
      invoice({ invoice_number: "current", due_date: "2026-11-10", balance: 10 }),
      invoice({ invoice_number: "thirty", due_date: "2026-10-20", balance: 20 }),
      invoice({ invoice_number: "sixty", due_date: "2026-09-20", balance: 30, issue_date: "2026-10-02" }),
    ], options);
    expect(statement.buckets).toEqual({ current: 10, "1-30": 20, "31-60": 30, "61-90": 0, "90+": 0 });
    expect(statement.overdue).toBe(50);
  });

  it("takes a credit off the total and never calls it overdue", () => {
    const statement = buildStatement([
      invoice({ invoice_number: "owed", balance: 100 }),
      invoice({ invoice_number: "credit", balance: -30, due_date: "2026-01-01" }),
    ], options);
    expect(statement.total).toBe(70);
    expect(statement.overdue).toBe(0);
    expect(statement.buckets.current).toBe(70);
  });

  it("keeps unreconciled MYOB history off the statement and counts what it left off", () => {
    const statement = buildStatement([
      invoice({ invoice_number: "old1", source: "import", issue_date: "2019-03-01", balance: 120.5 }),
      invoice({ invoice_number: "old2", source: "import", issue_date: "2026-09-30", balance: 9.5 }),
      invoice({ invoice_number: "new", source: "import", issue_date: "2026-10-01", balance: 40 }),
      invoice({ invoice_number: "app", source: "app", issue_date: "2026-09-01", balance: 15 }),
    ], options);
    expect(statement.rows.map((row) => row.invoiceNumber)).toEqual(["app", "new"]);
    expect(statement.total).toBe(55);
    expect(statement.excluded).toEqual({ count: 2, amount: 130 });
  });
});
