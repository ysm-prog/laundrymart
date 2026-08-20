/**
 * The archive's vocabulary (0017).
 *
 * `archivable_tables()` in the database is the single source of truth for
 * *what* an archive covers — it is read both by the migration that attaches the
 * policies and by the function that stamps the rows, so the two can never
 * disagree. This module is the other half: what each of those tables is called
 * when a person reads it.
 *
 * It is a plain module rather than a lookup inside the page because the two
 * lists have to be pinned together. A table added to the SQL array and forgotten
 * here would surface on the screen as a raw schema name — `laundry_order_items`
 * in the middle of an otherwise plain-English list — and nothing else in the
 * app would notice. `archive.test.ts` reads the migration and asserts both
 * directions.
 */

/**
 * Schema name → the operator's word.
 *
 * Note `laundry_orders` is "Jobs" and `jobs` is "Stops". That is not a slip: it
 * is the same two-words-one-table arrangement CLAUDE.md §6 documents, and this
 * is the one screen where printing the raw names would actively mislead — a
 * table labelled "jobs" listing stops, next to a table labelled "laundry
 * orders" listing what the whole app calls jobs.
 */
export const ARCHIVE_TABLE_LABELS: Record<string, string> = {
  customers: "Customers",
  customer_locations: "Customer sites",
  customer_contacts: "Customer contacts",
  service_agreements: "Contracts",
  service_agreement_lines: "Contract prices",
  laundry_orders: "Jobs",
  laundry_order_items: "Job laundry lists",
  laundry_order_activity: "Job history",
  invoices: "Invoices",
  invoice_lines: "Invoice lines",
  payments: "Payments",
  credit_notes: "Credit notes",
  credit_note_lines: "Credit note lines",
  jobs: "Stops",
  pickups: "Collections",
  pickup_lines: "Collection lines",
  deliveries: "Deliveries",
  delivery_lines: "Delivery lines",
  additional_charges: "Extra charges",
};

/** The label for a table, falling back to something readable rather than blank. */
export function archiveTableLabel(table: string): string {
  return ARCHIVE_TABLE_LABELS[table] ?? table.replace(/_/g, " ");
}
