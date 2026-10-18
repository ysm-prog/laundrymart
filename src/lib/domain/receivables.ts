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

/* ------------------------------------------- trusted receivables (brief 1.9) */

/**
 * From when an imported balance can be trusted (brief 1.9, gap G5).
 *
 * Today's Overdue tile read **$38k across 297 invoices** — almost all of it MYOB
 * history imported as headers, whose payments were recorded in MYOB and never
 * came across. Until somebody has reconciled those balances, an imported invoice
 * dated before this day is **not** counted on Today — not in the Overdue tile and
 * not in Needs a decision — and the register marks it "Imported – not
 * reconciled". It stays in the register and in the reports; nothing about it
 * changes but where it is counted.
 *
 * Kept in `tenants.settings.receivables.ar_trusted_from` (0055 widens
 * `save_tenant_settings` to accept it) and defaulted to **1 October 2026**, the
 * Xero cut-over, so nothing has to be written for the rule to apply. Moving the
 * date back is how an owner says the history has been reconciled.
 */
export const DEFAULT_AR_TRUSTED_FROM = "2026-10-01";

export function arTrustedFrom(settings: unknown): string {
  const bag = settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).receivables : undefined;
  const value = bag && typeof bag === "object" && !Array.isArray(bag)
    ? (bag as Record<string, unknown>).ar_trusted_from : undefined;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    ? value : DEFAULT_AR_TRUSTED_FROM;
}

/** An imported invoice from before the trusted date: shown, badged, not counted on Today. */
export function isUnreconciledImport(
  invoice: { source?: string | null; issue_date: string | null },
  trustedFrom: string,
): boolean {
  return invoice.source === "import" && Boolean(invoice.issue_date) && invoice.issue_date! < trustedFrom;
}

/**
 * The PostgREST filter that keeps only invoices Today may count: everything the
 * app raised, and imports dated on or after the trusted day. Built here so the
 * tile and the list cannot apply two different rules.
 */
export function trustedReceivablesFilter(trustedFrom: string): string {
  return `source.eq.app,issue_date.gte.${trustedFrom}`;
}
