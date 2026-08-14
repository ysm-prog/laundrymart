import { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";

/**
 * Append-only activity trail (NFR §8: audit logging for all writes).
 * Failures are swallowed deliberately — a write that already succeeded must not
 * be reported as failed because its audit row could not be inserted. The miss is
 * logged so it still shows up in observability.
 */
export async function recordAudit(
  session: Session,
  entry: {
    entity: string;
    entityId?: string | null;
    // `send_failed` earns its place next to the successes: when a customer says
    // they never got the invoice, the useful record is the attempt, not silence.
    // `assign` / `reassign` / `unassign` are dispatch: putting a laundry job on
    // a driver's run, moving it to another, taking it off. Distinct from
    // `update` because "who was carrying this, and since when" is the question
    // an audit log gets asked about a delivery that went astray.
    action:
      | "create" | "update" | "delete" | "status_change" | "sync" | "generate"
      | "send" | "send_failed" | "assign" | "reassign" | "unassign";
    summary?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.from("audit_logs").insert({
      tenant_id: session.tenantId,
      actor_id: session.userId,
      entity: entry.entity,
      entity_id: entry.entityId ?? null,
      action: entry.action,
      summary: entry.summary ?? null,
      metadata: entry.metadata ?? {},
    });
    if (error) console.error("audit log insert failed", { entity: entry.entity, error: error.message });
  } catch (cause) {
    console.error("audit log insert threw", cause);
  }
}
