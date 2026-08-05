/**
 * Writing notifications (AD-4).
 *
 * Two callers, one insert:
 * - **server actions**, which already know the event happened and hold the
 *   caller's RLS-bound client — no new infrastructure, no second source of
 *   truth about what occurred;
 * - **the swept check** (`/api/notifications/sweep`), which runs without a
 *   session and therefore uses the service-role client, filtering `tenant_id`
 *   itself because RLS is not there to do it.
 *
 * Every insert is idempotent on `(tenant_id, kind, subject_id, occurred_on)`.
 * That is what lets the cron run twice — or run late, or be replayed by hand —
 * without notifying anyone twice about the same thing on the same day.
 *
 * Failures are swallowed and logged, exactly as `recordAudit()` does: an
 * invoice that issued correctly must not report itself as failed because the
 * notification about it could not be written.
 */

import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { today } from "@/lib/format";
import type { Session } from "@/lib/auth/context";
import type { NotificationKind } from "@/lib/notifications/kinds";
import { NOTIFICATION_EVENTS } from "@/lib/notifications/kinds";
import { parseSettings, type NotificationSettings } from "@/lib/notifications/settings";

/** Anything with `.from()` — the RLS client or the service-role one. */
type AnyClient = Pick<SupabaseClient, "from">;

export type NotificationInput = {
  kind: NotificationKind;
  /** The row this is about. Null for events with no single subject row. */
  subjectId?: string | null;
  /** The sentence shown in the bell. Voice rule 1: address the person. */
  title: string;
  /** Where it is handled. Voice rule 4: never a dead end, so this is required. */
  href: string;
  /**
   * The business day this belongs to, `YYYY-MM-DD`. Defaults to today in
   * Sydney. The sweep passes an explicit value when an event recurs on a
   * schedule (a repeat overdue chase), so each occurrence gets its own row.
   */
  occurredOn?: string;
};

/**
 * The column list must match the unique index in migration 0013 exactly —
 * PostgREST passes it to `ON CONFLICT (...)`, and Postgres infers the index
 * from those columns. Changing one without the other silently turns every
 * insert back into a duplicate.
 */
const CONFLICT_TARGET = "tenant_id,kind,subject_id,occurred_on";

async function insert(
  client: AnyClient,
  tenantId: string,
  input: NotificationInput,
): Promise<void> {
  try {
    const { error } = await client.from("notifications").upsert(
      {
        tenant_id: tenantId,
        kind: input.kind,
        audience: NOTIFICATION_EVENTS[input.kind].audience,
        subject_id: input.subjectId ?? null,
        occurred_on: input.occurredOn ?? today(),
        title: input.title,
        href: input.href,
      },
      { onConflict: CONFLICT_TARGET, ignoreDuplicates: true },
    );
    if (error) {
      console.error("notification insert failed", { kind: input.kind, error: error.message });
    }
  } catch (cause) {
    console.error("notification insert threw", cause);
  }
}

/**
 * Read the tenant's preferences once per request. Server actions fire at most a
 * couple of notifications, and the layout reads the same row for the settings
 * screen, so one memoised lookup covers both.
 */
export const tenantSettings = cache(async (tenantId: string): Promise<NotificationSettings> => {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("tenants").select("settings").eq("id", tenantId).maybeSingle();
    return parseSettings(data?.settings);
  } catch {
    return parseSettings(null);
  }
});

/**
 * Raise a notification from inside a server action.
 *
 * Honours the tenant's in-app switch for that event: a tenant that has turned an
 * event off gets no row at all, rather than a row nobody is shown — otherwise
 * "off" would still leave the count climbing.
 */
export async function notify(session: Session, input: NotificationInput): Promise<void> {
  const settings = await tenantSettings(session.tenantId);
  if (!settings.inApp[input.kind]) return;

  const supabase = await createClient();
  await insert(supabase, session.tenantId, input);
}

/**
 * Raise a notification from the sweep, which has no session.
 *
 * `tenantId` comes from the row the sweep is iterating, never from the request —
 * the service-role client bypasses RLS, so this function is the boundary.
 * Settings are passed in because the sweep has already loaded them once per
 * tenant and would otherwise re-read them per row.
 */
export async function notifyTenant(
  client: AnyClient,
  tenantId: string,
  settings: NotificationSettings,
  input: NotificationInput,
): Promise<void> {
  if (!settings.inApp[input.kind]) return;
  await insert(client, tenantId, input);
}
