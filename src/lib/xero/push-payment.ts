import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { XERO_API } from "./config";
import { summariseXeroError } from "./errors";
import { getXeroTokens } from "./tokens";
import { buildPaymentPayload, paymentGate, type PayloadPayment } from "./payment-payload";

/**
 * Post one payment to Xero, against the invoice it settles.
 *
 * Same contract as the invoice push: **never throws, never blocks taking the
 * payment**. Somebody has handed over money; recording it here is the thing
 * that must succeed, and Xero is the copy.
 *
 * The one way this is stricter than the invoice push is idempotency. The
 * payment's own id goes out as Xero's `Idempotency-Key`, so a retry after a
 * timeout — where the first attempt may in fact have landed — cannot post the
 * money twice. A duplicated invoice is visible and embarrassing; a duplicated
 * payment quietly makes a customer look paid up.
 */

export type PaymentPushOutcome =
  | { ok: true; xeroPaymentId: string }
  | { ok: false; reason: string; skipped?: boolean };

type PaymentRow = PayloadPayment & { invoice_id: string };

export async function pushPaymentToXero(
  supabase: SupabaseClient,
  paymentId: string,
  tenantId: string,
): Promise<PaymentPushOutcome> {
  const { data: payment } = await supabase
    .from("payments")
    .select("id, invoice_id, amount, paid_on, method, reference, xero_payment_id")
    .eq("id", paymentId).eq("tenant_id", tenantId)
    .maybeSingle<PaymentRow>();

  if (!payment) {
    return { ok: false, reason: "That payment could not be found.", skipped: true };
  }

  const { data: invoice } = await supabase
    .from("invoices").select("xero_invoice_id")
    .eq("id", payment.invoice_id).eq("tenant_id", tenantId)
    .maybeSingle<{ xero_invoice_id: string | null }>();

  // The bank account lives on the connection, which `authenticated` may not
  // read (0026) — so this one field comes through the service-role client, and
  // is filtered by tenant here as §2 requires of it.
  const admin = createAdminClient();
  const { data: connection } = await admin
    .from("xero_connections").select("payment_account_code")
    .eq("tenant_id", tenantId)
    .maybeSingle<{ payment_account_code: string | null }>();

  const gate = paymentGate({
    payment,
    xeroInvoiceId: invoice?.xero_invoice_id ?? null,
    paymentAccountCode: connection?.payment_account_code ?? null,
  });
  if (!gate.send) return { ok: false, reason: gate.reason, skipped: gate.skipped };

  const tokens = await getXeroTokens(tenantId);
  if (!tokens) {
    return {
      ok: false, skipped: true,
      reason: "This laundry is not connected to Xero, so nothing was sent.",
    };
  }

  const payload = buildPaymentPayload({
    payment,
    xeroInvoiceId: invoice!.xero_invoice_id!,
    paymentAccountCode: connection!.payment_account_code!,
  });

  let response: Response;
  try {
    response = await fetch(`${XERO_API}/Payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Xero-tenant-id": tokens.xeroTenantId,
        "Content-Type": "application/json",
        Accept: "application/json",
        // The guard against posting the same money twice.
        "Idempotency-Key": payment.id,
      },
      body: JSON.stringify({ Payments: [payload] }),
    });
  } catch (cause) {
    return await record(supabase, paymentId, tenantId, {
      ok: false,
      reason: `Xero could not be reached. ${cause instanceof Error ? cause.message : ""}`.trim(),
    });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return await record(supabase, paymentId, tenantId, {
      ok: false,
      reason: `Xero refused the payment (${response.status}). ${summariseXeroError(detail)}`.trim(),
    });
  }

  const body = await response.json().catch(() => null) as
    { Payments?: { PaymentID?: string }[] } | null;
  const posted = body?.Payments?.[0]?.PaymentID;
  if (!posted) {
    return await record(supabase, paymentId, tenantId,
      { ok: false, reason: "Xero accepted the request but returned no payment." });
  }

  return await record(supabase, paymentId, tenantId, { ok: true, xeroPaymentId: posted });
}


async function record(
  supabase: SupabaseClient,
  paymentId: string,
  tenantId: string,
  outcome: PaymentPushOutcome,
): Promise<PaymentPushOutcome> {
  await supabase.from("payments").update(
    outcome.ok
      ? {
          xero_payment_id: outcome.xeroPaymentId,
          xero_pushed_at: new Date().toISOString(),
          xero_push_error: null,
        }
      : { xero_push_error: outcome.reason },
  ).eq("id", paymentId).eq("tenant_id", tenantId);

  return outcome;
}
