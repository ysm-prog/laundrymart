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

export type InvoiceProfile = {
  /** The business's address, one printed line each. */
  addressLines: string[];
  phone: string | null;
  email: string | null;
  bankAccountName: string | null;
  bsb: string | null;
  accountNumber: string | null;
};

export const EMPTY_PROFILE: InvoiceProfile = {
  addressLines: [], phone: null, email: null,
  bankAccountName: null, bsb: null, accountNumber: null,
};

const text = z.string().trim().max(200).nullable().optional();
const stored = z.object({
  addressLines: z.array(z.string().trim().max(200)).max(6).optional(),
  phone: text, email: text, bankAccountName: text, bsb: text, accountNumber: text,
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
    phone: clean(p.phone), email: clean(p.email),
    bankAccountName: clean(p.bankAccountName), bsb: clean(p.bsb),
    accountNumber: clean(p.accountNumber),
  };
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

/** Which tenant facts a tax invoice is missing, in plain words. */
export function invoiceProfileGaps(abn: string | null, profile: InvoiceProfile): string[] {
  const gaps: string[] = [];
  if (!abn) gaps.push("your ABN — without it this is not a valid tax invoice");
  if (profile.addressLines.length === 0) gaps.push("your business address");
  if (paymentInstructions(profile, "X").length === 0) gaps.push("your bank details for payment");
  return gaps;
}
