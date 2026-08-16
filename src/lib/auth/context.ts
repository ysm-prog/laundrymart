import { cache } from "react";
import { cookies } from "next/headers";
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
  /**
   * True when this person administers the deployment rather than one laundry
   * (0019). `role` is already `platform_admin` in that case; this is the flag
   * the shell reads to decide whether to offer the laundry switcher, since
   * "which laundry am I looking at?" is only a question for them.
   */
  isPlatformAdmin: boolean;
};

/**
 * Which laundry a person is currently looking at.
 *
 * Only ever narrows to something the database would allow anyway — every read
 * still goes through RLS, so a forged cookie naming a laundry you cannot see
 * buys nothing but an empty screen. It is a preference, not a grant, which is
 * why it is a plain cookie and not part of the JWT.
 */
export const ACTIVE_TENANT_COOKIE = "active_tenant";

/**
 * Memoised per request so every server component shares one resolve.
 * `getClaims()` verifies the JWT locally — no network round-trip per navigation.
 */
export const requireSession = cache(async (): Promise<Session> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) redirect("/login");

  const userId = claims.sub as string;
  const email = (claims.email as string | undefined) ?? null;
  const preferred = (await cookies()).get(ACTIVE_TENANT_COOKIE)?.value ?? null;

  // One row at most, and only ever their own: the policy on `platform_admins`
  // is `is_platform_admin()` in both directions, so this returns nothing at all
  // for everybody else rather than leaking that the list exists.
  const { data: platformAdmin } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (platformAdmin) {
    // No membership to read a tenant from — they are not a member of anything.
    // `is_member()` was widened in 0019, so `tenants` is fully readable here and
    // the pick below is a real choice rather than a guess.
    const { data: tenants } = await supabase
      .from("tenants")
      .select("id, name")
      .order("name")
      .returns<{ id: string; name: string }[]>();

    const list = tenants ?? [];
    const active = list.find((t) => t.id === preferred) ?? list[0];
    // A deployment with no laundries at all. Reachable exactly once, before the
    // first one is created, and only by a platform admin.
    if (!active) redirect("/login?error=no-tenants");

    return {
      userId,
      email,
      tenantId: active.id,
      tenantName: active.name,
      role: "platform_admin",
      depotId: null,
      isPlatformAdmin: true,
    };
  }

  // `order("created_at")` is not cosmetic. This used to be `.limit(1)` with no
  // ordering at all, so a person who belongs to two laundries — both of this
  // deployment's `super_admin` logins do — landed in whichever one the planner
  // happened to return first, and it could differ between requests. Ordering
  // makes it stable; the cookie below makes it theirs to choose.
  const { data: memberships } = await supabase
    .from("memberships")
    .select("tenant_id, role, depot_id, tenants(name)")
    .eq("user_id", userId)
    .order("created_at")
    .returns<MembershipRow[]>();

  const rows = memberships ?? [];
  const membership = rows.find((row) => row.tenant_id === preferred) ?? rows[0];
  if (!membership) redirect("/login?error=no-membership");
  const tenant = membership.tenants as { name: string } | { name: string }[] | null;
  const tenantName = Array.isArray(tenant) ? (tenant[0]?.name ?? "") : (tenant?.name ?? "");

  return {
    userId,
    email,
    tenantId: membership.tenant_id,
    tenantName,
    role: isRole(membership.role) ? membership.role : "auditor",
    depotId: membership.depot_id ?? null,
    isPlatformAdmin: false,
  };
});

type MembershipRow = {
  tenant_id: string;
  role: string;
  depot_id: string | null;
  tenants: { name: string } | { name: string }[] | null;
};

/**
 * Every laundry this person may switch between, in the order they are offered.
 *
 * A platform admin gets all of them; anybody else gets the ones they hold a
 * membership in, which for almost everybody is exactly one — and the switcher
 * is not rendered at all in that case.
 */
export async function switchableTenants(): Promise<{ id: string; name: string }[]> {
  const session = await requireSession();
  const supabase = await createClient();

  if (session.isPlatformAdmin) {
    const { data } = await supabase
      .from("tenants").select("id, name").order("name")
      .returns<{ id: string; name: string }[]>();
    return data ?? [];
  }

  const { data } = await supabase
    .from("memberships")
    .select("tenant_id, tenants(name)")
    .eq("user_id", session.userId)
    .returns<{ tenant_id: string; tenants: { name: string } | { name: string }[] | null }[]>();

  return (data ?? []).map((row) => {
    const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
    return { id: row.tenant_id, name: tenant?.name ?? "" };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

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
