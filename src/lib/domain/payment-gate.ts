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

// Whether to draw the payment form at all. The same rule `paymentRefusal`
// applies, stated once so the register's working pane and the invoice page
// cannot disagree: the pane used to offer the form on any non-draft with a
// balance, so a voided invoice showed a "Record payment" button that could
// only ever be refused.
export function canTakePayment(invoice: {
  invoice_type: string | null; status: string; balance: number | string;
}): boolean {
  return invoice.invoice_type !== "credit"
    && (PAYABLE_STATUSES as readonly string[]).includes(invoice.status)
    && Number(invoice.balance) > CENT;
}

// Whether a draft may be issued. A running draft (§30) can be emptied by taking
// its last job back off it; issuing it then sends the customer a $0.00 tax
// invoice and pushes it to Xero. Refused, with the remedy named.
export function issueRefusal(input: { status: string; lineCount: number }): string | null {
  if (input.status !== "draft") return "it is no longer a draft";
  if (input.lineCount <= 0) {
    return "it has nothing on it — add a line or a job first, or leave it as a draft";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2026-10-12 end-to-end gaps (0052). An invoice's balance is now
// `total - amount_paid - amount_credited`, and these rules are what the
// actions say in front of the database guards that enforce the same thing.

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The status an issued invoice should carry once its paid and credited figures
 * are known. Only the payable/settled statuses move; a draft or a void is
 * nobody's to re-settle. `overdue` is kept while money is still owed, because
 * that is a fact about the due date rather than about the payment.
 */
export function settledStatus(input: {
  status: string; total: number; amountPaid: number; amountCredited: number;
}): { status: string; paid: boolean } {
  const { status, total, amountPaid, amountCredited } = input;
  if (!["issued", "part_paid", "overdue", "paid"].includes(status)) {
    return { status, paid: status === "paid" };
  }
  const balance = round2(total - amountPaid - amountCredited);
  if (balance <= CENT) return { status: "paid", paid: true };
  if (status === "overdue") return { status: "overdue", paid: false };
  return { status: amountPaid + amountCredited > CENT ? "part_paid" : "issued", paid: false };
}

/**
 * Whether a credit note may be raised. **The rule: the issued credit notes on an
 * invoice never total more than what is still owed on it** — total less
 * payments. A credit past that is a refund, which this app cannot pay, and the
 * negative balance it leaves has nothing that could ever settle it.
 */
export function creditRefusal(input: {
  status: string; invoiceType: string | null; total: number;
  amountPaid: number; alreadyCredited: number; amount: number;
}): string | null {
  const { status, invoiceType, total, amountPaid, alreadyCredited, amount } = input;
  if (invoiceType === "credit") return "This is already a credit, so it cannot be credited.";
  if (status === "draft") return "This invoice is still a draft — change its lines instead of crediting it.";
  if (status === "void") return "This invoice is void, so there is nothing to credit.";
  if (!["issued", "part_paid", "overdue", "paid"].includes(status)) {
    return "A credit note can only be raised against an issued invoice.";
  }
  if (!(amount > 0)) return "Credit must be greater than zero.";
  const creditable = round2(Math.max(total - amountPaid - alreadyCredited, 0));
  if (amount > creditable + CENT) {
    if (creditable <= CENT) {
      return amountPaid > CENT
        ? "Nothing is left to credit — this invoice has been paid. Reverse a payment first if the customer is owed money back."
        : "Nothing is left to credit — earlier credit notes already cover this invoice.";
    }
    return `Only $${creditable.toFixed(2)} can still be credited `
      + `($${total.toFixed(2)} invoiced, $${amountPaid.toFixed(2)} paid, `
      + `$${alreadyCredited.toFixed(2)} already credited).`;
  }
  return null;
}

/** Why an invoice cannot be voided, or null. Shared by the button and the action. */
export function voidRefusal(input: {
  status: string; paymentCount: number; amountPaid: number; creditNoteCount: number;
}): string | null {
  if (input.status === "void") return "This invoice is already void.";
  if (input.paymentCount > 0 || input.amountPaid > CENT) {
    return "Payments are recorded against this invoice, so it cannot be voided. Reverse the payments first.";
  }
  if (input.creditNoteCount > 0) {
    return "Credit notes have been issued against this invoice, so it cannot be voided. Void the credit notes first.";
  }
  return null;
}

/**
 * Whether a recorded payment may be reversed. A header-only MYOB import keeps
 * its paid-up figure in `amount_paid` rather than in payment rows, so reversing
 * one subtracts from it — and must not take it below zero, or below what the
 * credit notes need (credits may never exceed what is owed).
 */
export function reversalRefusal(input: {
  headerOnly: boolean; amountPaid: number; amount: number; xeroPosted: boolean;
}): string | null {
  if (input.xeroPosted) {
    return "This payment has already been sent to Xero. Remove it in Xero first — reversing it here alone would leave the two sets of books disagreeing.";
  }
  if (input.headerOnly && input.amount > input.amountPaid + CENT) {
    return "Reversing this would take the paid-up figure below zero, which cannot be right. Check the invoice before trying again.";
  }
  return null;
}

/** The paid-up figure on a header-only invoice after reversing a payment. */
export function unsettleHeaderOnly(amountPaid: number, amount: number): number {
  return round2(Math.max(amountPaid - amount, 0));
}
