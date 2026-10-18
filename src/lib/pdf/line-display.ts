/**
 * What one line of a customer's document prints, in the columns of the
 * laundry's own MYOB invoice (brief 1.10): **Item ID | Description | Qty |
 * Unit price | Tax | Amount**. Pure, so the rule is tested rather than buried in
 * a PDF template that no assertion can read.
 *
 * Three decisions in it:
 *
 *  - **The Item ID is the item code** (`T35`, `42469`) — what the laundry and the
 *    customer both say — and blank on a line that names no item (a fuel levy, a
 *    typed line). Never the GL code: that is the bookkeeper's, and the customer
 *    reading this is reading somebody else's chart of accounts otherwise.
 *
 *  - **A job's line prints the item's name, not the generator's text.** The
 *    running draft writes `LJ00032 — Towels — 10` so the internal record says
 *    which job and which kind of laundry; MYOB prints `Towels - Black`. The job
 *    number and the kind of laundry belong in the service breakdown under the
 *    table, which is where the PDF now prints them for every job-billed invoice
 *    (gap G15). A typed line — `origin` manual or contract — keeps the words a
 *    person chose, because overwriting them would put an item name over a note
 *    somebody wrote on purpose.
 *
 *  - **The Tax column shows the tax code** (`GST`, `FRE`, `N-T`). A line with no
 *    code (every live line today) answers from its own GST flag rather than
 *    printing a blank the customer has to interpret.
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

export function pdfLineCells(line: PdfLineSource): PdfLineCells {
  const code = line.item_code?.trim() ?? "";
  const name = line.item_name?.trim() ?? "";
  const description = line.origin === "job" && name ? name : line.description;
  const tax = line.tax_code?.trim()
    ? line.tax_code.trim().toUpperCase()
    : line.taxable ? "GST" : "FRE";
  return { itemId: code, description, tax };
}

/**
 * The heading a customer's document carries. "Tax invoice" only where GST is
 * actually charged (the ATO's wording); a draft must not print looking final;
 * a credit is MYOB's **Adjustment note**, which is what the template says.
 */
export function invoiceDocumentTitle(invoice: {
  invoice_type: string; status: string; tax_amount: number; total: number;
}): string {
  if (invoice.invoice_type === "credit" || Number(invoice.total) < 0) return "Adjustment note";
  if (invoice.status === "draft") return "Draft invoice";
  return Number(invoice.tax_amount) > 0 ? "Tax invoice" : "Invoice";
}

/** `2026-10-18` → `18/10/2026`, as the MYOB invoice prints a date. */
export function auDate(value: string | null): string {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

/** Which of the two image formats a PDF can carry, from the file's own first bytes. */
export function imageFormat(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}
