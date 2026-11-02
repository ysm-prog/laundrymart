import {
  agingBucket, isUnreconciledImport, type AgingBucket,
} from "./receivables";

/**
 * A customer's statement: what they still owe, invoice by invoice, aged.
 *
 * Pure, so the PDF, the email, the customer's card and the bulk list all read one
 * answer. An "outstanding" statement rather than an activity one: it lists every
 * open invoice with what has been paid and credited against it, which is what an
 * accounts team reconciles a statement against.
 *
 * **Imported history is left off, and says so.** `isUnreconciledImport` is the same
 * rule Today uses (brief 1.9): an invoice imported from MYOB before the trusted day
 * carries a balance whose payments were recorded in MYOB and never came across, so
 * printing it would ask a customer for money they have probably paid. What is left
 * off is counted in `excluded`, because a staff member sending this has to know the
 * figure is not the customer's whole history, and the PDF says the same to the
 * customer.
 */

/** The statuses a customer still owes on. A draft has not been sent; paid and void are finished. */
export const OPEN_INVOICE_STATUSES = ["issued", "part_paid", "overdue"] as const;

export type StatementInvoice = {
  id: string;
  invoice_number: string;
  invoice_type: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  purchase_order_number: string | null;
  total: number;
  amount_paid: number;
  amount_credited: number | null;
  balance: number;
  source?: string | null;
};

export type StatementRow = {
  id: string;
  invoiceNumber: string;
  issueDate: string | null;
  dueDate: string | null;
  reference: string | null;
  total: number;
  paid: number;
  credited: number;
  balance: number;
  bucket: AgingBucket;
};

export type Statement = {
  asAt: string;
  trustedFrom: string;
  rows: StatementRow[];
  buckets: Record<AgingBucket, number>;
  /** What the customer owes on this statement, credits taken off. */
  total: number;
  /** The part of it past its due date. */
  overdue: number;
  /** Open imported invoices left off, and what they add up to. */
  excluded: { count: number; amount: number };
};

const r2 = (n: number) => Math.round(n * 100) / 100;

const isOpen = (invoice: StatementInvoice) =>
  (OPEN_INVOICE_STATUSES as readonly string[]).includes(invoice.status)
  && Math.abs(Number(invoice.balance)) > 0.005;

export function buildStatement(
  invoices: StatementInvoice[], options: { asAt: string; trustedFrom: string },
): Statement {
  const { asAt, trustedFrom } = options;
  const open = invoices.filter(isOpen);
  const old = open.filter((invoice) => isUnreconciledImport(invoice, trustedFrom));
  const kept = open.filter((invoice) => !isUnreconciledImport(invoice, trustedFrom));

  const rows: StatementRow[] = kept
    .map((invoice) => {
      const balance = Number(invoice.balance);
      return {
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
        issueDate: invoice.issue_date,
        dueDate: invoice.due_date,
        reference: invoice.purchase_order_number,
        total: Number(invoice.total),
        paid: Number(invoice.amount_paid),
        credited: Number(invoice.amount_credited ?? 0),
        balance,
        // A credit in the customer's favour is not "overdue", however old it is.
        bucket: balance < 0 ? "current" as const : agingBucket(invoice.due_date, asAt),
      };
    })
    .sort((a, b) =>
      (a.issueDate ?? "").localeCompare(b.issueDate ?? "")
      || a.invoiceNumber.localeCompare(b.invoiceNumber));

  const buckets: Record<AgingBucket, number> = {
    current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0,
  };
  for (const row of rows) buckets[row.bucket] = r2(buckets[row.bucket] + row.balance);

  return {
    asAt,
    trustedFrom,
    rows,
    buckets,
    total: r2(rows.reduce((sum, row) => sum + row.balance, 0)),
    overdue: r2(rows.filter((row) => row.bucket !== "current")
      .reduce((sum, row) => sum + row.balance, 0)),
    excluded: {
      count: old.length,
      amount: r2(old.reduce((sum, invoice) => sum + Number(invoice.balance), 0)),
    },
  };
}

/** Whether there is anything to put in front of a customer. */
export function statementHasContent(statement: Statement): boolean {
  return statement.rows.length > 0;
}
