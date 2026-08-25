/**
 * Turning one of our invoices into the JSON Xero wants. **No I/O in here.**
 *
 * Modelled on `ysm-prog/ysm-hub`'s `lib/_xero-invoice.js`: an `ACCREC` invoice
 * carrying a Contact, LineItems, a DueDate and the invoice number in both
 * `InvoiceNumber` and `Reference`. Kept pure and separate from the fetch for
 * the reason this repo keeps re-learning — `plan.ts` and `order-items.ts` were
 * both unreachable from a test while they lived beside their I/O, and both
 * shipped broken behind a green `verify`. The mapping is the part with rules in
 * it, so the mapping is the part with tests.
 */

/** Xero rejects a line with no description, so there is always a fallback. */
const FALLBACK_DESCRIPTION = "Laundry services";

/**
 * Australian GST. `OUTPUT` is the 10% rate on sales; `EXEMPTOUTPUT` is what a
 * non-taxable line gets. `invoice_lines.taxable` already carries that decision
 * per line — it is set from the agreement line or the price list — so this
 * reads it rather than re-deciding it.
 */
export const TAX_TYPE_TAXABLE = "OUTPUT";
export const TAX_TYPE_EXEMPT = "EXEMPTOUTPUT";

export type PayloadInvoice = {
  invoice_number: string;
  issue_date: string | null;
  due_date: string | null;
  purchase_order_number: string | null;
  notes: string | null;
};

export type PayloadLine = {
  description: string | null;
  quantity: number | string | null;
  unit_price: number | string | null;
  taxable: boolean | null;
  /**
   * The GL account this line is coded to, **as the code is in Xero**.
   *
   * Read through `invoice_lines.item_id → items.income_account_id →
   * gl_accounts.xero_account_code`. Null falls back to the laundry's default
   * sales account, and if there is none the line goes uncoded exactly as every
   * line did before — which is the behaviour that must not change for a laundry
   * that has not filled any of this in.
   */
  account_code?: string | null;
  /**
   * This line's item code **as it is in Xero** (`items.xero_item_code`).
   *
   * Deliberately not `items.item_code`: that is the code staff type here, and
   * Xero refuses an invoice naming an `ItemCode` its own inventory does not
   * carry. Sending our code on the assumption the two match would turn one
   * mismatched item into every invoice failing to push.
   */
  item_code?: string | null;
};

export type PayloadCustomer = {
  business_name: string;
  trading_name: string | null;
  billing_email: string | null;
  xero_contact_id: string | null;
  xero_contact_name: string | null;
  billing_address_line1: string | null;
  billing_address_line2: string | null;
  billing_suburb: string | null;
  billing_state: string | null;
  billing_postcode: string | null;
};

export type XeroInvoicePayload = Record<string, unknown>;

/** A code that is present but blank is no code at all. */
function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** `numeric` comes back from PostgREST as a string; treat both, reject neither. */
function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The Xero Contact for a customer.
 *
 * `ContactID` when we already know it — that is what makes the second invoice
 * for a customer attach to the same contact instead of creating a duplicate.
 * Otherwise a name and an email, and Xero creates or matches on the name.
 */
export function buildContact(customer: PayloadCustomer): Record<string, unknown> {
  if (customer.xero_contact_id) {
    return { ContactID: customer.xero_contact_id };
  }

  const contact: Record<string, unknown> = {
    Name: customer.xero_contact_name ?? customer.business_name,
  };
  if (customer.billing_email) contact.EmailAddress = customer.billing_email;

  // Only send an address if there is one worth sending. Xero accepts a partial
  // address, and an object of nulls is worse than no object.
  const line1 = customer.billing_address_line1;
  if (line1) {
    contact.Addresses = [{
      AddressType: "STREET",
      AddressLine1: line1,
      ...(customer.billing_address_line2 ? { AddressLine2: customer.billing_address_line2 } : {}),
      ...(customer.billing_suburb ? { City: customer.billing_suburb } : {}),
      ...(customer.billing_state ? { Region: customer.billing_state } : {}),
      ...(customer.billing_postcode ? { PostalCode: customer.billing_postcode } : {}),
      Country: "Australia",
    }];
  }
  return contact;
}

/**
 * The whole invoice.
 *
 * `Status: "AUTHORISED"` because we only ever push an invoice this app has
 * already issued — a draft is not pushed at all, so pushing it as a Xero draft
 * would put the two systems in different states on purpose.
 *
 * A line with no unit price is still sent. A zero-priced line is a real thing
 * in this domain (an included allowance, a goodwill replacement) and silently
 * dropping it would make the Xero total disagree with ours.
 */
export function buildInvoicePayload({
  invoice, lines, customer, defaultAccountCode = null,
}: {
  invoice: PayloadInvoice;
  lines: readonly PayloadLine[];
  customer: PayloadCustomer;
  /**
   * The laundry's default sales account, chosen once on the Xero settings
   * screen beside the bank account payments post to.
   *
   * It exists because **most invoice lines carry no item at all** — a fuel
   * levy, a contract minimum, a consolidated laundry charge — so item-level
   * coding alone would leave uncoded precisely the lines a bookkeeper has to
   * sort out by hand. A line's own account still wins.
   */
  defaultAccountCode?: string | null;
}): XeroInvoicePayload {
  const lineItems = lines.map((line) => {
    // Trimmed rather than trusted: a code that is present but blank is the same
    // as no code, and sending `AccountCode: ""` is a rejection rather than a
    // no-op.
    const account = clean(line.account_code) ?? clean(defaultAccountCode);
    const item = clean(line.item_code);
    return {
      Description: line.description?.trim() || FALLBACK_DESCRIPTION,
      Quantity: toNumber(line.quantity),
      UnitAmount: toNumber(line.unit_price),
      TaxType: line.taxable === false ? TAX_TYPE_EXEMPT : TAX_TYPE_TAXABLE,
      ...(account ? { AccountCode: account } : {}),
      ...(item ? { ItemCode: item } : {}),
    };
  });

  const payload: XeroInvoicePayload = {
    Type: "ACCREC",
    Status: "AUTHORISED",
    LineAmountTypes: "Exclusive",
    Contact: buildContact(customer),
    InvoiceNumber: invoice.invoice_number,
    Reference: invoice.purchase_order_number || invoice.invoice_number,
    LineItems: lineItems,
  };

  // Xero wants YYYY-MM-DD and infers today if a date is missing, which is
  // wrong for an invoice issued last week — so send what we have and omit
  // rather than invent.
  if (invoice.issue_date) payload.Date = invoice.issue_date;
  if (invoice.due_date) payload.DueDate = invoice.due_date;

  return payload;
}

/**
 * Whether an invoice may be pushed at all.
 *
 * Draft and void never go: a draft has not been agreed with anybody, and a void
 * one is a record of something that is not owed. Both are the app's own states,
 * checked here so the two callers (issuing, and the manual retry) cannot
 * disagree about it.
 */
export function canPushToXero(status: string): boolean {
  return status !== "draft" && status !== "void" && status !== "voided";
}
