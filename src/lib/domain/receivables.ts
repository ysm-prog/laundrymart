/**
 * The outstanding-payments report (2026-10-12). It listed every unpaid invoice
 * back to 2011, cents first, with no total — 600 rows nobody could act on. This
 * is the rule behind its replacement: grouped by customer, largest balance
 * first, aged into the five buckets a bookkeeper reads, credits excluded, and
 * balances under $1 held back unless asked for.
 */

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_LABELS: Record<AgingBucket, string> = {
  current: "Current", "1-30": "1–30 days", "31-60": "31–60 days", "61-90": "61–90 days", "90+": "90+ days",
};

/** Days past due as at a date, both ISO. Not yet due (or no due date) is current. */
export function agingBucket(dueDate: string | null, asAt: string): AgingBucket {
  if (!dueDate) return "current";
  const days = Math.round((Date.parse(`${asAt}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export const SMALL_BALANCE = 1;

export type ReceivableInvoice = {
  id: string; invoice_number: string; invoice_type: string | null; due_date: string | null;
  balance: number; customer: string;
};

export type CustomerReceivable = {
  customer: string; total: number; invoices: number;
  buckets: Record<AgingBucket, number>; oldestDue: string | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const emptyBuckets = (): Record<AgingBucket, number> =>
  ({ current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 });

export function summariseReceivables(
  invoices: ReceivableInvoice[], asAt: string, options: { includeSmall: boolean },
) {
  const kept = invoices.filter((inv) =>
    inv.invoice_type !== "credit"
    && Number(inv.balance) > 0.005
    && (options.includeSmall || Number(inv.balance) >= SMALL_BALANCE));
  const hiddenSmall = invoices.filter((inv) =>
    inv.invoice_type !== "credit" && Number(inv.balance) > 0.005 && Number(inv.balance) < SMALL_BALANCE).length;

  const byCustomer = new Map<string, CustomerReceivable>();
  const totals = emptyBuckets();
  for (const inv of kept) {
    const bucket = agingBucket(inv.due_date, asAt);
    const row = byCustomer.get(inv.customer)
      ?? { customer: inv.customer, total: 0, invoices: 0, buckets: emptyBuckets(), oldestDue: null };
    row.total = r2(row.total + Number(inv.balance));
    row.invoices += 1;
    row.buckets[bucket] = r2(row.buckets[bucket] + Number(inv.balance));
    if (inv.due_date && (!row.oldestDue || inv.due_date < row.oldestDue)) row.oldestDue = inv.due_date;
    byCustomer.set(inv.customer, row);
    totals[bucket] = r2(totals[bucket] + Number(inv.balance));
  }
  const customers = [...byCustomer.values()]
    .sort((a, b) => b.total - a.total || a.customer.localeCompare(b.customer));
  const total = r2(customers.reduce((sum, c) => sum + c.total, 0));
  return { customers, totals, total, invoiceCount: kept.length, hiddenSmall: options.includeSmall ? 0 : hiddenSmall };
}
