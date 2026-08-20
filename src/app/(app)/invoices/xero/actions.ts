"use server";

import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { done, fail, firstIssue, optionalText, toObject } from "@/lib/actions";
import { deleteXeroConnection } from "@/lib/xero/tokens";

const SCREEN = "/invoices/xero";

/**
 * Forget this laundry's Xero connection.
 *
 * Deletes the tokens and nothing else: invoices keep their `xero_invoice_id`,
 * because those invoices really are in Xero and forgetting that would make a
 * later reconnect push every one of them again as a duplicate.
 */
export async function disconnectXero(): Promise<void> {
  const session = await assertCapability("invoices.write");

  const failure = await deleteXeroConnection(session.tenantId);
  if (failure) return fail(SCREEN, failure);

  await recordAudit(session, {
    entity: "xero_connection", entityId: session.tenantId, action: "delete",
    summary: "disconnected from Xero",
  });
  revalidatePath(SCREEN);
  return done(SCREEN, "Disconnected from Xero. Invoices already sent are untouched.");
}

/**
 * Choose the Xero bank account payments are posted against.
 *
 * Written through the service-role client because `xero_connections` grants
 * `authenticated` nothing (0026) — so the tenant is filtered here by hand, and
 * the capability is checked before anything else happens.
 *
 * Both the code and the name are stored: the code is what Xero matches on, and
 * the name is what the screen shows, so somebody re-reading this setting a year
 * later sees "Business Cheque Account" rather than "090".
 */
export async function setXeroPaymentAccount(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    account: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(SCREEN, firstIssue(parsed.error));

  // The picker posts "code|name" so one control carries both without a second
  // round trip to Xero to resolve the name.
  const [code, ...rest] = (parsed.data.account ?? "").split("|");
  const name = rest.join("|") || null;

  const admin = createAdminClient();
  const { error } = await admin.from("xero_connections")
    .update({
      payment_account_code: code || null,
      payment_account_name: code ? name : null,
    })
    .eq("tenant_id", session.tenantId);
  if (error) return fail(SCREEN, error.message);

  await recordAudit(session, {
    entity: "xero_connection", entityId: session.tenantId, action: "update",
    summary: code ? `payments post to ${name ?? code}` : "payment account cleared",
  });
  revalidatePath(SCREEN);
  return done(SCREEN, code
    ? `Payments will be posted to ${name ?? code}.`
    : "Payments will not be sent to Xero until an account is chosen.");
}
