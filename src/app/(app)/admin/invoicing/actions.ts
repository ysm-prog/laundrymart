"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, firstIssue, toObject } from "@/lib/actions";
import { normaliseAbn, normaliseBsb } from "@/lib/domain/invoice-profile";

const BACK = "/admin/invoicing";

const line = z.string().trim().max(200).optional().default("");

const schema = z.object({
  abn: line, address_1: line, address_2: line, address_3: line,
  phone: line, email: line,
  bank_account_name: line, bsb: line, account_number: line,
});

/**
 * Save what a tax invoice says about the business: ABN, address, contact and
 * the bank details customers pay into. Owner only (`admin.write`), and written
 * through `save_tenant_abn` / `save_tenant_settings` (0052) because `tenants`
 * has no update policy for an Owner who is not a platform admin.
 */
export async function saveInvoiceProfile(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = schema.safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));
  const d = parsed.data;

  const abn = d.abn ? normaliseAbn(d.abn) : null;
  if (d.abn && !abn) return fail(BACK, "An ABN is 11 digits — check the number and try again.");
  const bsb = d.bsb ? normaliseBsb(d.bsb) : null;
  if (d.bsb && !bsb) return fail(BACK, "A BSB is 6 digits, like 062-000.");
  const accountNumber = d.account_number.replace(/\s/g, "");
  if (accountNumber && !/^\d{4,10}$/.test(accountNumber)) {
    return fail(BACK, "An account number is 4 to 10 digits.");
  }
  const bankParts = [d.bank_account_name, bsb, accountNumber].filter(Boolean).length;
  if (bankParts > 0 && bankParts < 3) {
    return fail(BACK, "Fill in all three bank details — account name, BSB and account number — or leave all three blank.");
  }

  const supabase = await createClient();
  const { error: abnError } = await supabase.rpc("save_tenant_abn", { t: session.tenantId, p_abn: abn });
  if (abnError) return fail(BACK, describeDbError(abnError));

  const profile = {
    addressLines: [d.address_1, d.address_2, d.address_3].filter(Boolean),
    phone: d.phone || null, email: d.email || null,
    bankAccountName: d.bank_account_name || null, bsb, accountNumber: accountNumber || null,
  };
  const { error } = await supabase.rpc("save_tenant_settings", {
    t: session.tenantId, p_key: "invoiceProfile", p_value: profile,
  });
  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId, action: "update",
    summary: "invoice details updated",
    metadata: { abn_set: Boolean(abn), address_lines: profile.addressLines.length, bank_set: bankParts === 3 },
  });
  revalidatePath(BACK);
  return done(BACK, "Invoice details saved. They print on every invoice from now on.");
}
