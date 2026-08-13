import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, isRole, type Capability, type Role } from "@/lib/roles";
import { parseUiMode, type UiMode } from "@/lib/ui-mode";

export type Session = {
  userId: string;
  email: string | null;
  tenantId: string;
  tenantName: string;
  role: Role;
  depotId: string | null;
  /**
   * How much of the app this tenant shows in the rail. It rides the session
   * because the query that resolves the membership already joins `tenants` —
   * reading it here costs one more column, and reading it in the layout would
   * cost a second round trip on every navigation.
   */
  uiMode: UiMode;
};

/**
 * Memoised per request so every server component shares one resolve.
 * `getClaims()` verifies the JWT locally — no network round-trip per navigation.
 */
export const requireSession = cache(async (): Promise<Session> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) redirect("/login");

  const { data: membership } = await supabase
    .from("memberships")
    .select("tenant_id, role, depot_id, tenants(name, settings)")
    .eq("user_id", claims.sub)
    .limit(1)
    .maybeSingle();

  if (!membership) redirect("/login?error=no-membership");

  type TenantRow = { name: string; settings: unknown };
  const tenant = membership.tenants as TenantRow | TenantRow[] | null;
  const row = Array.isArray(tenant) ? (tenant[0] ?? null) : tenant;
  const tenantName = row?.name ?? "";

  return {
    userId: claims.sub as string,
    email: (claims.email as string | undefined) ?? null,
    tenantId: membership.tenant_id as string,
    tenantName,
    role: isRole(membership.role) ? membership.role : "auditor",
    depotId: (membership.depot_id as string | null) ?? null,
    uiMode: parseUiMode(row?.settings),
  };
});

/** Guard a page. Redirects rather than rendering a half-usable screen. */
export async function requireCapability(capability: Capability): Promise<Session> {
  const session = await requireSession();
  if (!can(session.role, capability)) redirect("/dashboard?error=forbidden");
  return session;
}

/** Non-redirecting variant for server actions, which surface errors instead. */
export async function assertCapability(capability: Capability): Promise<Session> {
  const session = await requireSession();
  if (!can(session.role, capability)) {
    throw new Error(`Your role (${session.role}) cannot perform this action.`);
  }
  return session;
}
