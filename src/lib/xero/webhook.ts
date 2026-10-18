import "server-only";
import type { Session } from "@/lib/auth/context";
import { settleHeaderOnly } from "@/lib/domain/payment-gate";
import { resettleInvoice } from "@/lib/invoices/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { XERO_API } from "./config";
import { getXeroTokens } from "./tokens";
import { paymentsOnInvoice, type XeroWebhookEvent } from "./webhook-payload";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Apply Xero invoice events: when an invoice this app sent is paid (or part
 * paid) in Xero, record the payment here so the register shows it.
 *
 * - Only invoices this app pushed are touched (matched on `xero_invoice_id`
 *   within the laundry that owns the Xero organisation). MYOB history and
 *   opening-balance items in Xero have no match and are ignored.
 * - A payment carries the Xero PaymentID in `xero_payment_id`, which is both
 *   what makes a repeated delivery a no-op and what stops `pushPaymentToXero`
 *   sending the money back to Xero.
 * - Runs after the 200 has gone back to Xero (Xero wants an answer within five
 *   seconds), so a failure is logged rather than returned.
 */
export async function applyXeroInvoiceEvents(events: XeroWebhookEvent[]): Promise<void> {
  const admin = createAdminClient();
  for (const event of events) {
    try {
      await applyOne(admin, event);
    } catch (cause) {
      console.error("xero webhook: event failed", { resourceId: event.resourceId, cause });
    }
  }
}

async function applyOne(admin: Admin, event: XeroWebhookEvent): Promise<void> {
  const { data: connection } = await admin
    .from("xero_connections")
    .select("tenant_id")
    .eq("xero_tenant_id", event.tenantId)
    .maybeSingle<{ tenant_id: string }>();
  if (!connection) return;
  const tenantId = connection.tenant_id;

  const { data: invoice } = await admin
    .from("invoices")
    .select("id, customer_id, status, total, amount_paid")
    .eq("tenant_id", tenantId)
    .eq("xero_invoice_id", event.resourceId)
    .maybeSingle<{ id: string; customer_id: string; status: string; total: number; amount_paid: number }>();
  if (!invoice || invoice.status === "void" || invoice.status === "draft") return;

  const tokens = await getXeroTokens(tenantId);
  if (!tokens) return;

  const response = await fetch(`${XERO_API}/Invoices/${event.resourceId}`, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Xero-tenant-id": tokens.xeroTenantId,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    console.error("xero webhook: invoice read failed", { status: response.status, resourceId: event.resourceId });
    return;
  }
  const body = (await response.json()) as { Invoices?: unknown[] };
  const fromXero = paymentsOnInvoice(body.Invoices?.[0]);
  if (fromXero.length === 0) return;

  const { data: known } = await admin
    .from("payments")
    .select("xero_payment_id")
    .eq("tenant_id", tenantId)
    .in("xero_payment_id", fromXero.map((p) => p.paymentId))
    .returns<Array<{ xero_payment_id: string }>>();
  const already = new Set((known ?? []).map((k) => k.xero_payment_id));
  const fresh = fromXero.filter((p) => !already.has(p.paymentId));
  if (fresh.length === 0) return;

  const { count: lineCount } = await admin
    .from("invoice_lines")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("invoice_id", invoice.id);

  let amountPaid = Number(invoice.amount_paid);
  let recorded = 0;
  for (const payment of fresh) {
    const { error } = await admin.from("payments").insert({
      tenant_id: tenantId,
      invoice_id: invoice.id,
      customer_id: invoice.customer_id,
      paid_on: payment.paidOn,
      amount: payment.amount,
      method: "other",
      reference: payment.reference,
      notes: "Recorded in Xero",
      xero_payment_id: payment.paymentId,
      xero_pushed_at: new Date().toISOString(),
    });
    if (error) {
      console.error("xero webhook: payment insert failed", { paymentId: payment.paymentId, error: error.message });
      continue;
    }
    recorded += 1;
    if (!lineCount) {
      amountPaid = settleHeaderOnly(Number(invoice.total), amountPaid, payment.amount).amountPaid;
    }
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_id: null,
      entity: "payment",
      entity_id: invoice.id,
      action: "create",
      summary: `$${payment.amount.toFixed(2)} recorded in Xero`,
      metadata: { source: "xero_webhook", xero_payment_id: payment.paymentId },
    });
  }
  if (recorded === 0) return;

  if (lineCount && lineCount > 0) {
    const { error } = await admin.rpc("recalculate_invoice", { p_invoice: invoice.id });
    if (error) {
      // Fall back to the payments themselves so the balance is still right.
      const { data: rows } = await admin
        .from("payments")
        .select("amount")
        .eq("tenant_id", tenantId)
        .eq("invoice_id", invoice.id)
        .returns<Array<{ amount: number }>>();
      const sum = (rows ?? []).reduce((total, row) => total + Number(row.amount), 0);
      await admin
        .from("invoices")
        .update({ amount_paid: Math.round(sum * 100) / 100 })
        .eq("id", invoice.id)
        .eq("tenant_id", tenantId);
    }
  } else {
    await admin.from("invoices").update({ amount_paid: amountPaid }).eq("id", invoice.id).eq("tenant_id", tenantId);
  }

  // resettleInvoice only reads the tenant from the session; there is no person here.
  const session = { tenantId } as unknown as Session;
  await resettleInvoice(admin as unknown as Parameters<typeof resettleInvoice>[0], session, invoice.id);
}
