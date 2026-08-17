/**
 * Voiding an invoice in Xero: the part with rules in it.
 *
 * Until now a void was a two-place job. The invoice went `void` here, stayed
 * **AUTHORISED** in Xero, and the two books disagreed until somebody noticed —
 * which is worse than not pushing at all, because the first push taught everyone
 * that the two systems agree.
 *
 * ## Why voiding is not just another push
 *
 * The invoice push is idempotent by *update*: a retry carries `xero_invoice_id`
 * and turns the create into an update. A void cannot work that way, because Xero
 * treats VOIDED as terminal — a second void of an already-voided invoice is a
 * validation error, not a no-op. So the gate below has to distinguish "not sent
 * yet" from "already voided there" and treat both as **skips**.
 *
 * ## The case that will actually happen: a paid invoice
 *
 * **Xero refuses to void an invoice that has payments applied to it.** That is
 * not a bug to work around — it is Xero protecting a reconciled bank line, and
 * the correct answer in Xero is a credit note. So this reports it plainly rather
 * than retrying: the person needs to know their books still show the money.
 *
 * Everything here is pure. The fetch lives in `push-void.ts` beside it, for the
 * same reason the invoice and payment payloads are split from theirs: the
 * mapping is what can be wrong in a way a green build hides.
 */

export type VoidablePayment = {
  /** Set once a payment has been posted to Xero against this invoice. */
  xero_payment_id: string | null;
};

export type VoidGate =
  | { send: true }
  | { send: false; reason: string; skipped: boolean };

/**
 * Should this void reach Xero, and if not, is that a skip or a failure?
 *
 * Skips are silent-ish: they are recorded but never dressed as errors, on the
 * same principle as `paymentGate` — an integration whose warnings are mostly
 * "nothing was wrong" is an integration people stop reading.
 */
export function voidGate(input: {
  xeroInvoiceId: string | null;
  /** What Xero last recorded. `VOIDED` means somebody already did this. */
  xeroStatus?: string | null;
  /** Payments recorded here against the invoice. */
  payments: readonly VoidablePayment[];
}): VoidGate {
  const { xeroInvoiceId, xeroStatus, payments } = input;

  // Never reached Xero, so there is nothing there to void. The commonest case
  // by far — a draft voided before it was ever issued — and emphatically not a
  // failure.
  if (!xeroInvoiceId) {
    return {
      send: false, skipped: true,
      reason: "This invoice never reached Xero, so there is nothing to void there.",
    };
  }

  if ((xeroStatus ?? "").toUpperCase() === "VOIDED") {
    return {
      send: false, skipped: true,
      reason: "This invoice is already void in Xero.",
    };
  }

  // A payment posted to Xero means Xero will refuse the void outright. Saying so
  // *before* the request is not merely an optimisation: the answer a person
  // needs is "your books still show this as paid — raise a credit note", and
  // that is a better sentence than Xero's validation text relayed verbatim.
  const posted = payments.filter((p) => p.xero_payment_id !== null).length;
  if (posted > 0) {
    return {
      send: false, skipped: false,
      reason: `Xero will not void an invoice with ${posted} payment(s) posted against it. `
        + "The invoice is void here; in Xero it needs a credit note instead.",
    };
  }

  return { send: true };
}

/**
 * The body Xero wants.
 *
 * A void is a status change on the existing invoice, so the InvoiceID is the
 * whole of the addressing and nothing else may be sent — including a line item,
 * which Xero would read as an edit and refuse on a voided document.
 */
export function buildVoidPayload(xeroInvoiceId: string): {
  InvoiceID: string; Status: "VOIDED";
} {
  return { InvoiceID: xeroInvoiceId, Status: "VOIDED" };
}
