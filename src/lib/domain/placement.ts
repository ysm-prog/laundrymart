/**
 * Where a job's approved charges ended up, and how that reads back. No database.
 *
 * **The sentence a reviewer sees after pressing Approve**, and the reason it is
 * here rather than beside the action: `lib/orders/approve.ts` reaches
 * `generateInvoicesForJobs` → `recordAudit` → `lib/env`, which throws without a
 * configured environment, so a rule stated there is a rule no unit test can
 * import. This repository has shipped three contracts broken behind a green
 * `verify` for exactly that reason, and the fix is always the same.
 *
 * The distinction the wording has to carry is *raised* versus *added to*. Under
 * the running draft, the second is the ordinary case and the first happens once
 * a month per customer — and a reviewer who reads "raised INV00042" eleven times
 * has no way to notice that eleven approvals produced eleven invoices, which is
 * precisely the defect this whole change closes.
 */

export type Placement =
  /** The charges are on an invoice. `opened` distinguishes raised from added-to. */
  | {
      kind: "placed"; invoiceId: string; invoiceNumber: string;
      opened: boolean; total: number; period: string | null;
    }
  /** Deliberately not placed — the customer is billed manually. */
  | { kind: "held"; reason: string }
  /** The approval stood; the invoice did not. The job is still in the queue. */
  | { kind: "failed"; reason: string };

/** The sentence a placement adds to the approval's own. Leads with a space. */
export function describePlacementOutcome(placement: Placement): string {
  switch (placement.kind) {
    case "placed": {
      const where = placement.period ? ` for ${placement.period}` : "";
      return placement.opened
        ? ` Draft invoice ${placement.invoiceNumber} raised${where}.`
        : ` Added to draft invoice ${placement.invoiceNumber}${where}.`;
    }
    case "held":
      return ` ${placement.reason}`;
    case "failed":
      return ` It is not on an invoice yet — ${placement.reason}`;
  }
}

/** What a customer billed manually is told, rather than a bare "not invoiced". */
export const HELD_FOR_MANUAL =
  "This customer is billed manually, so nothing was invoiced.";
