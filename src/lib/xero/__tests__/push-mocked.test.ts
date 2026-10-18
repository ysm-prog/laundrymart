import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, filteredOn, type FakeQuery } from "@/test-support/fake-supabase";

/**
 * The Xero invoice push, driven end to end with Xero mocked out (Darshan's
 * brief, ground rule 5 and section 5 step 6). `fetch` is stubbed, so nothing
 * here can reach a real Xero; the tokens, the service-role client and the
 * account pre-flight are replaced at the module boundary.
 *
 * What the pure tests over `buildInvoicePayload` cannot show, and these do:
 * that the request the push *actually sends* says `LineAmountTypes: Inclusive`
 * and carries the right account per line through the real database shape, and
 * that every reason for not sending really sends nothing.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {} }));

const mocks = vi.hoisted(() => ({
  getXeroTokens: vi.fn(),
  loadUsedAccounts: vi.fn(),
  salesAccount: { value: "200" as string | null },
}));

vi.mock("@/lib/xero/tokens", () => ({ getXeroTokens: mocks.getXeroTokens }));
vi.mock("@/lib/xero/readiness", () => ({ loadUsedAccounts: mocks.loadUsedAccounts }));
vi.mock("@/lib/supabase/admin", async () => {
  const { fakeSupabase: fake } = await import("@/test-support/fake-supabase");
  return {
    createAdminClient: () => fake({
      xero_connections: () => [{ sales_account_code: mocks.salesAccount.value }],
    }).client,
  };
});

import { pushInvoiceToXero } from "@/lib/xero/push";
import type { SupabaseClient } from "@supabase/supabase-js";

const TENANT = "10000000-0000-4000-8000-000000000001";
const INVOICE = "20000000-0000-4000-8000-000000000002";

type InvoiceOverrides = Partial<{ status: string; source: string; xero_invoice_id: string | null }>;

function database(overrides: InvoiceOverrides = {}) {
  return fakeSupabase({
    invoices: (query: FakeQuery) => query.op === "select" ? [{
      id: INVOICE, tenant_id: TENANT, status: "issued", source: "app",
      customer_id: "c1", invoice_number: "INV00042", issue_date: "2026-10-18",
      due_date: "2026-11-01", purchase_order_number: null, notes: null, xero_invoice_id: null,
      ...overrides,
    }] : null,
    customers: (query: FakeQuery) => query.op === "select" ? [{
      business_name: "Acme Cafe", trading_name: null, billing_email: "accounts@acme.example",
      xero_contact_id: null, xero_contact_name: null, billing_address_line1: null,
      billing_address_line2: null, billing_suburb: null, billing_state: null, billing_postcode: null,
    }] : null,
    invoice_lines: () => [
      // Coded on the line itself, and its item points somewhere else: the line wins.
      { description: "Towels - Black × 40", quantity: 40, unit_price: 0.22, taxable: true,
        items: { xero_item_code: "TW", gl_accounts: { xero_account_code: "201" } },
        gl_accounts: { xero_account_code: "210" } },
      // Only its item is coded: the item's account travels.
      { description: "Sheets × 10", quantity: 10, unit_price: 1.1, taxable: true,
        items: [{ xero_item_code: null, gl_accounts: [{ xero_account_code: "220" }] }],
        gl_accounts: null },
      // Nothing coded and GST-free: the laundry's default sales account.
      { description: "Delivery", quantity: 1, unit_price: 5, taxable: false,
        items: null, gl_accounts: null },
    ],
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  mocks.getXeroTokens.mockResolvedValue({
    accessToken: "access-token", xeroTenantId: "xero-org-1", xeroTenantName: "ATS (test)",
  });
  mocks.loadUsedAccounts.mockResolvedValue([]);
  mocks.salesAccount.value = "200";
  fetchMock.mockResolvedValue(new Response(JSON.stringify({
    Invoices: [{ InvoiceID: "xero-inv-1", Contact: { ContactID: "xero-contact-1" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function sentPayload() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url: String(url), init: init as RequestInit, body: JSON.parse(String((init as RequestInit).body)) };
}

describe("pushing an issued invoice to a mocked Xero", () => {
  it("sends one ACCREC invoice, GST-inclusive, to the connected organisation", async () => {
    const db = database();
    const outcome = await pushInvoiceToXero(db.client as SupabaseClient, INVOICE, TENANT);

    expect(outcome).toEqual({ ok: true, xeroInvoiceId: "xero-inv-1", contactId: "xero-contact-1" });
    const { url, init, body } = sentPayload();
    expect(url).toBe("https://api.xero.com/api.xro/2.0/Invoices");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-token");
    expect(headers["Xero-tenant-id"]).toBe("xero-org-1");

    const invoice = body.Invoices[0];
    expect(invoice.Type).toBe("ACCREC");
    expect(invoice.LineAmountTypes).toBe("Inclusive");
    expect(invoice.InvoiceNumber).toBe("INV00042");
    expect(invoice.Contact.Name).toBe("Acme Cafe");
  });

  it("codes each line: its own account, then its item's, then the laundry's default", async () => {
    await pushInvoiceToXero(database().client as SupabaseClient, INVOICE, TENANT);
    const lines = sentPayload().body.Invoices[0].LineItems;
    expect(lines.map((line: { AccountCode?: string }) => line.AccountCode)).toEqual(["210", "220", "200"]);
    expect(lines[0].ItemCode).toBe("TW");
    expect(lines[1].ItemCode).toBeUndefined();
    expect(lines[2].TaxType).not.toBe(lines[0].TaxType);
  });

  it("records the Xero id on the invoice and remembers the contact", async () => {
    const db = database();
    await pushInvoiceToXero(db.client as SupabaseClient, INVOICE, TENANT);

    const invoiceWrite = db.writes("invoices").at(-1)!;
    expect(invoiceWrite.values).toMatchObject({ xero_invoice_id: "xero-inv-1", xero_push_error: null });
    expect(filteredOn(invoiceWrite, "tenant_id", TENANT)).toBe(true);
    expect(db.writes("customers")[0]!.values).toEqual({ xero_contact_id: "xero-contact-1" });
  });

  it("reads every row through the tenant (§23)", async () => {
    const db = database();
    await pushInvoiceToXero(db.client as SupabaseClient, INVOICE, TENANT);
    for (const query of db.queries) expect(filteredOn(query, "tenant_id", TENANT)).toBe(true);
  });

  it("turns a retry into an update by carrying the Xero id", async () => {
    await pushInvoiceToXero(database({ xero_invoice_id: "xero-inv-1" }).client as SupabaseClient, INVOICE, TENANT);
    expect(sentPayload().body.Invoices[0].InvoiceID).toBe("xero-inv-1");
  });

  it("writes Xero's own reason on the invoice when Xero refuses it", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      Elements: [{ ValidationErrors: [{ Message: "Account code '210' is not a valid code" }] }],
    }), { status: 400 }));
    const db = database();
    const outcome = await pushInvoiceToXero(db.client as SupabaseClient, INVOICE, TENANT);

    expect(outcome.ok).toBe(false);
    expect(db.writes("invoices").at(-1)!.values).toEqual({
      xero_push_error: "Xero refused the invoice (400). Account code '210' is not a valid code",
    });
  });
});

describe("the reasons nothing is sent", () => {
  it("never sends an invoice imported from MYOB", async () => {
    const db = database({ source: "import" });
    const outcome = await pushInvoiceToXero(db.client as SupabaseClient, INVOICE, TENANT);
    expect(outcome).toMatchObject({ ok: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.writes("invoices")).toHaveLength(0);
  });

  it("never sends a draft or a void", async () => {
    for (const status of ["draft", "void"]) {
      const db = database({ status });
      await pushInvoiceToXero(db.client as SupabaseClient, INVOICE, TENANT);
      expect(db.writes("invoices")).toHaveLength(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing, and says nothing failed, when the laundry is not connected", async () => {
    mocks.getXeroTokens.mockResolvedValue(null);
    const db = database();
    const outcome = await pushInvoiceToXero(db.client as SupabaseClient, INVOICE, TENANT);
    expect(outcome).toMatchObject({ ok: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.writes("invoices")).toHaveLength(0);
  });

  it("holds the push while an account in use has no Xero code, and says so on the invoice", async () => {
    mocks.loadUsedAccounts.mockResolvedValue([
      { id: "a1", code: "4-1100", name: "Towels - Black", xeroAccountCode: null, usedBy: ["items"] },
    ]);
    const db = database();
    const outcome = await pushInvoiceToXero(db.client as SupabaseClient, INVOICE, TENANT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    const recorded = db.writes("invoices").at(-1)!.values as { xero_push_error: string };
    expect(recorded.xero_push_error).toMatch(/Account 4-1100 .* not set up in Xero/);
  });
});
