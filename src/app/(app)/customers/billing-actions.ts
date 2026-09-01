"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  count, describeDbError, done, fail, firstIssue, optionalText, optionalUuid, toObject,
} from "@/lib/actions";
import { BILLING_METHODS, BILLING_METHOD_LABELS } from "@/lib/domain/billing";

/**
 * The customer's Billing & Pricing settings.
 *
 * Kept in its own `"use server"` file rather than added to `customers/actions.ts`
 * because the capability in front of it is different: editing a customer's name
 * and sites is `customers.write` (dispatch and the counter hold it), and this is
 * `billing.write` (they do not). Two capabilities in one file is how the wrong
 * one eventually gets copied onto a new action.
 *
 * **Which rate card a customer is on is editable, and always will be.** That is
 * the whole design: a price changes here, and no invoice raised before today
 * moves, because what an invoice charged was frozen onto the job at approval
 * (`job_charge_snapshots`, migration 0017) rather than read back from this row.
 */
export async function updateCustomerBilling(formData: FormData): Promise<void> {
  const session = await assertCapability("billing.write");
  const parsed = z.object({
    id: z.string().uuid(),
    billing_method: z.enum(BILLING_METHODS),
    // "" is the real answer here — a customer with no rate card yet is normal,
    // and their jobs simply arrive at review unpriced for somebody to price.
    rate_card_agreement_id: optionalUuid,
    billing_email: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().email("That is not a valid email address").optional(),
    ),
    payment_terms_days: count,
    xero_contact_id: optionalText,
    xero_contact_name: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) {
    const id = formData.get("id");
    return fail(typeof id === "string" ? `/customers/${id}` : "/customers", firstIssue(parsed.error));
  }

  const detail = `/customers/${parsed.data.id}`;
  const supabase = await createClient();

  const { data: before } = await supabase
    .from("customers")
    .select("business_name, billing_method, rate_card_agreement_id, payment_terms_days")
    .eq("tenant_id", session.tenantId)
    .eq("id", parsed.data.id)
    .maybeSingle<{
      business_name: string; billing_method: string;
      rate_card_agreement_id: string | null; payment_terms_days: number;
    }>();
  if (!before) return fail("/customers", "That customer could not be found.");

  const { error } = await supabase
    .from("customers")
    .update({
      billing_method: parsed.data.billing_method,
      // The trigger `guard_customers_rate_card` refuses a card belonging to
      // another customer, so a tampered form field is rejected by the database
      // rather than trusted because the select only listed the right ones.
      rate_card_agreement_id: parsed.data.rate_card_agreement_id ?? null,
      billing_email: parsed.data.billing_email ?? null,
      payment_terms_days: parsed.data.payment_terms_days,
      xero_contact_id: parsed.data.xero_contact_id ?? null,
      xero_contact_name: parsed.data.xero_contact_name ?? null,
    })
    .eq("id", parsed.data.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(detail, describeDbError(error));

  // Worth an audit row on its own: changing how somebody is billed, or which
  // rate card prices them, is the change most likely to be queried later.
  await recordAudit(session, {
    entity: "customer", entityId: parsed.data.id, action: "update",
    summary: `${before.business_name}: billing settings`,
    metadata: {
      billing_method: { from: before.billing_method, to: parsed.data.billing_method },
      rate_card: {
        from: before.rate_card_agreement_id,
        to: parsed.data.rate_card_agreement_id ?? null,
      },
      payment_terms_days: { from: before.payment_terms_days, to: parsed.data.payment_terms_days },
    },
  });

  revalidatePath(detail);
  return done(detail,
    `Billing settings saved — ${BILLING_METHOD_LABELS[parsed.data.billing_method].toLowerCase()}.`);
}
