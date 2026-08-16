import { parseCsvRecords, csvHeader } from "./csv";
import { readXlsx } from "./xlsx";
import { CellError, day, money, text } from "./values";

/**
 * One reader per MYOB export, and the rules for recognising which is which.
 *
 * Ported from `scripts/import/myob-import.py`. Two things about the exports are
 * load-bearing and both live here:
 *
 * - **The bills file loses a column.** When "Supplier Invoice No" is blank MYOB
 *   omits the field rather than emitting an empty one, so every later value
 *   shifts one place left. 667 of the 1,515 rows in the original export were
 *   like this. Unrepaired, each of them imports a *date* as its amount and still
 *   looks entirely plausible on screen.
 * - **Money is legitimately negative.** A supplier debit note is money owed back
 *   to the business; a customer credit is a negative balance. Nothing is clamped.
 */

/** Something wrong with one row, or with a whole file. */
export type Problem = {
  file: string;
  /** 1-based data row, or null when the whole file is the problem. */
  row: number | null;
  message: string;
  /** Fatal problems block the import; the rest are reported and imported past. */
  fatal: boolean;
};

export type Party = {
  name: string;
  kind: "customer" | "supplier";
  phone: string | null;
  email: string | null;
  extraEmails: string[];
  reminders: boolean;
  balance: number;
  overdue: number;
};

export type ReportParty = Party & { status: "active" | "inactive" };

export type Bill = {
  number: string; supplier: string; invoiceNo: string | null;
  issueDate: string | null; dueDate: string | null;
  amount: number; balance: number; status: string;
  /** True when this row arrived with the shifted-column bug and was repaired. */
  repaired: boolean;
};

export type Order = {
  number: string; supplier: string; invoiceNo: string | null;
  issueDate: string | null; promisedDate: string | null;
  amount: number; balance: number;
};

export type Credit = {
  number: string; customer: string; po: string | null;
  issueDate: string | null; amount: number; balance: number; paid: number;
};

export type Account = {
  code: string; name: string; type: string; taxCode: string | null;
  linked: boolean; header: boolean; level: number; balance: number;
};

export type Invoice = {
  number: string; customer: string; po: string | null;
  issueDate: string | null; dueDate: string | null;
  amount: number; balance: number; paid: number;
  status: string; kind: "manual" | "credit"; outstanding: boolean;
};

export type Remittance = {
  reference: string; supplier: string; paidOn: string | null;
  email: string | null; amount: number;
};

export type Read<T> = { rows: T[]; problems: Problem[] };

// ------------------------------------------------------------ detection ---

/** The eight exports this importer understands, plus the two that add nothing. */
export const MYOB_KINDS = [
  "contacts", "bills", "orders", "credits", "accounts",
  "contactsReport", "invoices", "remittances",
] as const;

export type MyobKind = (typeof MYOB_KINDS)[number];

/** What each export is called, and what it fills. */
export const MYOB_FILES: Record<MyobKind, {
  label: string; suffix: string; format: "csv" | "xlsx"; columns: string[]; fills: string;
}> = {
  contacts: {
    label: "Contacts", suffix: "customers_contacts.csv", format: "csv",
    columns: ["Name", "Type", "Balance Due"],
    fills: "Customers and suppliers, with the balances each arrived with.",
  },
  bills: {
    label: "Bills", suffix: "bills.csv", format: "csv",
    columns: ["Bill Number", "Supplier", "Amount"],
    fills: "What the business owes its suppliers.",
  },
  orders: {
    label: "Purchase orders", suffix: "purchase_orders.csv", format: "csv",
    columns: ["PO Number", "Supplier", "Promised Date"],
    fills: "Orders placed and not yet closed.",
  },
  credits: {
    label: "Sale returns and credits", suffix: "sale_returns_and_credits.csv", format: "csv",
    columns: ["Invoice Number", "Customer", "Balance Due"],
    fills: "Customer credits, kept beside their invoices.",
  },
  accounts: {
    label: "Chart of accounts", suffix: "categories_chart_of_accounts.csv", format: "csv",
    columns: ["Name", "Type", "Current Balance"],
    fills: "The account codes every document is coded against.",
  },
  contactsReport: {
    label: "Contacts report", suffix: "ContactsReport.xlsx", format: "xlsx",
    columns: ["Contact ID", "Name", "Balance ($)"],
    fills: "The authoritative balances and each party's active/inactive status.",
  },
  invoices: {
    label: "Invoices", suffix: "invoices.csv", format: "csv",
    columns: ["Invoice No", "Customer", "Terms/Due Date"],
    fills: "Every sale ever raised.",
  },
  remittances: {
    label: "Remittance advice", suffix: "remittance_advice.csv", format: "csv",
    columns: ["Reference No", "Supplier", "Amount Paid"],
    fills: "Payments that actually left the business.",
  },
};

/**
 * Exports that are wholly contained in one of the above.
 *
 * Both were checked row by row rather than assumed, and both are named here so
 * uploading one gets an explanation instead of silence.
 */
export const REDUNDANT_FILES: { suffix: string; label: string; because: string }[] = [
  {
    suffix: "purchase_returns_and_debits.csv", label: "Purchase returns and debits",
    because: "every one of its rows is already in the bills export, as a debit note",
  },
  {
    suffix: "SalesRegisterReport.xlsx", label: "Sales register",
    because: "every one of its rows is already in the invoices export",
  },
];

export type Detected =
  | { status: "known"; kind: MyobKind }
  | { status: "redundant"; label: string; because: string }
  | { status: "unknown" };

/**
 * Which export a file is.
 *
 * By filename first, since MYOB names them predictably and a browser download
 * only ever adds a prefix or a `(1)`. A renamed file still lands, matched on the
 * columns it carries — that fallback is what stops the screen refusing a file
 * whose contents are perfectly good.
 */
export function detectFile(filename: string, header: string[] | null): Detected {
  const name = filename.toLowerCase();
  for (const { suffix, label, because } of REDUNDANT_FILES) {
    if (name.endsWith(suffix.toLowerCase())) return { status: "redundant", label, because };
  }
  for (const kind of MYOB_KINDS) {
    if (name.endsWith(MYOB_FILES[kind].suffix.toLowerCase())) return { status: "known", kind };
  }
  if (header && header.length > 0) {
    const present = new Set(header.map((column) => column.trim()));
    for (const kind of MYOB_KINDS) {
      if (MYOB_FILES[kind].columns.every((column) => present.has(column))) {
        return { status: "known", kind };
      }
    }
  }
  return { status: "unknown" };
}

/** The header of an uploaded file, for detection. Null when it has none. */
export function headerOf(filename: string, bytes: Buffer): string[] | null {
  if (filename.toLowerCase().endsWith(".xlsx")) {
    try {
      const rows = readXlsx(bytes);
      return rows.find((row) => row.some((cell) => cell.trim() !== "")) ?? null;
    } catch {
      return null;
    }
  }
  return csvHeader(bytes.toString("utf8"));
}

// -------------------------------------------------------------- helpers ---

/** Apply `build` per row, turning a bad cell into a problem instead of a throw. */
function mapRows<S, T>(
  file: string, source: S[], build: (row: S, index: number) => T | null,
): Read<T> {
  const rows: T[] = [];
  const problems: Problem[] = [];
  source.forEach((row, index) => {
    try {
      const built = build(row, index);
      if (built) rows.push(built);
    } catch (cause) {
      problems.push({
        file, row: index + 1, fatal: true,
        message: cause instanceof CellError ? cause.message : String(cause),
      });
    }
  });
  return { rows, problems };
}

/** A file that does not carry the columns its reader needs is not that file. */
function missingColumns(file: string, kind: MyobKind, header: string[]): Problem[] {
  const present = new Set(header.map((column) => column.trim()));
  const missing = MYOB_FILES[kind].columns.filter((column) => !present.has(column));
  return missing.length === 0 ? [] : [{
    file, row: null, fatal: true,
    message: `Expected a ${MYOB_FILES[kind].label} export; it has no ${missing.join(", ")} column.`,
  }];
}

function required(value: string | null, what: string): string {
  if (!value) throw new CellError(`${what} is blank`);
  return value;
}

// -------------------------------------------------------------- readers ---

export function readContacts(file: string, source: string): Read<Party> {
  const records = parseCsvRecords(source);
  const bad = missingColumns(file, "contacts", Object.keys(records[0] ?? {}));
  if (bad.length) return { rows: [], problems: bad };

  return mapRows(file, records, (row) => {
    const name = text(row["Name"]);
    if (!name) return null;
    // MYOB packs several addresses into one cell. The first is the one invoices
    // go to; the rest are kept as a note rather than dropped, since `customers`
    // bills to a single address.
    const emails = (row["Email"] ?? "").split(";").map((one) => one.trim()).filter(Boolean);
    const kind = (row["Type"] ?? "").trim().toLowerCase();
    if (kind !== "customer" && kind !== "supplier") {
      throw new CellError(`${name} has an unknown contact type ${JSON.stringify(row["Type"])}`);
    }
    return {
      name, kind,
      phone: text(row["Phone Number"]),
      email: emails[0] ?? null,
      extraEmails: emails.slice(1),
      reminders: (row["Automated Reminders"] ?? "").trim().endsWith("on"),
      balance: money(row["Balance Due"]),
      overdue: money(row["Overdue"]),
    };
  });
}

export function readBills(file: string, source: string): Read<Bill> {
  const records = parseCsvRecords(source);
  const bad = missingColumns(file, "bills", Object.keys(records[0] ?? {}));
  if (bad.length) return { rows: [], problems: bad };

  return mapRows(file, records, (row) => {
    // The dropped-column case: Status is where the shift lands it empty, and
    // every field from Supplier Invoice No rightwards is one place early.
    const repaired = row["Status"] === "";
    const [invoiceNo, amount, balance, due, status] = repaired
      ? [null, row["Supplier Invoice No"], row["Amount"], row["Balance Due"], row["Due Date"]]
      : [text(row["Supplier Invoice No"]), row["Amount"], row["Balance Due"], row["Due Date"], row["Status"]];
    return {
      number: required(text(row["Bill Number"]), "Bill Number"),
      supplier: required(text(row["Supplier"]), "Supplier"),
      invoiceNo,
      issueDate: day(row["Issue Date"]),
      dueDate: day(due),
      amount: money(amount),
      balance: money(balance),
      status: (text(status) ?? "open").toLowerCase(),
      repaired,
    };
  });
}

export function readOrders(file: string, source: string): Read<Order> {
  const records = parseCsvRecords(source);
  const bad = missingColumns(file, "orders", Object.keys(records[0] ?? {}));
  if (bad.length) return { rows: [], problems: bad };

  return mapRows(file, records, (row) => ({
    number: required(text(row["PO Number"]), "PO Number"),
    supplier: required(text(row["Supplier"]), "Supplier"),
    invoiceNo: text(row["Supplier Invoice No"]),
    issueDate: day(row["Issue Date"]),
    promisedDate: day(row["Promised Date"]),
    amount: money(row["Amount"]),
    balance: money(row["Balance Due"]),
  }));
}

export function readCredits(file: string, source: string): Read<Credit> {
  const records = parseCsvRecords(source);
  const bad = missingColumns(file, "credits", Object.keys(records[0] ?? {}));
  if (bad.length) return { rows: [], problems: bad };

  return mapRows(file, records, (row) => {
    const amount = money(row["Amount"]);
    const balance = money(row["Balance Due"]);
    return {
      number: required(text(row["Invoice Number"]), "Invoice Number"),
      customer: required(text(row["Customer"]), "Customer"),
      po: text(row["Customer PO No"]),
      issueDate: day(row["Issue Date"]),
      amount, balance,
      // `invoices.balance` is generated as total - amount_paid, so a credit is
      // expressed by what was paid against it rather than written to the balance.
      paid: Math.round((amount - balance) * 100) / 100,
    };
  });
}

export function readAccounts(file: string, source: string): Read<Account> {
  const records = parseCsvRecords(source);
  const bad = missingColumns(file, "accounts", Object.keys(records[0] ?? {}));
  if (bad.length) return { rows: [], problems: bad };

  const seen = new Set<string>();
  const read = mapRows(file, records, (row) => {
    const name = text(row["Name"]);
    if (!name) return null;
    let code = text(row["Code"]);
    const header = code === null;
    if (header) {
      // The classification rows carry no code. A synthetic one keeps the table's
      // natural key usable without inventing a hierarchy.
      code = `0-${name.toLowerCase().replace(/[^a-z]+/g, "").slice(0, 8).toUpperCase()}`;
    }
    if (seen.has(code!)) throw new CellError(`duplicate account code ${code}`);
    seen.add(code!);
    return {
      code: code!, name,
      type: text(row["Type"]) ?? "Other",
      taxCode: text(row["Tax Code"]),
      linked: (row["Linked"] ?? "").trim().toLowerCase() === "linked",
      header,
      level: Number.parseInt((row["Level"] || "Level 1").split(/\s+/).pop() ?? "1", 10) || 1,
      balance: money(row["Current Balance"]),
    };
  });
  return read;
}

/**
 * The balance-bearing contact list: every party that owes or is owed.
 *
 * A different slice from `customers_contacts.csv` — shorter, since it lists only
 * non-zero balances, but wider where it counts. It carries an explicit
 * Active/Inactive status, and it names parties the other export drops
 * altogether: closed accounts that still owe money. Leaving those out is what
 * put the receivable ledger out by five thousand dollars on the first import.
 */
export function readContactsReport(file: string, bytes: Buffer): Read<ReportParty> {
  let sheet: string[][];
  try {
    sheet = readXlsx(bytes);
  } catch (cause) {
    return { rows: [], problems: [{ file, row: null, fatal: true, message: String((cause as Error).message) }] };
  }
  const headerAt = sheet.findIndex((row) => row[0]?.trim() === "Contact ID");
  if (headerAt < 0) {
    return {
      rows: [], problems: [{
        file, row: null, fatal: true,
        message: "Expected a Contacts report; it has no 'Contact ID' header row.",
      }],
    };
  }
  const keys = (sheet[headerAt] ?? []).map((key) => key.trim());
  const records = sheet.slice(headerAt + 1).map((cells) => {
    const record: Record<string, string> = {};
    keys.forEach((key, index) => { record[key] = cells[index] ?? ""; });
    return record;
  });

  return mapRows(file, records, (row) => {
    const name = text(row["Name"]);
    if (!name) return null;
    const kind = (row["Type"] ?? "").trim().toLowerCase();
    if (kind !== "customer" && kind !== "supplier") return null;
    return {
      name, kind,
      phone: text(row["Phone"]),
      email: text(row["Email"]),
      extraEmails: [],
      reminders: false,
      balance: money(row["Balance ($)"]),
      overdue: 0,
      status: (row["Status"] ?? "").trim() === "Active" ? "active" : "inactive",
    };
  });
}

/**
 * MYOB's invoice states, in the app's vocabulary. A credit is not a state there
 * — it is a document type — so it keeps `issued` and is typed separately.
 */
export const INVOICE_STATUS: Record<string, string> = {
  paid: "paid", open: "issued", overdue: "overdue", "partially paid": "part_paid", credit: "issued",
};

export function readInvoices(file: string, source: string): Read<Invoice> {
  const records = parseCsvRecords(source);
  const bad = missingColumns(file, "invoices", Object.keys(records[0] ?? {}));
  if (bad.length) return { rows: [], problems: bad };

  return mapRows(file, records, (row) => {
    const amount = money(row["Amount"]);
    const balance = money(row["Balance Due"]);
    const terms = (row["Terms/Due Date"] ?? "").trim();
    const issueDate = day(row["Issue Date"]);
    // COD is a term, not a date: due the day it was issued. Anything else in
    // that column *is* the due date, which is why payment terms are derived from
    // the two dates rather than assumed to be the app's default.
    const dueDate = terms.toUpperCase() === "COD" ? issueDate : day(terms);
    const status = (row["Status"] ?? "").trim().toLowerCase();
    const mapped = INVOICE_STATUS[status];
    if (!mapped) {
      throw new CellError(`invoice ${row["Invoice No"]} has unknown status ${JSON.stringify(row["Status"])}`);
    }
    // MYOB writes a bare dash where there is no customer order number.
    const po = text(row["PO Number"]);
    return {
      number: required(text(row["Invoice No"]), "Invoice No"),
      customer: required(text(row["Customer"]), "Customer"),
      po: po === "-" ? null : po,
      issueDate, dueDate, amount, balance,
      paid: Math.round((amount - balance) * 100) / 100,
      status: mapped,
      kind: status === "credit" ? "credit" : "manual",
      outstanding: Math.abs(balance) > 0.005,
    };
  });
}

/**
 * Payments that actually left the business, one per remittance advice.
 *
 * There is no bill number anywhere in this export, so a payment is recorded
 * against the supplier and the date and nothing finer. Allocating them across
 * bills would be a bookkeeping claim the source never made.
 */
export function readRemittances(file: string, source: string): Read<Remittance> {
  const records = parseCsvRecords(source);
  const bad = missingColumns(file, "remittances", Object.keys(records[0] ?? {}));
  if (bad.length) return { rows: [], problems: bad };

  return mapRows(file, records, (row) => ({
    reference: required(text(row["Reference No"]), "Reference No"),
    supplier: required(text(row["Supplier"]), "Supplier"),
    // Already ISO in this export, unlike every other date MYOB writes.
    paidOn: text(row["Payment Date"]),
    email: text(row["Email"]),
    amount: money(row["Amount Paid"]),
  }));
}
