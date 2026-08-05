/**
 * Reading notifications (AD-4).
 *
 * The bell is a head-only count issued in the `(app)` layout alongside the four
 * nav badges, using exactly their pattern: one count per request, no websocket,
 * no realtime subscription. At this scale refresh-on-navigate is honest — what
 * the bell needs is to be *right when you look at it*, not to animate.
 *
 * Two boundaries, and they are different things:
 * - **RLS** keeps one tenant's notifications away from another's. That is the
 *   real one, enforced in the database by 0013's member policy.
 * - **Audience** narrows what a member sees to the events they can act on. That
 *   is a UI concern — a dispatcher has no business being shown a warehouse
 *   write-off — and it is applied here on top of RLS, never instead of it.
 */

import { createClient } from "@/lib/supabase/server";
import { ROLE_CAPABILITIES } from "@/lib/roles";
import type { Session } from "@/lib/auth/context";
import { isNotificationKind, type NotificationKind } from "@/lib/notifications/kinds";

export type NotificationRow = {
  id: string;
  kind: NotificationKind;
  title: string;
  href: string;
  created_at: string;
  read_at: string | null;
};

/** How many rows the panel shows before it stops. Nobody reads past this. */
export const NOTIFICATION_PAGE_SIZE = 50;

function audiencesFor(session: Session): string[] {
  return [...ROLE_CAPABILITIES[session.role]];
}

/**
 * Unread count for the bell. Head-only — no rows come back, just the number,
 * served by 0013's partial index on `(tenant_id, audience) where read_at is null`.
 *
 * A failure yields `undefined`, so the bell renders with no badge rather than a
 * zero it cannot vouch for. Same rule the nav counts follow: an empty badge is
 * honest, a wrong one is not.
 */
export async function unreadNotificationCount(session: Session): Promise<number | undefined> {
  try {
    const audiences = audiencesFor(session);
    if (audiences.length === 0) return undefined;

    const supabase = await createClient();
    const { count } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .in("audience", audiences)
      .is("read_at", null);

    return count ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The panel itself. Unread first by default; `includeRead` shows the history,
 * because nothing is ever deleted and "what did we get told last week" is a
 * reasonable question.
 */
export async function listNotifications(
  session: Session,
  options: { includeRead?: boolean } = {},
): Promise<NotificationRow[]> {
  try {
    const audiences = audiencesFor(session);
    if (audiences.length === 0) return [];

    const supabase = await createClient();
    let query = supabase
      .from("notifications")
      .select("id, kind, title, href, created_at, read_at")
      .in("audience", audiences);

    if (!options.includeRead) query = query.is("read_at", null);

    const { data } = await query
      .order("created_at", { ascending: false })
      .limit(NOTIFICATION_PAGE_SIZE)
      .returns<NotificationRow[]>();

    // A kind this build does not know about is a row written by a newer deploy
    // mid-rollout. Dropping it beats rendering a row with no label.
    return (data ?? []).filter((row) => isNotificationKind(row.kind));
  } catch {
    return [];
  }
}
