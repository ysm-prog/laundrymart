/**
 * What one line of a customer's document prints, in the columns of the standard
 * invoice (`standard-layout.tsx`): **Item Code | Description | Quantity | Price |
 * Tax | Amount**. Pure, so the rule is tested rather than buried in a PDF template
 * that no assertion can read.
 *
 * Three decisions in it:
 *
 *  - **The Item Code is the item code** (`T35`, `42469`) — what the laundry and
 *    the customer both say — and blank on a line that names no item (a fuel levy,
 *    a typed line). Never the GL code: that is the bookkeeper's, and the customer
 *    reading this is reading somebody else's chart of accounts otherwise.
 *
 *  - **A line prints the item's name, not the generator's text or the bare code.**
 *    The running draft writes `LJ00032 — Towels — 10` so the internal record says
 *    which job and which kind of laundry; the customer reads `Towels - Black`. The
 *    job number belongs in the service breakdown under the table. The same goes
 *    for a line whose description is only the code (`00415359` printed "T35" twice
 *    where Xero printed "Towels - Black"). Otherwise a typed line keeps the words a
 *    person chose, because overwriting them would put an item name over a note
 *    somebody wrote on purpose.
 *
 *  - **The Tax column shows the rate**, `10%`, as the standard invoice does: GST
 *    on a taxable line and `0%` on one carrying none, with a line's tax code
 *    (0043) deciding where it has one.
 */

export type PdfLineSource = {
  description: string;
  taxable: boolean;
  /** `job`, `contract` or `manual` (0040). Absent on a credit-note line. */
  origin?: string | null;
  item_code?: string | null;
  item_name?: string | null;
  tax_code?: string | null;
};

export type PdfLineCells = { itemId: string; description: string; tax: string };

export function pdfLineCells(line: PdfLineSource, gstRate = 0.1): PdfLineCells {
  const code = line.item_code?.trim() ?? "";
  const name = line.item_name?.trim() ?? "";
  const typed = line.description.trim();
  const onlyTheCode = Boolean(code) && typed.toLowerCase() === code.toLowerCase();
  const description = name && (line.origin === "job" || onlyTheCode) ? name : line.description;
  const taxCode = line.tax_code?.trim().toUpperCase();
  const taxed = taxCode ? taxCode === "GST" : line.taxable;
  return { itemId: code, description, tax: taxed ? gstPercent(gstRate) : "0%" };
}

/** `0.1` → `10%`, without a float's tail. */
export function gstPercent(gstRate: number): string {
  return `${Math.round(Number(gstRate) * 10000) / 100}%`;
}

/**
 * The heading a customer's document carries. "Tax Invoice" only where GST is
 * actually charged (the ATO's wording); a draft must not print looking final; a
 * credit is an **Adjustment Note**.
 */
export function invoiceDocumentTitle(invoice: {
  invoice_type: string; status: string; tax_amount: number; total: number;
}): string {
  if (invoice.invoice_type === "credit" || Number(invoice.total) < 0) return "Adjustment Note";
  const name = Number(invoice.tax_amount) > 0 ? "Tax Invoice" : "Invoice";
  return invoice.status === "draft" ? `Draft ${name}` : name;
}

/** `2026-10-18` → `18/10/2026`, for the service breakdown's tight columns. */
export function auDate(value: string | null): string {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-11-02` → `2 Nov 2026`, as the standard invoice prints a date. Read off the string, so no timezone can move it. */
export function longDate(value: string | null): string {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-");
  const name = MONTHS[Number(month) - 1];
  return year && name && day ? `${Number(day)} ${name} ${year}` : value;
}

/** Which of the two image formats a PDF can carry, from the file's own first bytes. */
export function imageFormat(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}
