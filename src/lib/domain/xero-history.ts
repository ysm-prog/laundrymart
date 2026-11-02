/**
 * Reading the MYOB invoice history back out of Xero (2026-11-03).
 *
 * The September migration left the history in Xero in two shapes, and this file
 * is the rule for telling them apart:
 *  - **a draft numbered as MYOB numbered it**, `00414447` with the reference
 *    `MYOB 00414447`: the invoice as raised, with its lines, from July 2017 on.
 *    Every one is a draft, whether or not the customer paid.
 *  - **an opening balance**, `00318792-OB`, approved in Xero: what was still owed
 *    on that invoice at cut-over, for however much. Its status and amount due are
 *    the live answer, because that is what gets paid in Xero.
 *
 *  - **an approved invoice numbered as MYOB numbered it**, `00414464` with the same
 *    reference and no `-OB`: the last few days of MYOB, brought across whole. It is
 *    both of the above at once, the invoice with its lines and what is owed on it.
 *
 * So what is owed is read from the opening balance, and **a draft with no opening
 * balance was settled in MYOB**. That second half is an inference from how the
 * migration was done, chosen by Darshan and checked against Xero's receivables
 * after the import rather than taken on trust.
 *
 * Anything else in Xero, such as an `INV-` invoice raised there since cut-over, is
 * not MYOB history and is left alone.
 *
 * Pure: Xero's JSON in, the rows for `0062`'s functions out.
 */

export type XeroLine = {
  Description?: string | null;
  Quantity?: number | null;
  ItemCode?: string | null;
  AccountCode?: string | null;
  TaxType?: string | null;
  TaxAmount?: number | null;
  LineAmount?: number | null;
};

export type XeroInvoice = {
  Type?: string;
  InvoiceID: string;
  InvoiceNumber?: string | null;
  Reference?: string | null;
  Status?: string;
  Contact?: { ContactID?: string; Name?: string | null } | null;
  DateString?: string | null;
  DueDateString?: string | null;
  LineAmountTypes?: string | null;
  LineItems?: XeroLine[] | null;
  TotalTax?: number | null;
  Total?: number | null;
  AmountDue?: number | null;
};

export type HistoryKind = "history" | "opening" | "approved" | "other";

const r2 = (n: number) => Math.round(n * 100) / 100;
const OPENING = /^(.+)-OB$/i;

export function classifyXeroInvoice(invoice: XeroInvoice): HistoryKind {
  if (invoice.Type && invoice.Type !== "ACCREC") return "other";
  const number = invoice.InvoiceNumber?.trim() ?? "";
  if (OPENING.test(number)) {
    return invoice.Status === "AUTHORISED" || invoice.Status === "PAID" ? "opening" : "other";
  }
  if (!/^\d+$/.test(number) || !/^MYOB\b/i.test(invoice.Reference?.trim() ?? "")) return "other";
  if (invoice.Status === "DRAFT") return "history";
  return invoice.Status === "AUTHORISED" || invoice.Status === "PAID" ? "approved" : "other";
}

/** `00318792-OB` → `00318792`: the invoice an opening balance belongs to. */
export function openingBaseNumber(number: string | null | undefined): string | null {
  return number?.trim().match(OPENING)?.[1] ?? null;
}

/** A name compared the way the MYOB importer compares one. */
export function normaliseName(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** `2026-09-25T00:00:00` → `2026-09-25`. */
export function xeroDay(value: string | null | undefined): string | null {
  const day = value?.slice(0, 10);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Xero's tax type, in the three codes an invoice line carries here (0043). */
export function taxCodeFor(line: Pick<XeroLine, "TaxType" | "TaxAmount">): "GST" | "FRE" | "N-T" {
  const type = (line.TaxType ?? "").toUpperCase();
  if (type === "BASEXCLUDED") return "N-T";
  if (type === "OUTPUT") return "GST";
  if (type) return "FRE";
  return Number(line.TaxAmount ?? 0) !== 0 ? "GST" : "FRE";
}

export type HistoryLookups = {
  /** Xero's contact id, then the normalised name, to a customer's id. */
  customerByContact: Map<string, string>;
  customerByName: Map<string, string>;
  /** Every customer, for a name that is only similar. */
  customers: Array<{ id: string; name: string }>;
  /** `item_code`, lower case, to an item's id. */
  itemByCode: Map<string, string>;
  /** The Xero account code to a chart row's id. */
  accountByCode: Map<string, string>;
};

export type HistoryLine = {
  sequence: number; description: string; quantity: number; unit_price: number; amount: number;
  tax_code: "GST" | "FRE" | "N-T"; item_id: string | null; gl_account_id: string | null;
};

/**
 * One line, on this app's basis: **an amount here includes GST** (0043), and the
 * migration loaded Xero's drafts tax-exclusive. The amount is the figure of record.
 * The unit price is worked back from it, because a rate like $0.22 + GST does not
 * fit the two decimals `invoice_lines.unit_price` holds.
 */
export function historyLine(
  line: XeroLine, index: number, amountTypes: string | null | undefined, lookups: HistoryLookups,
): HistoryLine {
  const base = Number(line.LineAmount ?? 0);
  const amount = amountTypes === "Inclusive" ? r2(base) : r2(base + Number(line.TaxAmount ?? 0));
  const quantity = r2(Number(line.Quantity ?? 1));
  const code = line.ItemCode?.trim() ?? "";
  return {
    sequence: index + 1,
    description: line.Description?.trim() || code || "Item",
    quantity,
    unit_price: quantity ? r2(amount / quantity) : amount,
    amount,
    tax_code: taxCodeFor(line),
    item_id: code ? lookups.itemByCode.get(code.toLowerCase()) ?? null : null,
    gl_account_id: line.AccountCode ? lookups.accountByCode.get(line.AccountCode.trim()) ?? null : null,
  };
}

/**
 * A name reduced to its words: punctuation gone and a trailing company ending
 * dropped, so `Crown Barbers Pty Ltd` and `Crown Barbers` are compared as equals.
 */
export function looseName(name: string): string {
  return ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `
    .replace(/( pty)?( ltd| limited)? $/, " ")
    .replace(/ p l $/, " ");
}

/** Short names are too easily found inside somebody else's. */
const SIMILAR_MINIMUM = 9;

/**
 * The one customer whose name holds this name, or is held by it, in whole words.
 * `Salty Coconut` is `Prohaul Logistic Services P/L T/As Salty Coconut`. Two or more
 * candidates means no match, because a guess here puts one customer's invoices on
 * another's account. Check first lists every pair for a person to read.
 */
export function similarCustomer(
  name: string | null | undefined, customers: HistoryLookups["customers"],
): { id: string; name: string } | null {
  const wanted = looseName(name ?? "");
  if (wanted.trim().length < SIMILAR_MINIMUM) return null;
  const found = customers.filter((customer) => {
    const theirs = looseName(customer.name);
    if (theirs.trim().length < SIMILAR_MINIMUM) return false;
    return theirs.includes(wanted) || wanted.includes(theirs);
  });
  return found.length === 1 ? found[0]! : null;
}

export function customerFor(invoice: XeroInvoice, lookups: HistoryLookups): string | null {
  return lookups.customerByContact.get(invoice.Contact?.ContactID ?? "")
    ?? lookups.customerByName.get(normaliseName(invoice.Contact?.Name))
    ?? similarCustomer(invoice.Contact?.Name, lookups.customers)?.id
    ?? null;
}

export type HistoryRow = {
  number: string; customer_id: string | null; issue_date: string; due_date: string | null;
  total: number; tax: number; xero_invoice_id: string; lines: HistoryLine[];
};

/** The row `import_invoice_history` takes, or null without a date to file it under. */
export function historyRow(invoice: XeroInvoice, lookups: HistoryLookups): HistoryRow | null {
  const issue = xeroDay(invoice.DateString);
  if (!issue) return null;
  const due = xeroDay(invoice.DueDateString);
  return {
    number: invoice.InvoiceNumber!.trim(),
    customer_id: customerFor(invoice, lookups),
    issue_date: issue,
    // `invoices` refuses a due date before the issue date, as the MYOB importer found.
    due_date: due && due >= issue ? due : null,
    total: r2(Number(invoice.Total ?? 0)),
    tax: r2(Number(invoice.TotalTax ?? 0)),
    xero_invoice_id: invoice.InvoiceID,
    lines: (invoice.LineItems ?? []).map((line, index) =>
      historyLine(line, index, invoice.LineAmountTypes, lookups)),
  };
}

export type OpeningRow = {
  number: string; customer_id: string | null; issue_date: string; due_date: string | null;
  total: number; due: number; xero_invoice_id: string;
};

/** The row `apply_invoice_openings` takes. A paid opening balance owes nothing. */
export function openingRow(invoice: XeroInvoice, lookups: HistoryLookups): OpeningRow | null {
  const number = openingBaseNumber(invoice.InvoiceNumber) ?? invoice.InvoiceNumber?.trim();
  const issue = xeroDay(invoice.DateString);
  if (!number || !issue) return null;
  const due = xeroDay(invoice.DueDateString);
  return {
    number,
    customer_id: customerFor(invoice, lookups),
    issue_date: issue,
    due_date: due && due >= issue ? due : null,
    total: r2(Number(invoice.Total ?? 0)),
    due: invoice.Status === "PAID" ? 0 : r2(Number(invoice.AmountDue ?? 0)),
    xero_invoice_id: invoice.InvoiceID,
  };
}

/**
 * Which open MYOB invoices the app should now call paid: those Xero holds as a
 * draft with no opening balance. One that is in neither stays as it is, because
 * nothing says what happened to it.
 */
export function invoicesToSettle(input: {
  openInApp: Iterable<string>; drafts: Iterable<string>; openings: Iterable<string>;
}): { settle: string[]; unknown: string[] } {
  const drafts = new Set(input.drafts);
  const openings = new Set(input.openings);
  const settle: string[] = [];
  const unknown: string[] = [];
  for (const number of new Set(input.openInApp)) {
    if (openings.has(number)) continue;
    (drafts.has(number) ? settle : unknown).push(number);
  }
  return { settle: settle.sort(), unknown: unknown.sort() };
}
