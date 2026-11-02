import { env } from "@/lib/env";
import { createInvoiceToken } from "./link-token";

/**
 * The address a text message sends a customer to. The signing secret is derived
 * from the service-role key inside `link-token.ts`, so nothing new has to be
 * configured; rotating that key retires every link already sent, and the customer
 * asks for a new one.
 */
export function invoiceLink(origin: string, invoiceId: string): string {
  return `${origin.replace(/\/$/, "")}/i/${createInvoiceToken(invoiceId, env.SUPABASE_SERVICE_ROLE_KEY)}`;
}
