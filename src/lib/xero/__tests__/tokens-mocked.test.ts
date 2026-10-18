import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, filteredOn, type FakeQuery } from "@/test-support/fake-supabase";

/**
 * Refreshing a laundry's Xero tokens against a mocked identity server
 * (Darshan's brief, ground rule 5). `fetch` and the service-role client are
 * replaced, so no token ever leaves the test. The two rules worth a mocked
 * request: a token is refreshed a minute *before* it dies, and Xero's rotated
 * refresh token is what gets stored — keeping the old one is what makes the
 * next refresh fail.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  env: { XERO_CLIENT_ID: "client-id", XERO_CLIENT_SECRET: "client-secret" } as Record<string, string | undefined>,
  row: null as null | Record<string, unknown>,
  db: null as null | ReturnType<typeof import("@/test-support/fake-supabase").fakeSupabase>,
}));

vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db!.client }));

import { getXeroTokens } from "@/lib/xero/tokens";

const TENANT = "10000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-10-18T08:00:00Z");

function connection(expiresInMs: number) {
  mocks.row = {
    tenant_id: TENANT, xero_tenant_id: "org", xero_tenant_name: "ATS (test)",
    access_token: "old-access", refresh_token: "old-refresh",
    expires_at: new Date(NOW + expiresInMs).toISOString(),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.env.XERO_CLIENT_ID = "client-id";
  mocks.env.XERO_CLIENT_SECRET = "client-secret";
  mocks.db = fakeSupabase({
    xero_connections: (query: FakeQuery) => (query.op === "select" ? (mocks.row ? [mocks.row] : []) : null),
  });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({
    access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800,
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.row = null;
});

describe("Xero tokens against a mocked identity server", () => {
  it("uses a token with more than a minute left without calling Xero", async () => {
    connection(5 * 60_000);
    expect(await getXeroTokens(TENANT)).toEqual({
      accessToken: "old-access", xeroTenantId: "org", xeroTenantName: "ATS (test)",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(filteredOn(mocks.db!.queries[0]!, "tenant_id", TENANT)).toBe(true);
  });

  it("refreshes a token with under a minute left, and stores the rotated refresh token", async () => {
    connection(30_000);
    const tokens = await getXeroTokens(TENANT);
    expect(tokens?.accessToken).toBe("new-access");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://identity.xero.com/connect/token");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    const form = new URLSearchParams(String((init as RequestInit).body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("old-refresh");

    const write = mocks.db!.writes("xero_connections").at(-1)!;
    expect(write.values).toEqual({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_at: new Date(NOW + 1800 * 1000).toISOString(),
    });
    expect(filteredOn(write, "tenant_id", TENANT)).toBe(true);
  });

  it("keeps the old refresh token when Xero does not send a new one", async () => {
    connection(-1);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: "new-access" }), { status: 200 }));
    await getXeroTokens(TENANT);
    expect(mocks.db!.writes("xero_connections").at(-1)!.values).toMatchObject({ refresh_token: "old-refresh" });
  });

  it("answers null, and stores nothing, when Xero refuses the refresh", async () => {
    connection(-1);
    fetchMock.mockResolvedValue(new Response("invalid_grant", { status: 400 }));
    expect(await getXeroTokens(TENANT)).toBeNull();
    expect(mocks.db!.writes("xero_connections")).toHaveLength(0);
  });

  it("answers null without a query or a request when the laundry has not connected", async () => {
    expect(await getXeroTokens(TENANT)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers null without touching anything when the deployment has no Xero credentials", async () => {
    mocks.env.XERO_CLIENT_SECRET = undefined;
    connection(-1);
    expect(await getXeroTokens(TENANT)).toBeNull();
    expect(mocks.db!.queries).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
