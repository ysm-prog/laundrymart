import { describe, expect, it } from "vitest";
import { invoiceFileName, renderInvoicePdf } from "../render";
import { buildInvoiceEmail, escapeHtml } from "@/lib/email/invoice-email";
import type { InvoicePdfData } from "../invoice-data";

const data: InvoicePdfData = {
  tenant: { name: "Harbour Linen Co", abn: "51 824 753 556", gstRate: 0.1 },
  customer: {
    business_name: "Bondi Bistro",
    customer_number: "CUST00042",
    abn: "12 345 678 901",
    billing_email: "accounts@bondibistro.com.au",
    address: ["12 Campbell Parade", "Bondi Beach NSW 2026"],
  },
  invoice: {
    id: "8f14e45f-ceea-467a-9dfd-1a2b3c4d5e6f",
    invoice_number: "INV00042",
    status: "issued",
    issue_date: "2026-07-31",
    due_date: "2026-08-14",
    period_start: "2026-07-01",
    period_end: "2026-07-31",
    purchase_order_number: "PO-9912",
    payment_terms_days: 14,
    subtotal: 480,
    tax_amount: 48,
    total: 528,
    amount_paid: 100,
    balance: 428,
    currency: "AUD",
    notes: "Thanks for your business.",
  },
  lines: [
    { description: "Bath Towel — 400 × 2026-07-01 to 2026-07-31", charge_type: "rental",
      quantity: 400, unit_price: 0.55, amount: 220, taxable: true },
    { description: "Bulk wash — 260 kg over 4 collection(s)", charge_type: "weight_charge",
      quantity: 260, unit_price: 1, amount: 260, taxable: true },
  ],
};

describe("renderInvoicePdf", () => {
  it("renders a real PDF", async () => {
    const buffer = await renderInvoicePdf(data);
    // %PDF- magic bytes, and an %%EOF trailer: proof it is a complete document
    // and not a truncated stream.
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.subarray(-1024).toString("latin1")).toContain("%%EOF");
    expect(buffer.byteLength).toBeGreaterThan(1000);
  }, 30_000);

  it("renders an invoice with no lines rather than failing", async () => {
    const buffer = await renderInvoicePdf({ ...data, lines: [] });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30_000);
});

describe("invoiceFileName", () => {
  it("keeps the invoice number and strips anything path-unsafe", () => {
    expect(invoiceFileName("INV00042")).toBe("INV00042.pdf");
    expect(invoiceFileName("../../etc/passwd")).toBe("etcpasswd.pdf");
    expect(invoiceFileName("///")).toBe("invoice.pdf");
  });
});

describe("buildInvoiceEmail", () => {
  it("leads with the invoice number and the total", () => {
    const { subject } = buildInvoiceEmail(data);
    expect(subject).toContain("INV00042");
    expect(subject).toContain("528");
  });

  it("asks for the outstanding balance, not the total, when part paid", () => {
    const { text } = buildInvoiceEmail(data);
    expect(text).toContain("Amount due: $428.00");
    expect(text).toContain("Due date: 14/08/2026");
  });

  it("says nothing is owed once the invoice is settled", () => {
    const settled = { ...data, invoice: { ...data.invoice, amount_paid: 528, balance: 0 } };
    const { text, html } = buildInvoiceEmail(settled);
    expect(text).toContain("paid in full");
    expect(html).toContain("paid in full");
    expect(text).not.toContain("Amount due");
  });

  it("escapes customer names instead of injecting them as markup", () => {
    const hostile = {
      ...data,
      customer: { ...data.customer, business_name: "<script>alert(1)</script> & Co" },
    };
    const { html } = buildInvoiceEmail(hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; Co");
  });
});

describe("escapeHtml", () => {
  it("escapes every character that can break out of markup", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
