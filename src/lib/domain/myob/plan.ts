import { ident, partyNumber, round, termsDays } from "./values";
import type {
  Account, Bill, Credit, Invoice, Order, Party, Problem, Remittance, ReportParty,
} from "./readers";
import type { InventoryItem } from "./inventory";

/**
 * Everything the uploaded files add up to, worked out before anything is
 * written.
 *
 * This is the whole reason the upload screen has two steps. A set of books is
 * the one kind of data where a plausible wrong number is worse than a loud
 * failure, so the plan is built, counted and shown first; only then does
 * `src/lib/import/commit.ts` execute it. The function is pure — it takes the
 * parsed files and what the database already holds, and returns rows — so the
 * preview and the write can never disagree about what is about to happen.
 */

export type ParsedFiles = {
  contacts?: Party[];
  bills?: Bill[];
  orders?: Order[];
  credits?: Credit[];
  accounts?: Account[];
  report?: ReportParty[];
  invoices?: Invoice[];
  remittances?: Remittance[];
  inventory?: InventoryItem[];
};

/** Parties the tenant already holds, so their numbers survive a re-import. */
export type ExistingParties = {
  customers: { id: string; number: string }[];
  suppliers: { id: string; number: string }[];
};

export type PlannedTable = {
  table: string;
  label: string;
  /** Column list for the upsert's conflict target. */
  conflict: string;
  rows: Record<string, unknown>[];
  /**
   * Match on this column by **reading first** instead of upserting.
   *
   * For a table whose uniqueness is an *expression* index — `items` is unique on
   * `(tenant_id, lower(item_code)) where deleted_at is null` — PostgREST's
   * `on_conflict=` cannot name it, and Postgres refuses the statement outright:
   *
   *     42P10: there is no unique or exclusion constraint matching the
   *            ON CONFLICT specification
   *
   * Proved against a real database rather than reasoned about, because it fails
   * at request time and no typecheck or unit test can see it. The remedy is the
   * one `laundry_prices` already documents: read what is there, update by id and
   * insert the rest, and never infer an index through `on_conflict`.
   */
  matchBy?: { column: string; caseInsensitive?: boolean };
};

export type ImportPlan = {
  tables: PlannedTable[];
  problems: Problem[];
  /** Plain-sentence observations for the preview: repairs, drops, oddities. */
  notes: string[];
  parties: {
    customersNew: number; customersExisting: number;
    suppliersNew: number; suppliersExisting: number;
  };
  totals: { receivable: number; payable: number };
  /** Whether a document arrived that can supersede an opening balance. */
  clearOpenings: boolean;
  sequences: { kind: string; prefix: string; next: number }[];
};

export type PlanOptions = {
  tenantId: string;
  /** `outstanding` loads only invoices that still carry a balance. */
  invoiceScope?: "outstanding" | "all";
};

/** Keep the last row for each key — a later file is the more authoritative one. */
function dedupe<T>(rows: T[], key: (row: T) => string): { rows: T[]; dropped: number } {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return { rows: [...byKey.values()], dropped: rows.length - byKey.size };
}

/** The numeric tail of `CUST00042`, or 0 for a number the app did not issue. */
function indexOf(number: string): number {
  return Number.parseInt(/(\d+)$/.exec(number)?.[1] ?? "0", 10) || 0;
}

type PartySeed = Party & {
  lapsed?: boolean;
  status?: "active" | "inactive";
  /**
   * True when a contact export actually described this party, rather than a
   * document merely naming them.
   *
   * The distinction decides whether their row is written at all. Upload only
   * `invoices.csv` and every customer it names is *implied* — we know the name
   * and nothing else — so writing them would set an existing customer's status
   * to inactive and wipe the balance they arrived with. An implied party is
   * therefore created only when they are genuinely new, which is what the
   * documents need, and never used to overwrite one already here.
   */
  described?: boolean;
};

export function buildPlan(
  files: ParsedFiles,
  existing: ExistingParties,
  { tenantId, invoiceScope = "outstanding" }: PlanOptions,
): ImportPlan {
  const problems: Problem[] = [];
  const notes: string[] = [];

  const contacts = files.contacts ?? [];
  const bills = files.bills ?? [];
  const orders = files.orders ?? [];
  const credits = files.credits ?? [];
  const accounts = files.accounts ?? [];
  const report = files.report ?? [];
  const remittances = files.remittances ?? [];
  const inventory = files.inventory ?? [];
  const invoices = (files.invoices ?? [])
    .filter((invoice) => invoiceScope === "all" || invoice.outstanding);

  if (files.invoices && invoiceScope === "outstanding") {
    const held = files.invoices.length - invoices.length;
    if (held > 0) {
      notes.push(
        `${held.toLocaleString()} fully paid invoices were left out — only the ${invoices.length.toLocaleString()} `
        + "that still carry a balance are being loaded. Choose the full history to include them.",
      );
    }
  }

  // ------------------------------------------------------------- parties ---
  const known = new Set(contacts.map((party) => party.name));
  // A document can name a party the contact export no longer lists — an account
  // closed in MYOB keeps its history. Those parties are created here too,
  // inactive, rather than dropping the documents that reference them.
  const lapsedSuppliers = [...new Set(
    [...bills, ...orders].map((doc) => doc.supplier).filter((name) => !known.has(name)),
  )].sort(byName);
  const lapsedCustomers = [...new Set(
    credits.map((credit) => credit.customer).filter((name) => !known.has(name)),
  )].sort(byName);

  const customers: PartySeed[] = contacts
    .filter((party) => party.kind === "customer").map((party) => ({ ...party, described: true }));
  const suppliers: PartySeed[] = contacts
    .filter((party) => party.kind === "supplier").map((party) => ({ ...party, described: true }));
  customers.push(...lapsedCustomers.map((name) => lapsedParty(name, "customer")));
  suppliers.push(...lapsedSuppliers.map((name) => lapsedParty(name, "supplier")));
  customers.sort((a, b) => byName(a.name, b.name));
  suppliers.sort((a, b) => byName(a.name, b.name));

  // Parties only the second round of reports names are appended after the first
  // round's, never merged into its sort — on a tenant that has never been
  // imported into, the resulting numbering is what the original load produced.
  customers.push(...appended(customers, [
    ...report.filter((party) => party.kind === "customer").map((party) => party.name),
    ...invoices.map((invoice) => invoice.customer),
  ], "customer"));
  suppliers.push(...appended(suppliers, [
    ...report.filter((party) => party.kind === "supplier").map((party) => party.name),
    ...remittances.map((payment) => payment.supplier),
  ], "supplier"));

  const customerId = new Map(customers.map((party) => [party.name, ident(tenantId, "customers", party.name)]));
  const supplierId = new Map(suppliers.map((party) => [party.name, ident(tenantId, "suppliers", party.name)]));

  // Numbers come from the database, not from position in this export. The
  // script this replaces numbered parties by their place in the sorted list,
  // which meant re-running a *grown* export could hand an existing number to a
  // different business. A party that is already here keeps the number it has.
  const customerNumber = assignNumbers(customers, customerId, existing.customers, "CUST");
  const supplierNumber = assignNumbers(suppliers, supplierId, existing.suppliers, "SUP");

  const heldCustomerIds = new Set(existing.customers.map((party) => party.id));
  const heldSupplierIds = new Set(existing.suppliers.map((party) => party.id));
  const parties = {
    customersNew: customers.filter((party) => !heldCustomerIds.has(customerId.get(party.name)!)).length,
    customersExisting: customers.filter((party) => heldCustomerIds.has(customerId.get(party.name)!)).length,
    suppliersNew: suppliers.filter((party) => !heldSupplierIds.has(supplierId.get(party.name)!)).length,
    suppliersExisting: suppliers.filter((party) => heldSupplierIds.has(supplierId.get(party.name)!)).length,
  };
  const tables: PlannedTable[] = [];
  const add = (table: PlannedTable) => { if (table.rows.length) tables.push(table); };

  const note = (party: PartySeed): string | null => {
    const bits: string[] = [];
    if (party.lapsed) bits.push("Carried in from MYOB document history; not on the current contact list.");
    if (party.extraEmails.length) bits.push(`Also emails: ${party.extraEmails.join(", ")}.`);
    return bits.join(" ") || null;
  };

  // Described parties are always written; implied ones only when they are new.
  const writable = (party: PartySeed, id: string, held: Set<string>) => party.described || !held.has(id);
  const newCustomers = customers.filter((p) => writable(p, customerId.get(p.name)!, heldCustomerIds));
  const newSuppliers = suppliers.filter((p) => writable(p, supplierId.get(p.name)!, heldSupplierIds));

  const created = [...newCustomers, ...newSuppliers].filter((party) => party.lapsed).length;
  if (created > 0) {
    notes.push(
      `${created} parties are named only by documents and will be created inactive, `
      + "rather than dropping the documents that name them.",
    );
  }
  const implied = customers.length + suppliers.length - newCustomers.length - newSuppliers.length;
  if (implied > 0) {
    notes.push(
      `${implied} parties are already here and are named only by documents in this upload, so their `
      + "details and balances are left exactly as they are.",
    );
  }

  add({
    table: "customers", label: "Customers", conflict: "id",
    rows: newCustomers.map((party) => ({
      id: customerId.get(party.name),
      customer_number: customerNumber.get(party.name),
      business_name: party.name,
      billing_email: party.email,
      phone: party.phone,
      status: party.lapsed ? "inactive" : "active",
      notes: note(party),
      opening_balance: party.balance,
      opening_balance_overdue: party.overdue,
      reminders_enabled: party.reminders,
    })),
  });
  add({
    table: "suppliers", label: "Suppliers", conflict: "id",
    rows: newSuppliers.map((party) => ({
      id: supplierId.get(party.name),
      supplier_number: supplierNumber.get(party.name),
      name: party.name,
      email: party.email,
      phone: party.phone,
      status: party.lapsed ? "inactive" : "active",
      notes: note(party),
      opening_balance: party.balance,
    })),
  });

  // ------------------------------------------------------------ accounts ---
  add({
    table: "gl_accounts", label: "Chart of accounts", conflict: "tenant_id,code",
    rows: accounts.map((account) => ({
      code: account.code, name: account.name, account_type: account.type,
      tax_code: account.taxCode, is_linked: account.linked, is_header: account.header,
      level: account.level, current_balance: account.balance,
    })),
  });

  // ----------------------------------------------------------------- items ---
  // Upserted on the code, so a re-import corrects an item rather than making a
  // second one — the same `conflict` the chart of accounts uses, and the reason
  // the code and not MYOB's internal row number is the natural key.
  //
  // **`sell_price` is 0 where MYOB holds none, and that is not the same as free.**
  // What a customer is charged lives in `laundry_prices` — per customer with a
  // tenant default — which is where this app has always kept it and where the
  // client's own per-customer rates already are. The column carries MYOB's price
  // for the two items that have one and nothing invented for the rest.
  //
  // `is_sell`/`is_buy` are both true because the export says nothing about the
  // split; `tax_code` is left null because MYOB's Included/Excluded answers a
  // different question (does the price include GST) than ours does (which ledger
  // code applies). Neither is guessed at — see `myob/inventory.ts`.
  add({
    table: "items", label: "Items", conflict: "tenant_id,item_code",
    // `uq_items_code` is on `lower(item_code)` and partial, so this table is
    // matched by reading rather than upserted. See `matchBy` above.
    matchBy: { column: "item_code", caseInsensitive: true },
    rows: inventory.map((item) => ({
      item_code: item.code,
      sku: item.code,
      name: item.name,
      sell_price: item.sellPrice ?? 0,
      is_sell: true,
      is_buy: true,
      myob_item_id: item.myobItemId,
      myob_item_code: item.code,
      status: "active",
    })),
  });

  // --------------------------------------------------------------- bills ---
  let droppedDues = 0;
  let repairedBills = 0;
  const billRows = bills.flatMap((bill) => {
    const supplier = supplierId.get(bill.supplier);
    if (!supplier) {
      problems.push({
        file: "bills", row: null, fatal: true,
        message: `Bill ${bill.number} names ${bill.supplier}, who is in none of the uploaded files.`,
      });
      return [];
    }
    if (bill.repaired) repairedBills += 1;
    // MYOB allows a bill to fall due before it was issued on a handful of
    // back-dated rows; the table's check refuses that, so the due date is
    // dropped rather than the bill. Recorded in notes, not swallowed.
    const dropped = usable(bill.issueDate, bill.dueDate);
    if (dropped) droppedDues += 1;
    return [{
      supplier_id: supplier, bill_number: bill.number, supplier_invoice_no: bill.invoiceNo,
      issue_date: bill.issueDate, due_date: dropped ? null : bill.dueDate,
      amount: bill.amount, balance_due: bill.balance, status: bill.status,
      notes: dropped
        ? `MYOB due date ${bill.dueDate} predates the issue date; not imported.`
        : null,
    }];
  });
  if (repairedBills > 0) {
    notes.push(
      `${repairedBills} of ${bills.length} bills arrived with MYOB's dropped-column bug and were repaired. `
      + "Unrepaired, each would have imported a date as its amount.",
    );
  }
  if (droppedDues > 0) {
    notes.push(`${droppedDues} bills fall due before they were issued; the due date is left blank and noted on the row.`);
  }
  add({ table: "supplier_bills", label: "Supplier bills", conflict: "tenant_id,bill_number", rows: billRows });

  // ----------------------------------------------------- purchase orders ---
  const orderRows = orders.flatMap((order) => {
    const supplier = supplierId.get(order.supplier);
    if (!supplier) {
      problems.push({
        file: "purchase orders", row: null, fatal: true,
        message: `Purchase order ${order.number} names ${order.supplier}, who is in none of the uploaded files.`,
      });
      return [];
    }
    return [{
      supplier_id: supplier, po_number: order.number, supplier_invoice_no: order.invoiceNo,
      issue_date: order.issueDate, promised_date: order.promisedDate,
      amount: order.amount, balance_due: order.balance,
      status: order.balance === 0 ? "closed" : "open",
    }];
  });
  add({ table: "purchase_orders", label: "Purchase orders", conflict: "tenant_id,po_number", rows: orderRows });

  // ------------------------------------------------------------- credits ---
  // Real invoices that ended up in credit, so they land in `invoices` as
  // `credit` rather than in a table of their own — the customer statement has to
  // show them beside everything else they were billed.
  //
  // They arrive with no lines, because the export has none: only a document
  // total. `subtotal` and `total` therefore carry the MYOB figure as-is and
  // `tax_amount` stays zero rather than being back-computed from a GST rate the
  // export never states. Consequence worth knowing: `recalculate_invoice()`
  // would zero one, since that function derives totals from lines.
  const invoiceNumbers = new Set(invoices.map((invoice) => invoice.number));
  const creditRows = credits.flatMap((credit) => {
    const customer = customerId.get(credit.customer);
    if (!customer) {
      problems.push({
        file: "credits", row: null, fatal: true,
        message: `Credit ${credit.number} names ${credit.customer}, who is in none of the uploaded files.`,
      });
      return [];
    }
    // The invoices export carries the same document, and writes more of it. Two
    // upserts naming one row in a single statement is an error, not a last-wins.
    if (invoiceNumbers.has(credit.number)) return [];
    return [{
      customer_id: customer, invoice_number: credit.number, invoice_type: "credit",
      status: credit.balance === 0 ? "paid" : "issued",
      issue_date: credit.issueDate, purchase_order_number: credit.po,
      subtotal: credit.amount, total: credit.amount, amount_paid: credit.paid,
      notes: "Imported from the MYOB sale returns and credits export.",
    }];
  });
  const credit = dedupe(creditRows, (row) => String(row.invoice_number));
  add({ table: "invoices", label: "Customer credits", conflict: "tenant_id,invoice_number", rows: credit.rows });

  // ------------------------------------------------ the contacts report ---
  // Two things this list has that the contacts export does not: an explicit
  // active/inactive status, and the parties that only appear here. Its balances
  // are the authoritative ones — they sum to Trade Debtors and Trade Creditors
  // exactly, which the other export's did not.
  add({
    table: "customers", label: "Customer balances (contacts report)", conflict: "id",
    rows: report.filter((party) => party.kind === "customer").map((party) => ({
      id: customerId.get(party.name), customer_number: customerNumber.get(party.name),
      business_name: party.name, billing_email: party.email, phone: party.phone,
      status: party.status, opening_balance: party.balance,
    })),
  });
  add({
    table: "suppliers", label: "Supplier balances (contacts report)", conflict: "id",
    rows: report.filter((party) => party.kind === "supplier").map((party) => ({
      id: supplierId.get(party.name), supplier_number: supplierNumber.get(party.name),
      name: party.name, email: party.email, phone: party.phone,
      status: party.status, opening_balance: party.balance,
    })),
  });

  // ------------------------------------------------------------ invoices ---
  let droppedInvoiceDues = 0;
  const invoiceRows = invoices.flatMap((invoice) => {
    const customer = customerId.get(invoice.customer);
    if (!customer) {
      problems.push({
        file: "invoices", row: null, fatal: true,
        message: `Invoice ${invoice.number} names ${invoice.customer}, who is in none of the uploaded files.`,
      });
      return [];
    }
    // Same check the bills carry, for the same table constraint.
    const dropped = usable(invoice.issueDate, invoice.dueDate);
    if (dropped) droppedInvoiceDues += 1;
    const due = dropped ? null : invoice.dueDate;
    return [{
      customer_id: customer, invoice_number: invoice.number, invoice_type: invoice.kind,
      status: invoice.status, issue_date: invoice.issueDate, due_date: due,
      // Payment terms are the gap between the two dates the export gives, not
      // the app's default: a COD customer is not on 14 days, and saying so would
      // put every one of their invoices into the overdue chase a fortnight late.
      payment_terms_days: termsDays(invoice.issueDate, due),
      purchase_order_number: invoice.po,
      subtotal: invoice.amount, total: invoice.amount, amount_paid: invoice.paid,
      notes: "Imported from the MYOB invoices export.",
    }];
  });
  if (droppedInvoiceDues > 0) {
    notes.push(`${droppedInvoiceDues} invoices fall due before they were issued; the due date is left blank.`);
  }
  const invoiced = dedupe(invoiceRows, (row) => String(row.invoice_number));
  if (invoiced.dropped > 0) {
    notes.push(`${invoiced.dropped} invoice numbers appear more than once in the export; the last of each is used.`);
  }
  add({ table: "invoices", label: "Invoices", conflict: "tenant_id,invoice_number", rows: invoiced.rows });

  // --------------------------------------------------- supplier payments ---
  const paymentRows = remittances.flatMap((payment) => {
    const supplier = supplierId.get(payment.supplier);
    if (!supplier) {
      problems.push({
        file: "remittance advice", row: null, fatal: true,
        message: `Remittance ${payment.reference} names ${payment.supplier}, who is in none of the uploaded files.`,
      });
      return [];
    }
    return [{
      supplier_id: supplier, reference: payment.reference, paid_on: payment.paidOn,
      amount: payment.amount, remittance_email: payment.email,
      notes: "Imported from the MYOB remittance advice export.",
    }];
  });
  const paid = dedupe(paymentRows, (row) => String(row.reference));
  add({ table: "supplier_payments", label: "Supplier payments", conflict: "tenant_id,reference", rows: paid.rows });

  // ------------------------------------------------------------- totals ---
  const totals = {
    receivable: round(invoices.reduce((sum, invoice) => sum + invoice.balance, 0)),
    payable: round(bills.reduce((sum, bill) => sum + bill.balance, 0)),
  };

  // Park each sequence past what this import used, so the first number the app
  // issues cannot collide with an imported one.
  const highest = (assigned: Map<string, string>, held: { number: string }[]) => Math.max(
    0, ...[...assigned.values()].map(indexOf), ...held.map((party) => indexOf(party.number)),
  );
  const sequences = [
    { kind: "customer", prefix: "CUST", next: highest(customerNumber, existing.customers) + 1 },
    { kind: "supplier", prefix: "SUP", next: highest(supplierNumber, existing.suppliers) + 1 },
  ];

  return {
    tables, problems, notes, parties, totals,
    // An opening balance is what a party arrived with that no document accounts
    // for, so it goes to zero the moment a document does.
    clearOpenings: invoiced.rows.length > 0 || credit.rows.length > 0
      || billRows.length > 0 || report.length > 0,
    sequences,
  };
}

function byName(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

function lapsedParty(name: string, kind: "customer" | "supplier"): PartySeed {
  return {
    name, kind, phone: null, email: null, extraEmails: [], reminders: false,
    balance: 0, overdue: 0, lapsed: true,
  };
}

function appended(existing: PartySeed[], names: string[], kind: "customer" | "supplier"): PartySeed[] {
  const held = new Set(existing.map((party) => party.name));
  return [...new Set(names)].filter((name) => !held.has(name)).sort(byName)
    .map((name) => lapsedParty(name, kind));
}

/** True when the due date cannot be stored — the table refuses due before issue. */
function usable(issue: string | null, due: string | null): boolean {
  return due !== null && issue !== null && due < issue;
}

/**
 * A number for every party: the one it already has, or the next free one.
 *
 * Assigning from the database rather than from position is what makes the
 * upload re-runnable. Numbers only ever grow, so a party the app created between
 * imports is never renumbered and never collided with.
 */
function assignNumbers(
  parties: PartySeed[],
  ids: Map<string, string>,
  held: { id: string; number: string }[],
  prefix: string,
): Map<string, string> {
  const byId = new Map(held.map((party) => [party.id, party.number]));
  let next = Math.max(0, ...held.map((party) => indexOf(party.number))) + 1;
  const assigned = new Map<string, string>();
  for (const party of parties) {
    const id = ids.get(party.name)!;
    const existing = byId.get(id);
    assigned.set(party.name, existing ?? partyNumber(prefix, next));
    if (!existing) next += 1;
  }
  return assigned;
}
