// BROWSER client. The only one in the app — everything else talks to Supabase
// from a server component, a server action or a route handler.
//
// It exists for the single case the server cannot handle: an invitation link.
// Supabase verifies the invite token at its own `/auth/v1/verify` endpoint and
// then redirects to us with the new session in the URL **fragment**, and a
// fragment is never sent to the server. `inviteUserByEmail` cannot use the PKCE
// `?code=` flow the magic-link sign-in uses either, because the browser that
// created the invite is not the browser that accepts it — so there is no code
// verifier cookie waiting on the other end. See `/auth/invite`.
import { createBrowserClient } from "@supabase/ssr";

/**
 * Reads `process.env.NEXT_PUBLIC_*` directly rather than going through
 * `@/lib/env`, which the three server clients use. That module also validates
 * `SUPABASE_SERVICE_ROLE_KEY`; importing it here would pull a server-only
 * schema into the client bundle and fail validation in the browser, where the
 * variable is rightly absent. Next inlines these two at build time, so a
 * missing one is still caught — by the explicit throw below rather than by a
 * client quietly constructed against `undefined`.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured for the browser.");
  }
  return createBrowserClient(url, anonKey);
}
