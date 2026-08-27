/**
 * The columns both supplier screens read, stated once.
 *
 * The same reasoning as `items/columns.ts`: PostgREST takes a `select` string,
 * so a column missing from it comes back `undefined` and renders as a blank
 * field rather than as an error. With 0045 adding nine columns to a table that
 * had four, two hand-maintained strings would drift the first time one screen
 * gained a field.
 *
 * The list reads a few columns it does not display — the address parts, so the
 * detail page and the list cannot disagree about what a supplier holds. 194
 * rows of short text is the right side of that trade.
 */
export const SUPPLIER_COLUMNS = [
  "id", "supplier_number", "name", "status", "opening_balance", "notes",

  // The contact card (0045), plus the two fields 0021 shipped.
  "abn", "contact_name", "phone", "email", "website",
  "address_line1", "address_line2", "suburb", "state", "postcode",

  // MYOB's "Category": where this supplier's bills post by default.
  "expense_account_id",
].join(", ");
