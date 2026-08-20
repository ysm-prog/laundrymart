import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { requireSession } from "@/lib/auth/context";
import { can } from "@/lib/roles";
import {
  XERO_AUTHORIZE_URL, XERO_SCOPES, xeroConfig, xeroRedirectUri,
} from "@/lib/xero/config";

export const dynamic = "force-dynamic";

/** The one-shot CSRF value, matched on the way back. */
export const XERO_STATE_COOKIE = "xero_oauth_state";

/**
 * Start the Xero connection for the laundry the caller is currently in.
 *
 * A route rather than a server action because it ends in a redirect to another
 * origin, which an action cannot do. The tenant is *not* carried in `state` —
 * it is re-read from the session on the way back, so a tampered `state` cannot
 * attach somebody else's Xero organisation to a laundry they do not administer.
 */
export async function GET() {
  const session = await requireSession();
  if (!can(session.role, "invoices.write")) {
    return NextResponse.redirect(new URL("/dashboard?error=forbidden", await origin()));
  }

  const config = xeroConfig();
  if (!config) {
    return NextResponse.redirect(new URL("/invoices/xero?error=not-configured", await origin()));
  }

  const state = randomUUID();
  const store = await cookies();
  store.set(XERO_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  const url = new URL(XERO_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", xeroRedirectUri(await origin()));
  url.searchParams.set("scope", XERO_SCOPES);
  url.searchParams.set("state", state);

  return NextResponse.redirect(url);
}

/** The deployment's own origin, so a preview connects to itself. */
async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const protocol = h.get("x-forwarded-proto") ?? "https";
  return `${protocol}://${host}`;
}
