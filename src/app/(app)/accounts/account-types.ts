/**
 * The account types the chart is grouped by.
 *
 * A plain list rather than a database enum, for the reason 0021 left `tax_code`
 * unchecked: a chart of accounts is reference data copied from an accounting
 * package, and a check constraint would need migrating every time a bookkeeper
 * uses a type this list has not met. The column stays free text; this is what
 * the *form* offers, and it matches the filter the list screen already has.
 */
export const ACCOUNT_TYPES = [
  "Asset", "Bank", "Liability", "Equity", "Income", "Cost of sales", "Expense",
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];
