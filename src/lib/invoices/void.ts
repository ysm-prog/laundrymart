import type { createClient } from "@/lib/supabase/server";
import type { Session } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { describeDbError } from "@/lib/actions";
import { voidRefusal } from "@/lib/domain/payment-gate";
import { releaseVoidedInvoiceJobs, type ReleaseOutcome } from "@/lib/invoices/send";
import { pushVoidToXero } from "@/lib/xero/push-void";

type Client = Awaited<ReturnType<typeof createClient>>;

export type VoidOutcome =
  | {
      ok: true; invoiceNumber: string; release: ReleaseOutcome;
      /** Xero's answer: voided there, skipped (never pushed / not connected), or refused with a reason. */
      xero: { ok: true } | { ok: false; skipped: true } | { ok: false; skipped?: false; reason: string };
    }
  | { ok: false; error: string };

/**
 * Void one invoice — the single implementation, shared by the invoice page's
 * Void button and the test-data clean-up (brief 1.8), so a clean-up cannot void
 * an invoice the screen would have refused.
 *
 * The order is the one `voidInvoice` always had: refuse what 0052's guard would
 * refuse, with the remedy named; void here; release the jobs (to be billed
 * again, or written off — brief 1.6); then follow in Xero, never blocking on it.
 */
export async function voidOneInvoice(
  supabase: Client, session: Session, invoiceId: string,
  options: { reason: string; rebill: boolean },
): Promise<VoidOutcome> {
  const { data: current } = await supabase
    .from("invoices").select("invoice_number, status, amount_paid")
    .eq("id", invoiceId).eq("tenant_id", session.tenantId)
    .maybeSingle<{ invoice_number: string; status: string; amount_paid: number }>();
  if (!current) return { ok: false, error: "That invoice could not be found." };

  const [{ count: paymentCount }, { count: creditNoteCount }] = await Promise.all([
    supabase.from("payments").select("id", { count: "exact", head: true })
      .eq("invoice_id", invoiceId).eq("tenant_id", session.tenantId),
    supabase.from("credit_notes").select("id", { count: "exact", head: true })
      .eq("invoice_id", invoiceId).eq("tenant_id", session.tenantId)
      .in("status", ["issued", "applied"]),
  ]);
  const refusal = voidRefusal({
    status: current.status, amountPaid: Number(current.amount_paid),
    paymentCount: paymentCount ?? 0, creditNoteCount: creditNoteCount ?? 0,
  });
  if (refusal) return { ok: false, error: `${current.invoice_number}: ${refusal}` };

  const { error } = await supabase
    .from("invoices")
    .update({ status: "void", voided_at: new Date().toISOString(), void_reason: options.reason })
    .eq("id", invoiceId).eq("tenant_id", session.tenantId);
  if (error) return { ok: false, error: `${current.invoice_number}: ${describeDbError(error)}` };

  const release = await releaseVoidedInvoiceJobs(supabase, session, invoiceId, {
    rebill: options.rebill, reason: options.reason,
  });

  // Void it in Xero too, after voiding it here and never blocking on it — the
  // reasoning `voidInvoice` has always carried (§20). A refusal there (a paid
  // invoice) is reported; a skip (never pushed, not connected) is silent.
  const voided = await pushVoidToXero(supabase, invoiceId, session.tenantId);

  await recordAudit(session, {
    entity: "invoice", entityId: invoiceId, action: "status_change",
    summary: `voided: ${options.reason}`,
    metadata: {
      rebill: options.rebill,
      released: release.released, excluded: release.excluded,
      xero: voided.ok ? "voided" : (voided.skipped ? "skipped" : "refused"),
    },
  });

  return {
    ok: true, invoiceNumber: current.invoice_number, release,
    xero: voided.ok ? { ok: true } : voided.skipped ? { ok: false, skipped: true } : { ok: false, reason: voided.reason },
  };
}
