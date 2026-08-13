import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_LABELS, isRole } from "@/lib/roles";

/**
 * The tenant's people, as a pickable list.
 *
 * There is no employee table in this application and this does not add one:
 * staff are the existing `memberships` rows, which are `auth.users` with a role.
 * That is the same key every `created_by`, `assigned_to` and `delivered_by`
 * column in the schema already points at.
 *
 * Emails come from the service-role auth API one id at a time, starting from
 * *this tenant's* membership rows — the admin client bypasses RLS, so it must
 * never list globally and filter afterwards. Any failure (no service key in a
 * local build, auth API down) degrades to a short id rather than an error: a
 * less readable picker beats a screen that will not load. This is the same
 * approach the People screen takes; it is shared here so the two cannot drift.
 *
 * Memoised per request — a page that shows an assignment picker and a completion
 * picker resolves the list once.
 */

export type StaffMember = {
  id: string;
  /** Email where we could resolve one, otherwise a short id. */
  label: string;
  role: string;
};

export const listStaff = cache(async (): Promise<StaffMember[]> => {
  const supabase = await createClient();
  const { data: memberships } = await supabase
    .from("memberships")
    .select("user_id, role")
    .order("created_at")
    .returns<{ user_id: string; role: string }[]>();

  const rows = memberships ?? [];
  const emails = new Map<string, string>();

  try {
    const admin = createAdminClient();
    const resolved = await Promise.all(rows.map(async (row) => {
      try {
        const { data } = await admin.auth.admin.getUserById(row.user_id);
        return [row.user_id, data.user?.email ?? null] as const;
      } catch {
        return [row.user_id, null] as const; // One bad id must not blank the rest.
      }
    }));
    for (const [id, email] of resolved) if (email) emails.set(id, email);
  } catch {
    // Fall through with whatever resolved.
  }

  return rows.map((row) => ({
    id: row.user_id,
    label: emails.get(row.user_id) ?? `${row.user_id.slice(0, 8)}…`,
    role: isRole(row.role) ? ROLE_LABELS[row.role] : row.role,
  }));
});

/** `id → label`, for rendering a stored `assigned_to` without a second lookup. */
export function staffNames(staff: readonly StaffMember[]): Map<string, string> {
  return new Map(staff.map((member) => [member.id, member.label]));
}
