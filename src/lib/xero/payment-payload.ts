/**
 * Turning one payment into the JSON Xero wants, and deciding whether it may go
 * at all. **No I/O in here**, for the same reason `invoice-payload.ts` has none.
 *
 * Modelled on `ysm-prog/ysm-hub`'s `api/xero/post-payment.js`: a `Payments`
 * array carrying the Xero invoice, the bank account it landed in, the date, the
 * amount and a reference.
 */

export type PayloadPayment = {
  id: string;
  amount: number | string | null;
  paid_on: string | null;
  method: string | null;
  reference: string | null;
  xero_payment_id: string | null;
};

/** Why a payment is not being sent, when it is not. */
export type PaymentGate =
  | { send: true }
  | { send: false; skipped: boolean; reason: string };

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether this payment may be posted to Xero.
 *
 * The three "not yet" cases are **skips, not failures**, and the distinction is
 * the whole point: a laundry that has not chosen a bank account, or whose
 * invoice never reached Xero, has not done anything wrong, and marking every
 * payment with a red error it cannot act on is how an integration teaches
 * people to ignore it. Only a payment that *should* have gone and did not is an
 * error.
 */
export function paymentGate({
  payment, xeroInvoiceId, paymentAccountCode,
}: {
  payment: Pick<PayloadPayment, "amount" | "xero_payment_id">;
  /** The invoice's Xero id — null when the invoice itself never got there. */
  xeroInvoiceId: string | null;
  /** The laundry's chosen bank account — null until somebody picks one. */
  paymentAccountCode: string | null;
}): PaymentGate {
  if (payment.xero_payment_id) {
    // Already there. Not an error and not work: saying so stops a bulk retry
    // from reposting money.
    return { send: false, skipped: true, reason: "That payment is already in Xero." };
  }
  if (!xeroInvoiceId) {
    return {
      send: false, skipped: true,
      reason: "Its invoice has not reached Xero yet, so there is nothing to pay against.",
    };
  }
  if (!paymentAccountCode) {
    return {
      send: false, skipped: true,
      reason: "No Xero bank account has been chosen for payments yet.",
    };
  }
  if (toNumber(payment.amount) <= 0) {
    // A zero or negative payment is a refund or a correction in this schema and
    // Xero refuses it on /Payments — it wants a credit note instead.
    return {
      send: false, skipped: true,
      reason: "Only a payment of more than zero is sent to Xero.",
    };
  }
  return { send: true };
}

/**
 * How the payment is labelled in Xero.
 *
 * The customer's own reference when they gave one — that is what a bank
 * statement will show and what somebody reconciling is looking for. Otherwise
 * the method, so a row is never just an amount with no story.
 */
export function paymentReference(payment: Pick<PayloadPayment, "reference" | "method">): string {
  const given = payment.reference?.trim();
  if (given) return given;
  const method = payment.method?.replace(/_/g, " ").trim();
  return method ? `Laundry payment — ${method}` : "Laundry payment";
}

export function buildPaymentPayload({
  payment, xeroInvoiceId, paymentAccountCode,
}: {
  payment: PayloadPayment;
  xeroInvoiceId: string;
  paymentAccountCode: string;
}): Record<string, unknown> {
  return {
    Invoice: { InvoiceID: xeroInvoiceId },
    Account: { Code: paymentAccountCode },
    // Xero wants a plain date. `paid_on` is already a DATE column; the fallback
    // is only for a row that somehow has none, and today is the honest guess.
    Date: payment.paid_on ?? new Date().toISOString().slice(0, 10),
    Amount: toNumber(payment.amount),
    Reference: paymentReference(payment),
  };
}
