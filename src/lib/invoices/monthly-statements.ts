import type { createAdminClient } from "@/lib/supabase/admin";
import type { createClient } from "@/lib/supabase/server";
import { parseAutomation } from "@/lib/domain/automation";
import {
  monthlyStatementDue, monthlyStatementSkip, statementHasContent,
} from "@/lib/domain/statement";
import { emailIsConfigured } from "@/lib/email/send";
import { deliverStatement, loadStatementList } from "./statement";

/**
 * The monthly statement run (ysm-hub's partner statements on the 1st).
 *
 * Called from the notification sweep, which already runs five times a day with
 * no session on the service-role client. That is why it is idempotent rather
 * than scheduled: on the first three days of a month it sends each customer the
 * statement made up to the last day of the month before, once, and the audit
 * row's `monthlyStatement` key is the marker the next sweep reads back. A send
 * that fails writes no marker, so it is tried again on the next sweep inside the
 * window.
 *
 * Off unless the laundry turns it on (`automation.monthlyStatements`), because
 * mail leaves the building. Nothing is sent while no mail provider is set up.
 */

type AdminClient = ReturnType<typeof createAdminClient>;
type Client = Awaited<ReturnType<typeof createClient>>;

/** ysm-hub's cap per run, and the same reason: a run that big wants a person. */
export const MAX_MONTHLY_STATEMENTS = 500;

export type MonthlyStatementTally = { sent: number; failed: number; skipped: number };

export async function sendMonthlyStatements(
  admin: AdminClient,
  tenant: { id: string; settings: unknown },
  businessDay: string,
): Promise<MonthlyStatementTally> {
  const tally: MonthlyStatementTally = { sent: 0, failed: 0, skipped: 0 };
  if (!parseAutomation(tenant.settings).monthlyStatements || !emailIsConfigured()) return tally;
  const due = monthlyStatementDue(businessDay);
  if (!due) return tally;

  // The statement loaders are written against the RLS-bound client's type; every
  // read in them names the tenant and the archive, so the service-role client
  // reads exactly the same rows through them.
  const client = admin as unknown as Client;
  const options = { asAt: due.asAt, upToAsAt: true };
  const list = (await loadStatementList(client, tenant.id, options))
    .filter((row) => statementHasContent(row.statement));
  if (list.length === 0) return tally;

  const { data: sent } = await admin
    .from("audit_logs")
    .select("entity_id")
    .eq("tenant_id", tenant.id)
    .eq("entity", "customer")
    .eq("action", "send")
    .eq("metadata->>monthlyStatement", due.period)
    .returns<Array<{ entity_id: string | null }>>();
  const alreadySent = new Set((sent ?? []).map((row) => row.entity_id));

  let attempted = 0;
  for (const row of list) {
    const skip = monthlyStatementSkip({
      hasContent: true,
      billingEmail: row.billingEmail,
      remindersEnabled: row.remindersEnabled,
      alreadySent: alreadySent.has(row.customerId),
    });
    if (skip) { tally.skipped += 1; continue; }
    if (attempted >= MAX_MONTHLY_STATEMENTS) break;
    attempted += 1;

    const result = await deliverStatement(client, tenant.id, row.customerId, options);
    if (result.kind === "skipped") { tally.skipped += 1; continue; }

    // No session, so `recordAudit()` is not the tool: the row is written with a
    // null actor, as the overdue chase writes its own. Nobody did this; a clock did.
    await admin.from("audit_logs").insert({
      tenant_id: tenant.id,
      actor_id: null,
      entity: "customer",
      entity_id: row.customerId,
      action: result.kind === "sent" ? "send" : "send_failed",
      summary: result.kind === "sent"
        ? `monthly statement as at ${due.asAt} sent to ${result.recipient}`
        : `monthly statement as at ${due.asAt} to ${result.recipient ?? "the customer"} failed: ${result.reason}`,
      metadata: result.kind === "sent"
        ? {
          monthlyStatement: due.period, asAt: due.asAt, providerId: result.providerId,
          total: result.total, invoices: result.invoices, excluded: result.excluded,
        }
        : { attemptedMonthlyStatement: due.period },
    });
    if (result.kind === "sent") tally.sent += 1;
    else tally.failed += 1;
  }
  return tally;
}
