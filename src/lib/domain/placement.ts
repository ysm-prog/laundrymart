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
 * The distinction the wording has to carry is *started* versus *added to*. Under
 * the running draft, the second is the ordinary case and the first happens once
 * a month per customer — and a reviewer who reads the same sentence eleven times
 * has no way to notice that eleven approvals produced eleven documents, which is
 * precisely the defect this whole change closes.
 *
 * **Neither word is "invoice raised", and that is deliberate.** Approving puts
 * money on a *draft*; the draft becomes an invoice when somebody issues it.
 * Saying "raised" here is what made pressing Approve read as though it had
 * created an invoice — so the sentence names the draft, and the first time one
 * is opened it says what closes it.
 */

export type Placement =
  /** The charges are on a draft. `opened` distinguishes started from added-to. */
  | {
      kind: "placed"; invoiceId: string; invoiceNumber: string;
      opened: boolean; total: number; period: string | null;
    }
  /** The approval stood; the draft did not. The job is still in the queue. */
  | { kind: "failed"; reason: string };

/** The sentence a placement adds to the approval's own. Leads with a space. */
export function describePlacementOutcome(placement: Placement): string {
  switch (placement.kind) {
    case "placed": {
      const where = placement.period ? ` for ${placement.period}` : "";
      return placement.opened
        ? ` Started draft invoice ${placement.invoiceNumber}${where}.`
          + " Issue it when you are ready to bill."
        : ` Added to draft invoice ${placement.invoiceNumber}${where}.`;
    }
    case "failed":
      return ` It is not on a draft invoice yet — ${placement.reason}`;
  }
}
