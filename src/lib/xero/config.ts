import { env } from "@/lib/env";

/**
 * Xero app credentials, and whether this deployment has any.
 *
 * Optional on the same principle as the mail provider (§10): a laundry that has
 * not connected Xero should have a working app and a screen that says so, not a
 * deployment that refuses to boot. A **partial** set counts as not configured —
 * half a credential pair produces an OAuth error whose message tells nobody
 * what is actually wrong.
 */
export type XeroConfig = { clientId: string; clientSecret: string };

export function xeroConfig(): XeroConfig | null {
  const clientId = env.XERO_CLIENT_ID;
  const clientSecret = env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export const XERO_API = "https://api.xero.com/api.xro/2.0";
export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";

/**
 * What we ask Xero for.
 *
 * `accounting.transactions` writes invoices, `accounting.contacts` creates and
 * matches the customer, `offline_access` is what makes a refresh token come
 * back at all — without it the connection dies in thirty minutes and somebody
 * has to reconnect by hand. `openid`/`profile`/`email` identify the person who
 * connected it, for the audit row.
 */
export const XERO_SCOPES = [
  "openid", "profile", "email", "offline_access",
  "accounting.transactions", "accounting.contacts",
].join(" ");

/**
 * The redirect Xero sends the browser back to.
 *
 * Read off the request origin rather than an environment variable, exactly as
 * `/auth/invite` does (§10c), so a preview deployment connects to itself
 * instead of bouncing through production. The same URL must be registered on
 * the Xero app, so a new origin needs adding there once.
 */
export function xeroRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/xero/callback`;
}
