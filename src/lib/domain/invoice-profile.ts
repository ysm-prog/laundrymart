/**
 * What a tax invoice says about the business that issued it, and how its
 * totals block reads. Pure, so the PDF, the email and the invoice page share
 * one answer and it is tested.
 *
 * The profile lives in `tenants.settings.invoiceProfile` (written through
 * `save_tenant_settings`, 0052) beside the notification preferences. Like
 * those, nothing here throws on a bad stored value: a hand-edited blob prints
 * less, not a 500 on every invoice.
 */

import { z } from "zod";
import { isValidAbn } from "./abn";

export type InvoiceProfile = {
  /** The business's address, one printed line each. */
  addressLines: string[];
  phone: string | null;
  email: string | null;
  /** Printed under the email in the header, as on the laundry's MYOB invoice (brief 1.10). */
  website: string | null;
  bankAccountName: string | null;
  bsb: string | null;
  accountNumber: string | null;
  /**
   * The logo printed top-left, as an object key in the private `tenant-branding`
   * bucket (0054) — `<tenant_id>/invoice-logo-<stamp>.<ext>`. The tenant's data,
   * uploaded on Settings › Invoicing; never a file in this repository.
   */
  logoPath: string | null;
};

export const EMPTY_PROFILE: InvoiceProfile = {
  addressLines: [], phone: null, email: null, website: null,
  bankAccountName: null, bsb: null, accountNumber: null, logoPath: null,
};

const text = z.string().trim().max(200).nullable().optional();
const stored = z.object({
  addressLines: z.array(z.string().trim().max(200)).max(6).optional(),
  phone: text, email: text, website: text, bankAccountName: text, bsb: text, accountNumber: text,
  logoPath: z.string().trim().max(300).nullable().optional(),
});

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export function parseInvoiceProfile(settings: unknown): InvoiceProfile {
  const bag = settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).invoiceProfile : undefined;
  const parsed = stored.safeParse(bag ?? {});
  if (!parsed.success) return { ...EMPTY_PROFILE };
  const p = parsed.data;
  return {
    addressLines: (p.addressLines ?? []).map((l) => l.trim()).filter(Boolean),
    phone: clean(p.phone), email: clean(p.email), website: clean(p.website),
    bankAccountName: clean(p.bankAccountName), bsb: clean(p.bsb),
    accountNumber: clean(p.accountNumber), logoPath: clean(p.logoPath),
  };
}

/**
 * A website as typed, made printable: `adelaidetowelservice.com.au`,
 * `www.example.com.au` and `https://www.example.com.au/` all print the way the
 * MYOB invoice does — no scheme, no trailing slash. Null for anything that is
 * not a plausible host, so a stray sentence never reaches a tax invoice.
 */
export function normaliseWebsite(raw: string): string | null {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * The one-line payment instruction the PDF prints under **Notes**, in the
 * format of the laundry's own MYOB invoice (brief 1.10):
 *
 *     Banking Details: BSB: 062-000 Account No. 12345678 Account Name: Example Laundry
 *
 * Built from the profile and gated by `paymentInstructions` — all three bank
 * details or nothing — so the PDF and the email cannot disagree about whether
 * the laundry can be paid. Never hard-coded: Darshan enters the details in
 * Settings › Invoicing.
 */
export function bankingDetailsLine(profile: InvoiceProfile): string | null {
  if (paymentInstructions(profile, "X").length === 0) return null;
  return `Banking Details: BSB: ${profile.bsb} Account No. ${profile.accountNumber} `
    + `Account Name: ${profile.bankAccountName}`;
}

/** `062000` / `062-000` / `062 000` → `062-000`; anything else is refused. */
export function normaliseBsb(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3)}` : null;
}

/** An ABN as stored: 11 digits, no spaces. */
export function normaliseAbn(raw: string): string | null {
  const digits = raw.replace(/\s/g, "");
  return /^\d{11}$/.test(digits) ? digits : null;
}

/** `12345678901` → `12 345 678 901`, the way the ATO prints one. */
export function formatAbn(abn: string): string {
  const d = abn.replace(/\s/g, "");
  return d.length === 11 ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : abn;
}

/**
 * The "how to pay" lines, or none. All three bank details or nothing: an
 * account number with no BSB is not a payment instruction, it is a puzzle.
 */
export function paymentInstructions(profile: InvoiceProfile, invoiceNumber: string): string[] {
  if (!profile.bankAccountName || !profile.bsb || !profile.accountNumber) return [];
  return [
    `Account name: ${profile.bankAccountName}`,
    `BSB: ${profile.bsb}`,
    `Account number: ${profile.accountNumber}`,
    `Please quote ${invoiceNumber} as the payment reference.`,
  ];
}

export type TotalsRow = { label: string; value: number; strong?: boolean; muted?: boolean };

/**
 * The totals block. Line amounts are GST-inclusive (0043), so the subtotal and
 * the total are the same number — and printing "Subtotal $74.80 / GST $6.80 /
 * Total $74.80" reads as a sum that does not add up. So the total leads, and
 * the GST is stated as what it is: a part of that total.
 */
export function invoiceTotalsRows(input: {
  total: number; taxAmount: number; amountPaid: number;
  amountCredited: number; balance: number;
}): TotalsRow[] {
  const total = Number(input.total);
  const tax = Number(input.taxAmount);
  const rows: TotalsRow[] = [
    { label: "Total (inc GST)", value: total, strong: true },
    { label: tax > 0 ? "Includes GST of" : "GST", value: tax, muted: true },
    { label: "Amount ex GST", value: Math.round((total - tax) * 100) / 100, muted: true },
  ];
  const paid = Number(input.amountPaid);
  const credited = Number(input.amountCredited);
  if (paid > 0.005) rows.push({ label: "Paid", value: paid });
  if (credited > 0.005) rows.push({ label: "Credited", value: credited });
  if (paid > 0.005 || credited > 0.005) {
    rows.push({ label: "Balance due", value: Number(input.balance), strong: true });
  }
  return rows;
}

/**
 * What stops a draft being issued as a tax invoice (2026-10-18, brief 1.1).
 *
 * INV00008 was issued and printed "TAX INVOICE" with no ABN, no business address
 * and no bank details, because nothing checked. These four facts are what make
 * the document a valid tax invoice a customer can pay, so issuing waits for all
 * of them: a valid ABN (the ATO checksum, not just eleven digits — a transposed
 * ABN is the mistake that looks right), the first address line, and the bank
 * details. All three bank details rather than the BSB and account number alone,
 * because `paymentInstructions` prints all three or nothing and a gate that
 * passed with a name missing would issue an invoice with no way to pay it.
 *
 * `guard_invoice_issue` (0053) is the boundary and asks the same four questions
 * in SQL; this is the sentence in front of it, shared by every Issue button and
 * every issue path (`issueOneInvoice`).
 */
export type IssueGap = "abn" | "abn_invalid" | "address" | "bank";

export function issueGaps(abn: string | null, profile: InvoiceProfile): IssueGap[] {
  const gaps: IssueGap[] = [];
  if (!abn || !abn.trim()) gaps.push("abn");
  else if (!isValidAbn(abn)) gaps.push("abn_invalid");
  if (!profile.addressLines[0]) gaps.push("address");
  if (paymentInstructions(profile, "X").length === 0) gaps.push("bank");
  return gaps;
}

const ISSUE_GAP_WORDS: Record<IssueGap, string> = {
  abn: "your ABN",
  abn_invalid: "a valid ABN (the one saved does not pass the ATO check)",
  address: "your business address",
  bank: "your bank details",
};

/** `a`, `a and b`, `a, b and c`. */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * Why a draft cannot be issued yet, or null when it can. One sentence, naming
 * what to add and where — "Add your bank details in Settings › Invoicing before
 * issuing." — because the person reading it is about to press Issue and needs
 * the remedy rather than the rule.
 */
export function issueBlockedReason(
  gaps: readonly IssueGap[],
  /** Only the Owner can open Settings › Invoicing; everybody else is told who can. */
  canEditSettings = true,
): string | null {
  if (gaps.length === 0) return null;
  const what = listWords(gaps.map((gap) => ISSUE_GAP_WORDS[gap]));
  return canEditSettings
    ? `Add ${what} in Settings › Invoicing before issuing. A tax invoice needs them.`
    : `Ask the owner to add ${what} in Settings › Invoicing. A tax invoice needs them before it can be issued.`;
}

const PROFILE_GAP_TEXT: Record<IssueGap, string> = {
  abn: "your ABN — without it this is not a valid tax invoice",
  abn_invalid: "a valid ABN — the one saved does not pass the ATO check",
  address: "your business address",
  bank: "your bank details for payment",
};

/** Which tenant facts a tax invoice is missing, in plain words. */
export function invoiceProfileGaps(abn: string | null, profile: InvoiceProfile): string[] {
  return issueGaps(abn, profile).map((gap) => PROFILE_GAP_TEXT[gap]);
}
