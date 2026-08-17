"use server";

import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { recordAudit } from "@/lib/audit";
import { done, fail } from "@/lib/actions";
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
