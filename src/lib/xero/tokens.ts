import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { XERO_TOKEN_URL, xeroConfig } from "./config";

/**
 * Loading, refreshing and storing one laundry's Xero tokens.
 *
 * **Service-role only, and that is the design.** `xero_connections` grants
 * `authenticated` nothing and carries no policy for it (0026), so every read
 * here goes through the admin client — which means every function in this file
 * must filter `tenant_id` itself, the rule §2 states for the admin client
 * everywhere. There is no screen that receives a token; the Settings page reads
 * `xero_connection_status()` instead.
 */

export type XeroTokens = {
  accessToken: string;
  xeroTenantId: string;
  xeroTenantName: string | null;
};

type Row = {
  tenant_id: string;
  xero_tenant_id: string;
  xero_tenant_name: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

/**
 * Refresh a minute early.
 *
 * A token that passes the check and then expires during the round trip fails
 * the push for no reason a person could act on, and the retry would succeed —
 * which is the most confusing kind of intermittent.
 */
const EXPIRY_SKEW_MS = 60_000;

/** Basic auth header, which is how Xero wants the client credentials. */
function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * A usable access token for this laundry, refreshed if it is about to die.
 *
 * Returns null when the laundry has not connected Xero, so callers can say so
 * plainly rather than treating "never connected" as a failure.
 */
export async function getXeroTokens(tenantId: string): Promise<XeroTokens | null> {
  const config = xeroConfig();
  if (!config) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("xero_connections")
    .select("tenant_id, xero_tenant_id, xero_tenant_name, access_token, refresh_token, expires_at")
    .eq("tenant_id", tenantId)
    .maybeSingle<Row>();

  if (!data) return null;

  const expiresAt = Date.parse(data.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return {
      accessToken: data.access_token,
      xeroTenantId: data.xero_tenant_id,
      xeroTenantName: data.xero_tenant_name,
    };
  }

  const response = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config.clientId, config.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: data.refresh_token,
    }),
  });

  if (!response.ok) {
    // A dead refresh token means somebody revoked the connection in Xero, or it
    // went unused past its 60-day life. Nothing here can fix that, and silently
    // clearing the row would hide it — the screen reports "reconnect".
    return null;
  }

  const json = await response.json() as {
    access_token: string; refresh_token?: string; expires_in?: number;
  };

  const refreshed = {
    access_token: json.access_token,
    // Xero rotates the refresh token on every use. Keeping the old one on a
    // response that omitted it is what makes the *next* refresh fail.
    refresh_token: json.refresh_token ?? data.refresh_token,
    expires_at: new Date(Date.now() + (json.expires_in ?? 1800) * 1000).toISOString(),
  };

  await admin.from("xero_connections").update(refreshed).eq("tenant_id", tenantId);

  return {
    accessToken: refreshed.access_token,
    xeroTenantId: data.xero_tenant_id,
    xeroTenantName: data.xero_tenant_name,
  };
}

/** Exchange the callback's `code` for tokens. Returns null on any refusal. */
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<{
  accessToken: string; refreshToken: string; expiresAt: string;
} | null> {
  const config = xeroConfig();
  if (!config) return null;

  const response = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config.clientId, config.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) return null;

  const json = await response.json() as {
    access_token: string; refresh_token: string; expires_in?: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 1800) * 1000).toISOString(),
  };
}

/** Store (or replace) a laundry's connection. Service role, tenant explicit. */
export async function saveXeroConnection(input: {
  tenantId: string;
  xeroTenantId: string;
  xeroTenantName: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  connectedBy: string;
}): Promise<string | null> {
  const admin = createAdminClient();
  const { error } = await admin.from("xero_connections").upsert({
    tenant_id: input.tenantId,
    xero_tenant_id: input.xeroTenantId,
    xero_tenant_name: input.xeroTenantName,
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    expires_at: input.expiresAt,
    connected_by: input.connectedBy,
  }, { onConflict: "tenant_id" });
  return error ? error.message : null;
}

/** Forget a laundry's connection. The tokens are simply gone. */
export async function deleteXeroConnection(tenantId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { error } = await admin.from("xero_connections").delete().eq("tenant_id", tenantId);
  return error ? error.message : null;
}
