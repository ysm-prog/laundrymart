/**
 * GST is **inside** the price, not added to it.
 *
 * The client's own MYOB invoice settles this, and the arithmetic in it is the
 * specification:
 *
 *     Subtotal   $72.70
 *     Tax         $6.61      <- the portion already inside the subtotal
 *     Total      $72.70      <- equal to the subtotal, because tax is not added
 *
 * `72.70 / 11 = 6.609…`, which rounds to the `6.61` printed. So a line's
 * `unit_price` is what the customer pays for one of them, full stop, and the tax
 * figure is a *disclosure* of what is already in there — never an addition.
 *
 * This reverses what this app did until 2026-08-26, which was to add 10% on top.
 * The two models differ on every invoice: three lines totalling $72.70 came to
 * $79.97 under the old one.
 *
 * **A tax code, not a boolean.** MYOB carries `GST`, `FRE` and `N-T` per line and
 * the item register supplies one for every sellable item. A yes/no tick cannot
 * tell "GST-free food" from "not reportable", which are different answers on a
 * BAS, so the code is what is stored and `taxable` is derived from it.
 */

/** The tax codes this app understands, and what each means on a BAS. */
export const TAX_CODES = ["GST", "FRE", "N-T"] as const;
export type TaxCode = (typeof TAX_CODES)[number];

export const TAX_CODE_LABELS: Record<TaxCode, string> = {
  GST: "GST",
  FRE: "GST-free",
  "N-T": "Not reportable",
};

export const DEFAULT_GST_RATE = 0.1;

/** True only for `GST`. Everything else carries no tax. */
export function taxCodeCarriesGst(code: string | null | undefined): boolean {
  return normaliseTaxCode(code) === "GST";
}

/**
 * MYOB writes `N` for not-reportable in some exports and `N-T` in others, and a
 * blank means nobody said. A code this app does not recognise is **kept out of
 * the tax calculation** rather than guessed into GST: over-collecting tax on a
 * customer's invoice is the worse of the two errors, and the code is visible on
 * the line for somebody to correct.
 */
export function normaliseTaxCode(code: string | null | undefined): TaxCode | null {
  const value = (code ?? "").trim().toUpperCase();
  if (!value) return null;
  if (value === "GST") return "GST";
  if (value === "FRE") return "FRE";
  if (value === "N" || value === "N-T" || value === "NT") return "N-T";
  return null;
}

/**
 * The GST already inside a tax-inclusive amount: `amount − amount / (1 + rate)`,
 * which at 10% is the familiar "divide by eleven".
 *
 * Rounded once, at the end, on the *summed* taxable amount rather than per line —
 * rounding each line and adding the results drifts by a cent or two across a long
 * invoice, and a total that disagrees with its own lines is the sort of thing a
 * bookkeeper has to chase.
 */
export function includedTax(taxInclusiveAmount: number, rate = DEFAULT_GST_RATE): number {
  if (!(rate > 0)) return 0;
  const raw = taxInclusiveAmount - taxInclusiveAmount / (1 + rate);
  return Math.round((raw + Number.EPSILON) * 100) / 100;
}

/** Gross a tax-exclusive figure up to its tax-inclusive equivalent. */
export function toTaxInclusive(exclusiveAmount: number, rate = DEFAULT_GST_RATE): number {
  return Math.round((exclusiveAmount * (1 + rate) + Number.EPSILON) * 100) / 100;
}

export type TaxInclusiveLine = {
  /** Already tax-inclusive, and already net of any discount. */
  amount: number;
  taxCode: string | null | undefined;
};

export type InvoiceTaxTotals = {
  /** The lines plus freight. Tax is inside this figure. */
  subtotal: number;
  /** What is already inside `subtotal`, disclosed. */
  taxAmount: number;
  /** Equal to `subtotal`. Kept as its own field because an invoice prints both. */
  total: number;
};

/**
 * An invoice's totals, MYOB's way.
 *
 * Freight is a line for tax purposes and a separate figure for presentation,
 * which is why it is an argument rather than something the caller folds into the
 * lines: the invoice prints it on its own row under the subtotal.
 */
export function taxInclusiveTotals(
  lines: readonly TaxInclusiveLine[],
  options: { freight?: number; freightTaxCode?: string | null; rate?: number } = {},
): InvoiceTaxTotals {
  const rate = options.rate ?? DEFAULT_GST_RATE;
  const freight = options.freight ?? 0;

  const lineSum = lines.reduce((sum, line) => sum + line.amount, 0);
  const taxableSum =
    lines.reduce((sum, line) => sum + (taxCodeCarriesGst(line.taxCode) ? line.amount : 0), 0) +
    (taxCodeCarriesGst(options.freightTaxCode) ? freight : 0);

  const subtotal = round2(lineSum + freight);
  return { subtotal, taxAmount: includedTax(taxableSum, rate), total: subtotal };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
