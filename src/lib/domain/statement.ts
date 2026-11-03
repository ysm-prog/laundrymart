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
  /**
   * Open invoices issued after the statement date, left off because the
   * statement only covers invoices up to its date (ysm-hub's "only include
   * invoices up to statement date", on by default). Zero when that is turned off.
   */
  later: { count: number; amount: number };
};

const r2 = (n: number) => Math.round(n * 100) / 100;

const isOpen = (invoice: StatementInvoice) =>
  (OPEN_INVOICE_STATUSES as readonly string[]).includes(invoice.status)
  && Math.abs(Number(invoice.balance)) > 0.005;

export function buildStatement(
  invoices: StatementInvoice[],
  options: { asAt: string; trustedFrom: string; upToAsAt?: boolean },
): Statement {
  const { asAt, trustedFrom } = options;
  const upToAsAt = options.upToAsAt ?? true;
  const open = invoices.filter(isOpen);
  const old = open.filter((invoice) => isUnreconciledImport(invoice, trustedFrom));
  const trusted = open.filter((invoice) => !isUnreconciledImport(invoice, trustedFrom));
  // An invoice with no issue date cannot be placed after the statement date, so it stays.
  const isLater = (invoice: StatementInvoice) =>
    upToAsAt && Boolean(invoice.issue_date) && (invoice.issue_date as string) > asAt;
  const later = trusted.filter(isLater);
  const kept = trusted.filter((invoice) => !isLater(invoice));

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
    later: {
      count: later.length,
      amount: r2(later.reduce((sum, invoice) => sum + Number(invoice.balance), 0)),
    },
  };
}

/** Whether there is anything to put in front of a customer. */
export function statementHasContent(statement: Statement): boolean {
  return statement.rows.length > 0;
}

/* --------------------------------------------------------- the list screen */

/**
 * The statement date a person asked for, or today. A date in the future is
 * refused rather than honoured: ageing an invoice against a day that has not
 * happened makes nothing overdue, and a statement dated next week reads as a
 * typing slip on the customer's side. Junk falls back rather than throwing,
 * because on a server component a throw is a 500 on a list page.
 */
export function parseStatementDate(raw: unknown, today: string): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return today;
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== raw) return today;
  return raw > today ? today : raw;
}

export const STATEMENT_SORTS = ["balance", "name", "overdue"] as const;
export type StatementSort = (typeof STATEMENT_SORTS)[number];

export function parseStatementSort(raw: unknown): StatementSort {
  return (STATEMENT_SORTS as readonly unknown[]).includes(raw) ? raw as StatementSort : "balance";
}

/** One row of the Statements screen: who, how to reach them, what they owe. */
export type StatementListRow = {
  customerId: string;
  name: string;
  customerNumber: string;
  contactName: string | null;
  phone: string | null;
  billingEmail: string | null;
  total: number;
  overdue: number;
  invoices: number;
};

/**
 * Filter and order the list. Only customers with something on their statement
 * are listed, because a statement with nothing on it is not sent. The search
 * matches the name, customer number, contact or email, ignoring case. Largest
 * balance first by default, which is what a person chasing money reads first;
 * the name breaks every tie so the order never shuffles between loads.
 */
export function statementListView(
  rows: readonly StatementListRow[], options: { q?: string; sort?: StatementSort },
): StatementListRow[] {
  const q = (options.q ?? "").trim().toLowerCase();
  const matches = (row: StatementListRow) => !q || [
    row.name, row.customerNumber, row.contactName, row.billingEmail,
  ].some((value) => value?.toLowerCase().includes(q));
  const byName = (a: StatementListRow, b: StatementListRow) => a.name.localeCompare(b.name);
  const sort = options.sort ?? "balance";
  return rows
    .filter((row) => row.invoices > 0 && matches(row))
    .sort((a, b) => {
      if (sort === "name") return byName(a, b);
      if (sort === "overdue") return b.overdue - a.overdue || b.total - a.total || byName(a, b);
      return b.total - a.total || byName(a, b);
    });
}

/* ------------------------------------------------------- sending, reported */

/**
 * Why a statement did not go. Skips and failures are counted apart: a customer
 * who owes nothing or has no email on file is not an error anybody has to act on
 * now, while a bounce is. ysm-hub reports the same three.
 */
export type StatementSkip = "nothing_owed" | "no_email";

export type StatementOutcome =
  | { kind: "sent"; customer: string }
  | { kind: "skipped"; customer: string; reason: StatementSkip }
  | { kind: "failed"; customer: string; reason: string };

export const SKIP_TEXT: Record<StatementSkip, string> = {
  nothing_owed: "owed nothing",
  no_email: "no billing email",
};

export function summariseStatementSends(outcomes: readonly StatementOutcome[]): {
  ok: boolean; message: string;
} {
  const sent = outcomes.filter((o) => o.kind === "sent").length;
  const nothing = outcomes.filter((o) => o.kind === "skipped" && o.reason === "nothing_owed").length;
  const noEmail = outcomes.filter((o) => o.kind === "skipped" && o.reason === "no_email").length;
  const failed = outcomes.filter((o): o is Extract<StatementOutcome, { kind: "failed" }> => o.kind === "failed");

  const parts = [`Sent ${sent} ${sent === 1 ? "statement" : "statements"}.`];
  if (nothing > 0) parts.push(`${nothing} owed nothing.`);
  if (noEmail > 0) parts.push(`${noEmail} had no billing email.`);
  if (failed.length > 0) {
    parts.push(`${failed.length} could not be sent. ${failed[0]!.customer}: ${failed[0]!.reason}.`);
  }
  // Nothing sent and something failed is a failure; nothing sent because every
  // one was skipped is still a failure to the person who pressed Send.
  return { ok: sent > 0, message: parts.join(" ") };
}

/** How many of a selection would be skipped for want of an email, for the confirm. */
export function countWithoutEmail(rows: readonly { billingEmail: string | null }[]): number {
  return rows.filter((row) => !row.billingEmail?.trim()).length;
}

/* -------------------------------------------------------- monthly sending */

/**
 * The automatic monthly statement (ysm-hub's partner statements on the 1st).
 *
 * Due on the first three days of a month, so a missed cron hit on the 1st is
 * caught on the 2nd or 3rd. Not later: a switch turned on in the middle of a
 * month must not send a statement that afternoon. The statement is dated the
 * last day of the month before, which is when a monthly statement is made up
 * to, and the period key (`YYYY-MM`) is what the audit marker records so the
 * five sweeps a day send it once.
 */
export const MONTHLY_STATEMENT_WINDOW_DAYS = 3;

/** For the settings screen: when the run goes, in the words of the window above. */
export const MONTHLY_STATEMENT_WHEN =
  `on the 1st of each month (or within ${MONTHLY_STATEMENT_WINDOW_DAYS} days if a run is missed)`;

export function monthlyStatementDue(businessDay: string): { period: string; asAt: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) return null;
  const day = Number(businessDay.slice(8, 10));
  if (day < 1 || day > MONTHLY_STATEMENT_WINDOW_DAYS) return null;
  const year = Number(businessDay.slice(0, 4));
  const month = Number(businessDay.slice(5, 7));
  const end = new Date(Date.UTC(year, month - 1, 0));
  const asAt = end.toISOString().slice(0, 10);
  return { period: asAt.slice(0, 7), asAt };
}

/**
 * Who the monthly run sends to: somebody with something on their statement and
 * a billing email, who has not asked to be left out of reminders, and who was
 * not already sent this period's statement.
 */
export function monthlyStatementSkip(input: {
  hasContent: boolean; billingEmail: string | null; remindersEnabled: boolean | null;
  alreadySent: boolean;
}): "nothing_owed" | "no_email" | "opted_out" | "already_sent" | null {
  if (input.alreadySent) return "already_sent";
  if (!input.hasContent) return "nothing_owed";
  if (input.remindersEnabled === false) return "opted_out";
  if (!input.billingEmail?.trim()) return "no_email";
  return null;
}
