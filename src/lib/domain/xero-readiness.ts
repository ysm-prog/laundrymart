/**
 * Whether this laundry's invoices can go to Xero yet (brief 1.2, gaps G2 and
 * G11). Pure, so the Money › Xero pre-flight, the push and the tests read one
 * rule.
 *
 * **What it guards against is silent mis-posting, not a refusal.** A line whose
 * account has no Xero code does not fail to push — `resolveAccountCode` falls
 * through to the laundry's default sales account, so `4-1150 Towel Hire` would
 * land in Xero as plain Sales with nothing to say so until a bookkeeper
 * reconciled. So every account the app's invoices use has to be mapped before
 * any invoice is sent, and the pre-flight lists the ones that are not.
 */

export type UsedAccount = {
  id: string;
  /** Our chart's code, the one the bookkeeper reads (`4-1150`). */
  code: string;
  name: string;
  /** What that account is called in the connected Xero chart (0037). */
  xeroAccountCode: string | null;
  /** Where the app uses it — "invoice lines", "items", "charge types". */
  usedBy: string[];
};

export type AccountProblem = {
  account: UsedAccount;
  /** No Xero code set at all, or one the connected Xero chart does not carry. */
  problem: "unmapped" | "not_in_xero";
};

/**
 * The accounts in use that Xero would not post correctly. `xeroCodes` is the
 * connected chart's codes when it could be read; null (not connected, or the
 * read failed) checks the mapping alone — a code Xero then turns out not to
 * carry comes back as a push error on the invoice, which is visible.
 */
export function xeroAccountProblems(
  used: readonly UsedAccount[], xeroCodes: ReadonlySet<string> | null,
): AccountProblem[] {
  const problems: AccountProblem[] = [];
  for (const account of used) {
    const mapped = account.xeroAccountCode?.trim();
    if (!mapped) problems.push({ account, problem: "unmapped" });
    else if (xeroCodes && !xeroCodes.has(mapped)) problems.push({ account, problem: "not_in_xero" });
  }
  return problems.sort((a, b) => a.account.code.localeCompare(b.account.code));
}

/** The sentence a push is refused with while anything is unmapped, or null. */
export function pushBlockedReason(problems: readonly AccountProblem[]): string | null {
  if (problems.length === 0) return null;
  const codes = problems.map((entry) => entry.account.code);
  const shown = codes.slice(0, 4).join(", ") + (codes.length > 4 ? ` and ${codes.length - 4} more` : "");
  return problems.length === 1
    ? `Account ${shown} is used on your invoices and is not set up in Xero yet. Map it on Money › Xero before invoices are sent — otherwise it would land in the wrong account.`
    : `${problems.length} accounts used on your invoices are not set up in Xero yet (${shown}). Map them on Money › Xero before invoices are sent — otherwise they would land in the wrong account.`;
}

/**
 * Whether an invoice may be sent to Xero at all.
 *
 * A draft can still change and a void is a record of something not owed — both
 * as before. **An invoice brought in from MYOB is never sent** (brief 1.2): its
 * history was imported into Xero separately, so pushing it again would put the
 * same debt in the customer's ledger twice. `invoices.source` (0055) says which
 * is which; the app's own invoices are `app`.
 */
export function xeroPushRefusal(invoice: { status: string; source?: string | null }): string | null {
  if (invoice.source === "import") {
    return "This invoice was brought in from MYOB, and its history went into Xero separately — so it is never sent from here.";
  }
  if (invoice.status === "draft" || invoice.status === "void" || invoice.status === "voided") {
    return `A ${invoice.status} invoice is not sent to Xero.`;
  }
  return null;
}
