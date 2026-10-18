import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, filteredOn, type FakeQuery } from "@/test-support/fake-supabase";

/**
 * Voiding an invoice in a mocked Xero (Darshan's brief, ground rule 5). `fetch`
 * is stubbed, so nothing here can reach a real Xero. What a pure test over
 * `voidGate` cannot show: that the request really goes to the invoice's own URL
 * as `VOIDED`, that a 200 which did *not* void is recorded as a failure rather
 * than a success, and that each reason for not sending really sends nothing.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {} }));

const mocks = vi.hoisted(() => ({ getXeroTokens: vi.fn() }));
vi.mock("@/lib/xero/tokens", () => ({ getXeroTokens: mocks.getXeroTokens }));

import { pushVoidToXero } from "@/lib/xero/push-void";
import type { SupabaseClient } from "@supabase/supabase-js";

const TENANT = "10000000-0000-4000-8000-000000000001";
const INVOICE = "20000000-0000-4000-8000-000000000002";

function database(
  invoice: Partial<{ xero_invoice_id: string | null; xero_status: string | null }> = {},
  payments: Array<{ xero_payment_id: string | null }> = [],
) {
  return fakeSupabase({
    invoices: (query: FakeQuery) => query.op === "select"
      ? [{ id: INVOICE, xero_invoice_id: "xero-inv-1", xero_status: "AUTHORISED", ...invoice }]
      : null,
    payments: () => payments,
  });
}

function xeroAnswers(status: string, code = 200) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ Invoices: [{ Status: status }] }), { status: code }));
}

const fetchMock = vi.fn();

beforeEach(() => {
  mocks.getXeroTokens.mockResolvedValue({ accessToken: "t", xeroTenantId: "org", xeroTenantName: null });
  xeroAnswers("VOIDED");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("voiding an invoice in a mocked Xero", () => {
  it("posts VOIDED to the invoice's own URL and records it once Xero confirms", async () => {
    const db = database();
    expect(await pushVoidToXero(db.client as SupabaseClient, INVOICE, TENANT)).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.xero.com/api.xro/2.0/Invoices/xero-inv-1");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer t");
    expect(headers["Xero-tenant-id"]).toBe("org");
    expect(JSON.parse(String((init as RequestInit).body)).Invoices[0]).toMatchObject({
      InvoiceID: "xero-inv-1", Status: "VOIDED",
    });

    const write = db.writes("invoices").at(-1)!;
    expect(write.values).toMatchObject({ xero_status: "VOIDED", xero_push_error: null });
    for (const query of db.queries) expect(filteredOn(query, "tenant_id", TENANT)).toBe(true);
  });

  it("records a 200 that did not void as a failure, naming the state Xero reported", async () => {
    xeroAnswers("AUTHORISED");
    const db = database();
    const outcome = await pushVoidToXero(db.client as SupabaseClient, INVOICE, TENANT);

    expect(outcome.ok).toBe(false);
    const recorded = db.writes("invoices").at(-1)!.values as { xero_push_error: string; xero_status?: string };
    expect(recorded.xero_push_error).toMatch(/invoice is AUTHORISED there, not voided/);
    expect(recorded.xero_status).toBeUndefined();
  });

  it("writes Xero's own refusal on the invoice", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      Elements: [{ ValidationErrors: [{ Message: "Invoice not of valid status for modification" }] }],
    }), { status: 400 }));
    const db = database();
    await pushVoidToXero(db.client as SupabaseClient, INVOICE, TENANT);
    expect(db.writes("invoices").at(-1)!.values).toEqual({
      xero_push_error: "Xero refused to void the invoice (400). Invoice not of valid status for modification",
    });
  });
});

describe("the reasons no void is sent", () => {
  it("sends nothing, and records nothing, for an invoice that never reached Xero or is already void there", async () => {
    for (const invoice of [{ xero_invoice_id: null }, { xero_status: "VOIDED" }]) {
      const db = database(invoice);
      const outcome = await pushVoidToXero(db.client as SupabaseClient, INVOICE, TENANT);
      expect(outcome).toMatchObject({ ok: false, skipped: true });
      expect(db.writes("invoices")).toHaveLength(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an invoice with a payment in Xero before asking, and says to raise a credit note", async () => {
    const db = database({}, [{ xero_payment_id: "xero-pay-1" }]);
    const outcome = await pushVoidToXero(db.client as SupabaseClient, INVOICE, TENANT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, skipped: false });
    expect((db.writes("invoices").at(-1)!.values as { xero_push_error: string }).xero_push_error)
      .toMatch(/credit note/);
  });

  it("sends nothing when the laundry is not connected", async () => {
    mocks.getXeroTokens.mockResolvedValue(null);
    const db = database();
    expect(await pushVoidToXero(db.client as SupabaseClient, INVOICE, TENANT))
      .toMatchObject({ ok: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.writes("invoices")).toHaveLength(0);
  });
});
