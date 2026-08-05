import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, isRole, type Capability, type Role } from "@/lib/roles";

export type Session = {
  userId: string;
  email: string | null;
  tenantId: string;
  tenantName: string;
  role: Role;
  depotId: string | null;
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
    .select("tenant_id, role, depot_id, tenants(name)")
    .eq("user_id", claims.sub)
    .limit(1)
    .maybeSingle();

  if (!membership) redirect("/login?error=no-membership");

  const tenant = membership.tenants as { name: string } | { name: string }[] | null;
  const tenantName = Array.isArray(tenant) ? (tenant[0]?.name ?? "") : (tenant?.name ?? "");

  return {
    userId: claims.sub as string,
    email: (claims.email as string | undefined) ?? null,
    tenantId: membership.tenant_id as string,
    tenantName,
    role: isRole(membership.role) ? membership.role : "auditor",
    depotId: (membership.depot_id as string | null) ?? null,
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
