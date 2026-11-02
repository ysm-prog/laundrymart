import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, filteredOn, type FakeQuery } from "@/test-support/fake-supabase";

/**
 * Emailing an invoice, with the email transport mocked out (Darshan's brief,
 * ground rule 5). The PDF renderer and the message builder are replaced too,
 * because what is under test is the *flow* `sendInvoice` owns — the rules about
 * when an invoice may leave the building and what moves once it has — not the
 * layout, which the PDF and email tests cover on their own.
 */

const mocks = vi.hoisted(() => ({
  invoice: null as null | { status: string },
  sendEmail: vi.fn(),
  sendSms: vi.fn(),
  recordAudit: vi.fn(),
  logOrderActivity: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/actions", () => ({ describeDbError: (error: { message: string }) => error.message }));
vi.mock("@/lib/orders/activity", () => ({ logOrderActivity: mocks.logOrderActivity }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/sms/send", () => ({ sendSms: mocks.sendSms }));
vi.mock("@/lib/invoices/link", () => ({ invoiceLink: () => "https://app.example/i/token" }));
vi.mock("@/lib/auth/request-origin", () => ({ requestOrigin: async () => "https://app.example" }));
vi.mock("@/lib/email/invoice-email", () => ({
  buildInvoiceEmail: () => ({ subject: "Invoice INV00042", html: "<p>hi</p>", text: "hi" }),
}));
vi.mock("@/lib/pdf/render", () => ({
  renderInvoicePdf: async () => Buffer.from("%PDF-1.7"),
  invoiceFileName: (number: string) => `${number}.pdf`,
}));
vi.mock("@/lib/pdf/invoice-data", () => ({
  loadInvoiceForPdf: async () => mocks.invoice && {
    invoice: { invoice_number: "INV00042", balance: 80.2, due_date: "2026-11-16", currency: "AUD", ...mocks.invoice },
    customer: { billing_email: "accounts@acme.example" },
    tenant: { name: "Harbour Linen Co" },
  },
}));

import { sendInvoice, sendInvoiceSms } from "@/lib/invoices/send";

const TENANT = "10000000-0000-4000-8000-000000000001";
const session = { tenantId: TENANT, userId: "u1", role: "super_admin" } as never;

function database(phones: { customer?: string | null; contacts?: string[]; stampFails?: boolean } = {}) {
  return fakeSupabase({
    invoice_source_jobs: () => [{ order_id: "job-1" }, { order_id: "job-2" }],
    invoices: (query: FakeQuery) => {
      if (query.op === "select") return [{ customer_id: "c1" }];
      return phones.stampFails ? { data: null, error: { message: "no such column" } } : null;
    },
    customers: () => [{ phone: phones.customer ?? null }],
    customer_contacts: () => (phones.contacts ?? []).map((phone) => ({ phone })),
    laundry_orders: (query: FakeQuery) => (query.op === "update" ? null : []),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.invoice = null;
});

describe("sending an invoice through a mocked mail provider", () => {
  it("never emails a draft — its lines can still change", async () => {
    mocks.invoice = { status: "draft" };
    const db = database();
    const result = await sendInvoice(db.client as never, session, "inv-1");
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/issue it before emailing/) });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(db.writes("laundry_orders")).toHaveLength(0);
  });

  it("never emails a void", async () => {
    mocks.invoice = { status: "void" };
    await sendInvoice(database().client as never, session, "inv-1");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("attaches the PDF, stamps where it went, and only then moves the jobs to sent", async () => {
    mocks.invoice = { status: "issued" };
    mocks.sendEmail.mockResolvedValue({ ok: true, id: "email-1" });
    const db = database();

    const result = await sendInvoice(db.client as never, session, "inv-1");

    expect(result).toEqual({ ok: true, invoiceNumber: "INV00042", recipient: "accounts@acme.example" });
    const message = mocks.sendEmail.mock.calls[0]![0];
    expect(message.to).toBe("accounts@acme.example");
    expect(message.attachments[0].filename).toBe("INV00042.pdf");

    const stamp = db.writes("invoices")[0]!;
    expect(stamp.values).toMatchObject({ emailed_to: "accounts@acme.example" });
    expect(filteredOn(stamp, "tenant_id", TENANT)).toBe(true);

    const moved = db.writes("laundry_orders")[0]!;
    expect(moved.values).toEqual({ billing_status: "invoice_sent" });
    expect(filteredOn(moved, "billing_status", "invoice_generated")).toBe(true);
    expect(mocks.logOrderActivity).toHaveBeenCalledTimes(2);
  });

  it("records a bounce and moves nothing when the provider refuses", async () => {
    mocks.invoice = { status: "issued" };
    mocks.sendEmail.mockResolvedValue({ ok: false, error: "Domain not verified" });
    const db = database();

    const result = await sendInvoice(db.client as never, session, "inv-1");

    expect(result).toEqual({ ok: false, invoiceNumber: "INV00042", error: "Domain not verified" });
    expect(mocks.recordAudit).toHaveBeenCalledWith(session, expect.objectContaining({ action: "send_failed" }));
    expect(db.writes("invoices")).toHaveLength(0);
    expect(db.writes("laundry_orders")).toHaveLength(0);
  });

  it("sends to a typed address instead of the billing email when one is given", async () => {
    mocks.invoice = { status: "issued" };
    mocks.sendEmail.mockResolvedValue({ ok: true, id: "email-2" });
    await sendInvoice(database().client as never, session, "inv-1", "  someone@acme.example ");
    expect(mocks.sendEmail.mock.calls[0]![0].to).toBe("someone@acme.example");
  });
});

describe("texting an invoice through a mocked provider", () => {
  it("never texts a draft or a void", async () => {
    for (const status of ["draft", "void"]) {
      mocks.invoice = { status };
      const result = await sendInvoiceSms(database({ customer: "0412 345 678" }).client as never, session, "inv-1");
      expect(result.ok).toBe(false);
    }
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("sends the link, stamps the mobile, and moves the jobs to sent", async () => {
    mocks.invoice = { status: "issued" };
    mocks.sendSms.mockResolvedValue({ ok: true, id: "sms-1" });
    const db = database({ customer: "0412 345 678" });

    const result = await sendInvoiceSms(db.client as never, session, "inv-1");

    expect(result).toEqual({ ok: true, invoiceNumber: "INV00042", recipient: "0412 345 678" });
    expect(mocks.sendSms).toHaveBeenCalledWith({
      to: "+61412345678",
      body: "Harbour Linen Co invoice INV00042 $80.20 due 16/11/2026: https://app.example/i/token",
    });
    const stamp = db.writes("invoices")[0]!;
    expect(stamp.values).toMatchObject({ sms_sent_to: "+61412345678" });
    expect(filteredOn(stamp, "tenant_id", TENANT)).toBe(true);
    expect(db.writes("laundry_orders")[0]!.values).toEqual({ billing_status: "invoice_sent" });
  });

  it("looks past a landline to a contact's mobile", async () => {
    mocks.invoice = { status: "issued" };
    mocks.sendSms.mockResolvedValue({ ok: true, id: "sms-2" });
    await sendInvoiceSms(
      database({ customer: "08 8365 7211", contacts: ["08 8000 0000", "0498 765 432"] }).client as never,
      session, "inv-1",
    );
    expect(mocks.sendSms.mock.calls[0]![0].to).toBe("+61498765432");
  });

  it("sends nothing to a customer with no mobile, and says so", async () => {
    mocks.invoice = { status: "issued" };
    const result = await sendInvoiceSms(database({ customer: "08 8365 7211" }).client as never, session, "inv-1");
    expect(result).toMatchObject({ ok: false, error: "this customer has no mobile number on file" });
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("refuses a typed number it cannot text rather than falling back to the record", async () => {
    mocks.invoice = { status: "issued" };
    const result = await sendInvoiceSms(
      database({ customer: "0412 345 678" }).client as never, session, "inv-1", "08 8365 7211",
    );
    expect(result).toMatchObject({ ok: false, error: "that is not an Australian mobile number" });
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("still reports a text that went when the stamp could not be written", async () => {
    mocks.invoice = { status: "issued" };
    mocks.sendSms.mockResolvedValue({ ok: true, id: "sms-3" });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = database({ customer: "0412 345 678", stampFails: true });

    const result = await sendInvoiceSms(db.client as never, session, "inv-1");

    expect(result.ok).toBe(true);
    expect(mocks.recordAudit).toHaveBeenCalledWith(session, expect.objectContaining({ action: "send" }));
    expect(db.writes("laundry_orders")).toHaveLength(1);
    quiet.mockRestore();
  });

  it("records a refused text and moves nothing", async () => {
    mocks.invoice = { status: "issued" };
    mocks.sendSms.mockResolvedValue({ ok: false, error: "The ClickSend account is out of credit." });
    const db = database({ customer: "0412 345 678" });

    const result = await sendInvoiceSms(db.client as never, session, "inv-1");

    expect(result.ok).toBe(false);
    expect(mocks.recordAudit).toHaveBeenCalledWith(session, expect.objectContaining({ action: "send_failed" }));
    expect(db.writes("invoices")).toHaveLength(0);
    expect(db.writes("laundry_orders")).toHaveLength(0);
  });
});
