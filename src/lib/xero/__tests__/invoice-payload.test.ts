import { describe, expect, it } from "vitest";
import {
  resolveAccountCode,
  buildContact, buildInvoicePayload, canPushToXero, payloadTotal,
  TAX_TYPE_EXEMPT, TAX_TYPE_TAXABLE,
} from "@/lib/xero/invoice-payload";

const CUSTOMER = {
  business_name: "Cafe A",
  trading_name: null,
  billing_email: "accounts@cafea.com.au",
  xero_contact_id: null,
  xero_contact_name: null,
  billing_address_line1: "1 Rundle Mall",
  billing_address_line2: null,
  billing_suburb: "Adelaide",
  billing_state: "SA",
  billing_postcode: "5000",
};

const INVOICE = {
  invoice_number: "INV00042",
  issue_date: "2026-08-01",
  due_date: "2026-08-31",
  purchase_order_number: null,
  notes: null,
};

describe("buildContact", () => {
  it("uses the stored ContactID once we have one", () => {
    // The whole point of keeping xero_contact_id: the second invoice for a
    // customer must attach to the same Xero contact, not create a twin.
    const contact = buildContact({ ...CUSTOMER, xero_contact_id: "xero-abc" });
    expect(contact).toEqual({ ContactID: "xero-abc" });
    expect(contact).not.toHaveProperty("Name");
  });

  it("falls back to the name and email on the first push", () => {
    const contact = buildContact(CUSTOMER);
    expect(contact.Name).toBe("Cafe A");
    expect(contact.EmailAddress).toBe("accounts@cafea.com.au");
  });

  it("prefers an explicit xero_contact_name when the books call them something else", () => {
    expect(buildContact({ ...CUSTOMER, xero_contact_name: "Cafe A Pty Ltd" }).Name)
      .toBe("Cafe A Pty Ltd");
  });

  it("sends an address only when there is one", () => {
    const withAddress = buildContact(CUSTOMER) as { Addresses?: Record<string, unknown>[] };
    expect(withAddress.Addresses?.[0]).toMatchObject({
      AddressType: "STREET", AddressLine1: "1 Rundle Mall",
      City: "Adelaide", Region: "SA", PostalCode: "5000", Country: "Australia",
    });

    // An object full of nulls is worse than no object.
    const none = buildContact({ ...CUSTOMER, billing_address_line1: null });
    expect(none).not.toHaveProperty("Addresses");
  });

  it("omits an address field it does not have rather than sending null", () => {
    const contact = buildContact({
      ...CUSTOMER, billing_suburb: null, billing_state: null, billing_postcode: null,
    }) as { Addresses: Record<string, unknown>[] };
    expect(contact.Addresses[0]).not.toHaveProperty("City");
    expect(contact.Addresses[0]).toHaveProperty("AddressLine1");
  });
});

describe("buildInvoicePayload", () => {
  const lines = [
    { description: "Bath Towel — White", quantity: 120, unit_price: 1.2, taxable: true },
    { description: "Fuel levy", quantity: 1, unit_price: 8.5, taxable: false },
  ];

  it("builds an authorised ACCREC invoice", () => {
    // AUTHORISED, not DRAFT: nothing reaches Xero until this app has issued it,
    // so pushing it as a Xero draft would put the two in different states.
    const payload = buildInvoicePayload({ invoice: INVOICE, lines, customer: CUSTOMER });
    expect(payload.Type).toBe("ACCREC");
    expect(payload.Status).toBe("AUTHORISED");
    expect(payload.InvoiceNumber).toBe("INV00042");
    expect(payload.Date).toBe("2026-08-01");
    expect(payload.DueDate).toBe("2026-08-31");
  });

  it("tells Xero the line amounts already include GST", () => {
    // The defect this pins: it said "Exclusive" while `recalculate_invoice`
    // computed inclusive totals (0043), so Xero was asked to add 10% on top of a
    // figure that already carried it — a $72.70 line billed here as $72.70 and
    // recorded there as $79.97.
    const payload = buildInvoicePayload({ invoice: INVOICE, lines, customer: CUSTOMER });
    expect(payload.LineAmountTypes).toBe("Inclusive");
  });

  it("comes to the same total Xero will, on the same arithmetic our invoice uses", () => {
    // The invariant behind the string above, and the reason it is a function
    // rather than a comment. Since 0043 our `invoices.total` is the plain sum of
    // the line amounts — the GST is taken *out* of that sum, never added to it —
    // and under `Inclusive` Xero totals its lines the same way. Under
    // `Exclusive` it would be that sum plus tax, which is a different document.
    const payload = buildInvoicePayload({ invoice: INVOICE, lines, customer: CUSTOMER });
    // 120 × 1.20 = 144.00 taxable, plus an 8.50 exempt levy.
    expect(payloadTotal(payload)).toBe(152.5);

    // And the GST is inside that, not on top: 144.00 inclusive holds 13.09.
    const gstInside = Math.round(144 * (0.1 / 1.1) * 100) / 100;
    expect(gstInside).toBe(13.09);
    expect(payloadTotal(payload)).toBe(152.5);
  });

  it("matches the migration's own worked example", () => {
    // 0043 asserts that $72.70 GST-inclusive holds $6.61 of tax. The payload has
    // to describe an invoice of $72.70, not one of $79.97.
    const payload = buildInvoicePayload({
      invoice: INVOICE,
      lines: [{ description: "Towels", quantity: 1, unit_price: 72.7, taxable: true }],
      customer: CUSTOMER,
    });
    expect(payloadTotal(payload)).toBe(72.7);
    expect(Math.round(72.7 * (0.1 / 1.1) * 100) / 100).toBe(6.61);
  });

  it("carries GST per line, from the line's own taxable flag", () => {
    const payload = buildInvoicePayload({ invoice: INVOICE, lines, customer: CUSTOMER });
    const items = payload.LineItems as Record<string, unknown>[];
    expect(items[0]?.TaxType).toBe(TAX_TYPE_TAXABLE);
    expect(items[1]?.TaxType).toBe(TAX_TYPE_EXEMPT);
  });

  it("reads numerics that PostgREST returned as strings", () => {
    // `numeric(12,2)` comes back as a string over the wire. Sending "1.20" as a
    // UnitAmount is the kind of thing that works until Xero tightens a parser.
    const payload = buildInvoicePayload({
      invoice: INVOICE, customer: CUSTOMER,
      lines: [{ description: "X", quantity: "3", unit_price: "1.25", taxable: true }],
    });
    const item = (payload.LineItems as Record<string, unknown>[])[0];
    expect(item?.Quantity).toBe(3);
    expect(item?.UnitAmount).toBe(1.25);
  });

  it("keeps a zero-priced line instead of dropping it", () => {
    // An included allowance or a goodwill replacement is a real line. Dropping
    // it would make Xero's total disagree with ours for a reason nobody could
    // see on either screen.
    const payload = buildInvoicePayload({
      invoice: INVOICE, customer: CUSTOMER,
      lines: [{ description: "Included allowance", quantity: 20, unit_price: 0, taxable: true }],
    });
    expect((payload.LineItems as unknown[]).length).toBe(1);
  });

  it("never sends a line with no description", () => {
    const payload = buildInvoicePayload({
      invoice: INVOICE, customer: CUSTOMER,
      lines: [{ description: "  ", quantity: 1, unit_price: 5, taxable: true }],
    });
    expect((payload.LineItems as Record<string, unknown>[])[0]?.Description).toBeTruthy();
  });

  it("uses the customer's purchase order as the reference when they gave one", () => {
    // What a customer's accounts payable matches on. Falls back to our own
    // number so Reference is never empty.
    expect(buildInvoicePayload({
      invoice: { ...INVOICE, purchase_order_number: "PO-991" }, lines, customer: CUSTOMER,
    }).Reference).toBe("PO-991");

    expect(buildInvoicePayload({ invoice: INVOICE, lines, customer: CUSTOMER }).Reference)
      .toBe("INV00042");
  });

  it("omits a date it does not have rather than letting Xero invent today", () => {
    const payload = buildInvoicePayload({
      invoice: { ...INVOICE, issue_date: null, due_date: null }, lines, customer: CUSTOMER,
    });
    expect(payload).not.toHaveProperty("Date");
    expect(payload).not.toHaveProperty("DueDate");
  });

  it("codes a line to a GL account only when one is set", () => {
    const [coded] = buildInvoicePayload({
      invoice: INVOICE, customer: CUSTOMER,
      lines: [{ description: "X", quantity: 1, unit_price: 1, taxable: true, account_code: "200" }],
    }).LineItems as Record<string, unknown>[];
    expect(coded?.AccountCode).toBe("200");

    const [uncoded] = buildInvoicePayload({
      invoice: INVOICE, customer: CUSTOMER,
      lines: [{ description: "X", quantity: 1, unit_price: 1, taxable: true }],
    }).LineItems as Record<string, unknown>[];
    expect(uncoded).not.toHaveProperty("AccountCode");
  });
});

describe("canPushToXero", () => {
  it("refuses a draft and a void, allows the rest", () => {
    // A draft has been agreed with nobody; a void is a record of something that
    // is not owed. Checked here so the issue path and the manual retry cannot
    // disagree about it.
    expect(canPushToXero("draft")).toBe(false);
    expect(canPushToXero("void")).toBe(false);
    expect(canPushToXero("voided")).toBe(false);
    for (const status of ["issued", "part_paid", "overdue", "paid"]) {
      expect(canPushToXero(status), status).toBe(true);
    }
  });
});

describe("coding a line to Xero (0037)", () => {
  const line = (over: Record<string, unknown> = {}) => ({
    description: "Bath towels", quantity: 10, unit_price: 2, taxable: true, ...over,
  });
  const build = (lines: ReturnType<typeof line>[], defaultAccountCode?: string | null) =>
    buildInvoicePayload({
      invoice: INVOICE, customer: CUSTOMER, lines, defaultAccountCode,
    }).LineItems as Array<Record<string, unknown>>;

  it("sends neither code when nothing has been coded", () => {
    // The property that matters most: a laundry that has filled none of this in
    // must push exactly the payload it pushed before. `AccountCode` was already
    // in this mapping and had never once been populated, so "unchanged" is the
    // only safe default.
    const [item] = build([line()]);
    expect(item).not.toHaveProperty("AccountCode");
    expect(item).not.toHaveProperty("ItemCode");
  });

  it("sends the line's own account and the item code", () => {
    const [item] = build([line({ account_code: "200", item_code: "TOW001" })]);
    expect(item!.AccountCode).toBe("200");
    expect(item!.ItemCode).toBe("TOW001");
  });

  it("sends the item's account when the line itself is not coded", () => {
    const [item] = build([line({ item_account_code: "260", item_code: "TOW001" })]);
    expect(item!.AccountCode).toBe("260");
    expect(item!.ItemCode).toBe("TOW001");
  });

  it("falls back to the laundry's default account for a line with no item", () => {
    // A fuel levy or a contract minimum carries no item at all, and those are
    // exactly the lines a bookkeeper would otherwise re-code by hand.
    const [item] = build([line()], "200");
    expect(item!.AccountCode).toBe("200");
    expect(item).not.toHaveProperty("ItemCode");
  });

  it("lets the line's own account beat both the item's and the default", () => {
    // The defect this precedence exists to prevent: somebody codes one line
    // deliberately, and the item's standing account is sent instead. Nobody
    // finds out until a bookkeeper reconciles.
    const [item] = build([line({ account_code: "260", item_account_code: "200" })], "700");
    expect(item!.AccountCode).toBe("260");
  });

  it("lets the item's account beat the default", () => {
    const [item] = build([line({ item_account_code: "200" })], "700");
    expect(item!.AccountCode).toBe("200");
  });

  it("falls past a blank tier to the next real one", () => {
    // A blank is not a choice. A line whose account was cleared must fall to the
    // item, not to nothing — otherwise clearing a code silently uncodes the line.
    const [item] = build([line({ account_code: "  ", item_account_code: "200" })], "700");
    expect(item!.AccountCode).toBe("200");
  });

  it("treats a blank code as no code rather than sending an empty one", () => {
    // Xero rejects `AccountCode: ""`, so a column that is present and empty
    // must not become a payload key — otherwise one stray space in a form field
    // fails every invoice for that item.
    const [item] = build([line({ account_code: "   ", item_account_code: " ", item_code: "" })], "  ");
    expect(item).not.toHaveProperty("AccountCode");
    expect(item).not.toHaveProperty("ItemCode");
  });

  it("codes each line on its own, not the invoice as a whole", () => {
    const items = build([
      line({ account_code: "200", item_code: "TOW001" }),
      line({ description: "Fuel levy" }),
    ], "260");
    expect(items[0]!.AccountCode).toBe("200");
    expect(items[0]!.ItemCode).toBe("TOW001");
    expect(items[1]!.AccountCode).toBe("260");
    expect(items[1]).not.toHaveProperty("ItemCode");
  });

  it("leaves everything else about the line exactly as it was", () => {
    const [item] = build([line({ account_code: "200", item_code: "TOW001" })]);
    expect(item!.Description).toBe("Bath towels");
    expect(item!.Quantity).toBe(10);
    expect(item!.UnitAmount).toBe(2);
    expect(item!.TaxType).toBe(TAX_TYPE_TAXABLE);
  });
});

describe("resolveAccountCode", () => {
  it("prefers the line, then the item, then the laundry's default", () => {
    expect(resolveAccountCode({ line: "1", item: "2", fallback: "3" })).toBe("1");
    expect(resolveAccountCode({ line: null, item: "2", fallback: "3" })).toBe("2");
    expect(resolveAccountCode({ line: null, item: null, fallback: "3" })).toBe("3");
  });

  it("answers null when no tier has been filled in", () => {
    // The property that keeps this safe to ship: a laundry that has coded
    // nothing sends no AccountCode at all, which is exactly the payload that
    // went before any of this existed.
    expect(resolveAccountCode({})).toBeNull();
    expect(resolveAccountCode({ line: null, item: undefined, fallback: null })).toBeNull();
  });

  it("does not let a blank stand in for a real code", () => {
    expect(resolveAccountCode({ line: "", item: "2" })).toBe("2");
    expect(resolveAccountCode({ line: "   ", item: "\t", fallback: "3" })).toBe("3");
    expect(resolveAccountCode({ line: " ", item: " ", fallback: " " })).toBeNull();
  });

  it("trims what it returns, because Xero matches on the exact string", () => {
    expect(resolveAccountCode({ line: "  200  " })).toBe("200");
  });
});
