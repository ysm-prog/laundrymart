import {
  MYOB_FILES, detectFile, headerOf,
  readAccounts, readBills, readContacts, readContactsReport, readCredits,
  readInvoices, readOrders, readRemittances,
  type MyobKind, type ParsedFiles, type Problem,
} from "@/lib/domain/myob";

/**
 * Uploaded files in, parsed datasets out.
 *
 * The reading itself is pure and lives in `src/lib/domain/myob`; this is only
 * the part that knows an upload is a list of named byte buffers. Nothing here
 * touches the database.
 */

export type UploadedFile = { name: string; bytes: Buffer };

export type FileSummary = {
  name: string;
  /** How big the file was, for the "did it all arrive" question. */
  bytes: number;
  status: "known" | "redundant" | "unknown" | "duplicate";
  kind: MyobKind | null;
  label: string;
  /** What this export fills, or why it is being skipped. */
  detail: string;
  rows: number;
};

export type ParseResult = {
  files: ParsedFiles;
  summaries: FileSummary[];
  problems: Problem[];
};

export function parseUploads(uploads: UploadedFile[]): ParseResult {
  const files: ParsedFiles = {};
  const summaries: FileSummary[] = [];
  const problems: Problem[] = [];
  const seen = new Map<MyobKind, string>();

  for (const upload of uploads) {
    const detected = detectFile(upload.name, headerOf(upload.name, upload.bytes));

    if (detected.status === "redundant") {
      summaries.push({
        name: upload.name, bytes: upload.bytes.length, status: "redundant",
        kind: null, label: detected.label, rows: 0,
        detail: `Skipped — ${detected.because}.`,
      });
      continue;
    }
    if (detected.status === "unknown") {
      summaries.push({
        name: upload.name, bytes: upload.bytes.length, status: "unknown",
        kind: null, label: "Not recognised", rows: 0,
        detail: "This is not one of the MYOB exports the importer reads, so it is being ignored.",
      });
      continue;
    }

    const { kind } = detected;
    // Two files claiming the same export is not a last-wins: one of them is the
    // wrong download, and quietly picking either would put a number in the books
    // that nobody chose.
    const already = seen.get(kind);
    if (already) {
      summaries.push({
        name: upload.name, bytes: upload.bytes.length, status: "duplicate",
        kind, label: MYOB_FILES[kind].label, rows: 0,
        detail: `Also uploaded as ${already}.`,
      });
      problems.push({
        file: upload.name, row: null, fatal: true,
        message: `Two files look like the ${MYOB_FILES[kind].label} export (${already} and ${upload.name}). `
          + "Remove one — the importer will not guess which is current.",
      });
      continue;
    }
    seen.set(kind, upload.name);

    const read = readOne(kind, upload);
    problems.push(...read.problems);
    summaries.push({
      name: upload.name, bytes: upload.bytes.length, status: "known", kind,
      label: MYOB_FILES[kind].label, rows: read.rows,
      detail: MYOB_FILES[kind].fills,
    });
    Object.assign(files, read.assign);
  }

  return { files, summaries, problems };
}

function readOne(kind: MyobKind, upload: UploadedFile): {
  rows: number; problems: Problem[]; assign: ParsedFiles;
} {
  const source = () => upload.bytes.toString("utf8");
  switch (kind) {
    case "contacts": {
      const read = readContacts(upload.name, source());
      return { rows: read.rows.length, problems: read.problems, assign: { contacts: read.rows } };
    }
    case "bills": {
      const read = readBills(upload.name, source());
      return { rows: read.rows.length, problems: read.problems, assign: { bills: read.rows } };
    }
    case "orders": {
      const read = readOrders(upload.name, source());
      return { rows: read.rows.length, problems: read.problems, assign: { orders: read.rows } };
    }
    case "credits": {
      const read = readCredits(upload.name, source());
      return { rows: read.rows.length, problems: read.problems, assign: { credits: read.rows } };
    }
    case "accounts": {
      const read = readAccounts(upload.name, source());
      return { rows: read.rows.length, problems: read.problems, assign: { accounts: read.rows } };
    }
    case "contactsReport": {
      const read = readContactsReport(upload.name, upload.bytes);
      return { rows: read.rows.length, problems: read.problems, assign: { report: read.rows } };
    }
    case "invoices": {
      const read = readInvoices(upload.name, source());
      return { rows: read.rows.length, problems: read.problems, assign: { invoices: read.rows } };
    }
    case "remittances": {
      const read = readRemittances(upload.name, source());
      return { rows: read.rows.length, problems: read.problems, assign: { remittances: read.rows } };
    }
  }
}
