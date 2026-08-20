import { cache } from "react";
import { requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { hasRealName, memberDisplayName, staffMembers } from "@/lib/domain/members";

// The list rules live in `domain/` so they can be unit-tested — this module
// reaches `next/headers` through the session and cannot be imported from a
// test, the trap `plan.ts` records. Re-exported so a screen still has one
// place to import from.
export {
  defaultStaffId, memberNames, staffMembers, withCurrentHolder,
} from "@/lib/domain/members";
import { ROLE_LABELS, isRole } from "@/lib/roles";

/**
 * The laundry's people, as one list every screen reads.
 *
 * There is no employee table in this application and this does not add one:
 * people are the existing `memberships` rows, which are `auth.users` with a
 * role — the same key every `created_by`, `assigned_to`, `actor_id` and
 * `delivered_by` column in the schema already points at.
 *
 * **Read through `tenant_members()` (0030), not the GoTrue admin API.** The
 * admin client was three problems at once: it can only return an address where
 * a screen wants a name, it is one HTTP round trip per member, and it failed
 * outright for every login written straight into `auth.users` — which on this
 * deployment is the eleven role profiles, all of which rendered as short UUIDs.
 * The function is one query, gated on membership inside, and **scoped to one
 * tenant by argument**: `memberships` under RLS returns every laundry's rows to
 * a platform admin (0019), which is why their session saw each of its own
 * memberships listed twice.
 *
 * Memoised per request — a page with an assignment picker, a completion picker
 * and an activity log resolves the list once.
 */

export type Member = {
  id: string;
  /** What to call them: their name where one is known. Never a bare UUID. */
  label: string;
  /** Their address. Shown only on the People screen, which is about logins. */
  email: string | null;
  fullName: string | null;
  driverName: string | null;
  /** The stored role, for a form that has to post it back. */
  roleValue: string;
  /** The role as a person reads it. */
  role: string;
  depotId: string | null;
  joinedAt: string;
  isPlatformAdmin: boolean;
  /** False when the label is falling back to an address or an id. */
  named: boolean;
};

type Row = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  driver_name: string | null;
  role: string;
  depot_id: string | null;
  joined_at: string;
  is_platform_admin: boolean;
};

export const listMembers = cache(async (): Promise<Member[]> => {
  const session = await requireSession();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("tenant_members", { t: session.tenantId });
  if (error) {
    // A screen that cannot resolve names should render ids, not fail — the same
    // call the admin-client version made. Never the caller's SQL on screen.
    console.error("tenant_members failed", error.message);
    return [];
  }

  return ((data ?? []) as Row[]).map((row) => {
    const parts = {
      id: row.user_id,
      fullName: row.full_name,
      driverName: row.driver_name,
      email: row.email,
    };
    return {
      id: row.user_id,
      label: memberDisplayName(parts),
      email: row.email,
      fullName: row.full_name,
      driverName: row.driver_name,
      roleValue: row.role,
      role: isRole(row.role) ? ROLE_LABELS[row.role] : row.role,
      depotId: row.depot_id,
      joinedAt: row.joined_at,
      isPlatformAdmin: row.is_platform_admin,
      named: hasRealName(parts),
    };
  });
});

/** The laundry's people, already narrowed and sorted by name, for a `<Select>`. */
export async function listStaff(): Promise<Member[]> {
  return staffMembers(await listMembers());
}
