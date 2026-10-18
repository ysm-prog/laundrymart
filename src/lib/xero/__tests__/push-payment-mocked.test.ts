import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeQuery } from "@/test-support/fake-supabase";

/**
 * Posting a payment to a mocked Xero (Darshan's brief, ground rule 5). The one
 * property worth a mocked request rather than a pure test: a payment goes out
 * with its own id as Xero's `Idempotency-Key`, so a retry after a timeout —
 * where the first attempt may in fact have landed — cannot post the money twice.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {} }));

const mocks = vi.hoisted(() => ({
  getXeroTokens: vi.fn(),
  bankAccount: { value: "090" as string | null },
}));
vi.mock("@/lib/xero/tokens", () => ({ getXeroTokens: mocks.getXeroTokens }));
vi.mock("@/lib/supabase/admin", async () => {
  const { fakeSupabase: fake } = await import("@/test-support/fake-supabase");
  return {
    createAdminClient: () => fake({
      xero_connections: () => [{ payment_account_code: mocks.bankAccount.value }],
    }).client,
  };
});

import { pushPaymentToXero } from "@/lib/xero/push-payment";
import type { SupabaseClient } from "@supabase/supabase-js";

const TENANT = "10000000-0000-4000-8000-000000000001";
const PAYMENT = "30000000-0000-4000-8000-000000000003";

function database(payment: Record<string, unknown> = {}, xeroInvoiceId: string | null = "xero-inv-1") {
  return fakeSupabase({
    payments: (query: FakeQuery) => query.op === "select" ? [{
      id: PAYMENT, invoice_id: "inv-1", amount: "74.80", paid_on: "2026-10-18",
      method: "eft", reference: null, xero_payment_id: null, ...payment,
    }] : null,
    invoices: () => [{ xero_invoice_id: xeroInvoiceId }],
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  mocks.getXeroTokens.mockResolvedValue({ accessToken: "t", xeroTenantId: "org", xeroTenantName: null });
  mocks.bankAccount.value = "090";
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ Payments: [{ PaymentID: "xero-pay-1" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("posting a payment to a mocked Xero", () => {
  it("posts against the Xero invoice, into the chosen bank account, with its own id as the idempotency key", async () => {
    const db = database();
    const outcome = await pushPaymentToXero(db.client as SupabaseClient, PAYMENT, TENANT);

    expect(outcome).toEqual({ ok: true, xeroPaymentId: "xero-pay-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.xero.com/api.xro/2.0/Payments");
    expect((init as RequestInit & { headers: Record<string, string> }).headers["Idempotency-Key"]).toBe(PAYMENT);
    const sent = JSON.parse(String((init as RequestInit).body)).Payments[0];
    expect(sent).toMatchObject({
      Invoice: { InvoiceID: "xero-inv-1" }, Account: { Code: "090" }, Date: "2026-10-18", Amount: 74.8,
    });
    expect(db.writes("payments").at(-1)!.values).toMatchObject({ xero_payment_id: "xero-pay-1" });
  });

  it("does not repost a payment Xero already has", async () => {
    await pushPaymentToXero(database({ xero_payment_id: "xero-pay-1" }).client as SupabaseClient, PAYMENT, TENANT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing while the invoice is not in Xero or no bank account is chosen", async () => {
    await pushPaymentToXero(database({}, null).client as SupabaseClient, PAYMENT, TENANT);
    mocks.bankAccount.value = null;
    await pushPaymentToXero(database().client as SupabaseClient, PAYMENT, TENANT);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
