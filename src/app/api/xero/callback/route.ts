import { NextResponse, type NextRequest } from "next/server";
import { cookies, headers } from "next/headers";
import { requireSession } from "@/lib/auth/context";
import { can } from "@/lib/roles";
import { recordAudit } from "@/lib/audit";
import { XERO_CONNECTIONS_URL, xeroRedirectUri } from "@/lib/xero/config";
import { exchangeCodeForTokens, saveXeroConnection } from "@/lib/xero/tokens";
import { XERO_STATE_COOKIE } from "../connect/route";

export const dynamic = "force-dynamic";

const SCREEN = "/invoices/xero";

/**
 * Where Xero sends the browser back.
 *
 * The tenant is taken from the **session**, never from the callback: whoever
 * completes this flow connects the laundry they are signed into, so a doctored
 * link cannot bind an organisation to somebody else's books. The capability is
 * re-checked here too — `connect` checked it, and this is a separate request.
 */
export async function GET(request: NextRequest) {
  const base = await origin();
  const session = await requireSession();
  if (!can(session.role, "invoices.write")) {
    return NextResponse.redirect(new URL("/dashboard?error=forbidden", base));
  }

  const params = request.nextUrl.searchParams;
  if (params.get("error")) {
    return back(base, "Xero did not complete the connection.");
  }

  const code = params.get("code");
  const state = params.get("state");
  const store = await cookies();
  const expected = store.get(XERO_STATE_COOKIE)?.value;
  // One-shot: cleared whatever happens, so a replayed callback cannot reuse it.
  store.delete(XERO_STATE_COOKIE);

  if (!code || !state || !expected || state !== expected) {
    return back(base, "That Xero link was not valid. Start the connection again.");
  }

  const tokens = await exchangeCodeForTokens(code, xeroRedirectUri(base));
  if (!tokens) return back(base, "Xero refused the connection. Try again.");

  // Which organisation the person actually authorised. Xero returns a list;
  // one entry is the ordinary case, and the first is the one they picked.
  const connections = await fetch(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as
    { tenantId?: string; tenantName?: string }[] | null;

  const org = connections?.[0];
  if (!org?.tenantId) return back(base, "Xero did not say which organisation to use.");

  const failure = await saveXeroConnection({
    tenantId: session.tenantId,
    xeroTenantId: org.tenantId,
    xeroTenantName: org.tenantName ?? null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    connectedBy: session.userId,
  });
  if (failure) return back(base, failure);

  await recordAudit(session, {
    entity: "xero_connection", entityId: session.tenantId, action: "create",
    summary: `connected to ${org.tenantName ?? org.tenantId}`,
  });

  return NextResponse.redirect(new URL(`${SCREEN}?ok=connected`, base));
}

function back(base: string, message: string) {
  return NextResponse.redirect(
    new URL(`${SCREEN}?error=${encodeURIComponent(message)}`, base));
}

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const protocol = h.get("x-forwarded-proto") ?? "https";
  return `${protocol}://${host}`;
}
