import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Emails for a tenant's members, resolved from the service-role auth API.
 *
 * A membership row carries a `user_id` and nothing else — the address lives in
 * `auth.users`, which no ordinary session may read. So this is one of the few
 * places the admin client is legitimately needed, and it obeys the rule §2 sets
 * for it: **the caller passes the ids it already got through RLS, and this asks
 * for each one.** It must never list users globally and filter afterwards, which
 * would read every tenant's people to answer a question about one.
 *
 * Any failure degrades to "no email" rather than throwing: a local build with no
 * service key, or an auth API having a bad minute, should leave a slightly less
 * readable list rather than a broken screen. One unresolvable id must not blank
 * the rest either, which is why each lookup catches on its own.
 *
 * Shared by the People screen and the Drivers screen. It was private to People,
 * and the Drivers screen asking the operator to *paste a UUID* — from a screen
 * that stopped showing UUIDs when it started showing emails — is what that
 * privacy cost.
 */
export async function memberEmails(userIds: readonly string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  if (userIds.length === 0) return emails;

  try {
    const admin = createAdminClient();
    const results = await Promise.all(userIds.map(async (id) => {
      try {
        const { data } = await admin.auth.admin.getUserById(id);
        return [id, data.user?.email ?? null] as const;
      } catch {
        return [id, null] as const;
      }
    }));
    for (const [id, email] of results) {
      if (email) emails.set(id, email);
    }
  } catch {
    // Fall through with whatever resolved.
  }
  return emails;
}

/** What to call somebody when their email could not be resolved. */
export function memberLabel(userId: string, email: string | undefined): string {
  return email ?? `User ${userId.slice(0, 8)}…`;
}
