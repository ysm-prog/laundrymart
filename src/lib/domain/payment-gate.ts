// Whether a payment may be recorded against an invoice, and what it does to the
// invoice's paid-up figure. Pure, so the rule can be tested; the server action
// in invoices/actions.ts is the only caller.
//
// Two facts shape it:
// - A payment belongs on a document the customer has been sent. A draft is
//   still filling up (§30) and paying one moved it to `part_paid`, which then
//   could never be issued and dropped out of `uq_invoices_open_draft`. A void
//   is a record of what was said; a credit is money owed *to* the customer.
// - The 646 invoices imported from MYOB are headers with no lines and with
//   their MYOB paid-to-date written straight into `amount_paid` (no `payments`
//   rows). `recalculate_invoice` totals an invoice from its lines and its
//   payments, so calling it on one of those set the total to $0, threw away
//   what MYOB said had been paid, and marked the invoice Paid. A headerless
//   invoice is therefore settled by adding to `amount_paid`, not recalculated.

export const PAYABLE_STATUSES = ["issued", "part_paid", "overdue"] as const;

export type PaymentGateInput = {
  status: string;
  invoiceType: string | null;
  balance: number;
  amount: number;
  paidOn: string;   // ISO date
  today: string;    // ISO date, business timezone
};

const CENT = 0.005;

export function paymentRefusal(input: PaymentGateInput): string | null {
  const { status, invoiceType, balance, amount, paidOn, today } = input;
  if (invoiceType === "credit") {
    return "This is a credit, not an invoice — money is owed to the customer, so there is nothing to record a payment against.";
  }
  if (status === "draft") {
    return "This invoice is still a draft. Issue it before recording a payment.";
  }
  if (status === "void") return "This invoice has been voided, so it cannot take a payment.";
  if (status === "paid" || balance <= CENT) return "This invoice is already paid in full.";
  if (!(PAYABLE_STATUSES as readonly string[]).includes(status)) {
    return "Payments can only be recorded on an issued invoice.";
  }
  if (!(amount > 0)) return "Payment must be greater than zero.";
  if (amount > balance + CENT) {
    return `That is more than the $${balance.toFixed(2)} still owing. Record $${balance.toFixed(2)} or less.`;
  }
  if (paidOn > today) return "A payment date cannot be in the future.";
  return null;
}

/** Status and paid-up figure after a payment, for an invoice with no lines. */
export function settleHeaderOnly(total: number, amountPaid: number, amount: number) {
  const newPaid = Math.round((amountPaid + amount) * 100) / 100;
  const paid = newPaid >= total - CENT;
  return { amountPaid: newPaid, paid };
}
