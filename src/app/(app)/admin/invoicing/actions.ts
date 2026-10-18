"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { AUTOMATION_KEYS } from "@/lib/domain/automation";
import { describeDbError, done, fail, firstIssue, toObject } from "@/lib/actions";
import {
  normaliseAbn, normaliseBsb, normaliseWebsite, parseInvoiceProfile, type InvoiceProfile,
} from "@/lib/domain/invoice-profile";
import { isValidAbn } from "@/lib/domain/abn";
import { BRANDING_BUCKET, isTenantLogoPath, logoObjectPath, logoRefusal } from "@/lib/branding";
import { imageFormat } from "@/lib/pdf/line-display";

const BACK = "/admin/invoicing";

const line = z.string().trim().max(200).optional().default("");

const schema = z.object({
  abn: line, address_1: line, address_2: line, address_3: line,
  phone: line, email: line, website: line,
  bank_account_name: line, bsb: line, account_number: line,
});

type Client = Awaited<ReturnType<typeof createClient>>;

/** The profile as it stands, so a save of one half never resets the other (the logo, say). */
async function currentProfile(supabase: Client, tenantId: string): Promise<InvoiceProfile> {
  const { data } = await supabase.from("tenants").select("settings").eq("id", tenantId)
    .maybeSingle<{ settings: unknown }>();
  return parseInvoiceProfile(data?.settings);
}

/** `save_tenant_settings` replaces the whole `invoiceProfile` key, so it is always handed all of it. */
async function writeProfile(supabase: Client, tenantId: string, profile: InvoiceProfile) {
  return supabase.rpc("save_tenant_settings", {
    t: tenantId, p_key: "invoiceProfile", p_value: profile,
  });
}

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
  // Eleven digits is not enough (brief 1.1): issuing checks the ATO checksum, and
  // a transposed ABN saved here would block every invoice with nothing on this
  // screen saying why. Refused at the door instead, in the same words.
  if (abn && !isValidAbn(abn)) {
    return fail(BACK, "That ABN does not pass the ATO check — one of the digits is wrong. Check it against the ABN Lookup and try again.");
  }
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

  const website = d.website ? normaliseWebsite(d.website) : null;
  if (d.website && !website) {
    return fail(BACK, "That website does not look like an address — type it the way it reads, like adelaidetowelservice.com.au.");
  }

  const supabase = await createClient();
  const { error: abnError } = await supabase.rpc("save_tenant_abn", { t: session.tenantId, p_abn: abn });
  if (abnError) return fail(BACK, describeDbError(abnError));

  const existing = await currentProfile(supabase, session.tenantId);
  const profile: InvoiceProfile = {
    addressLines: [d.address_1, d.address_2, d.address_3].filter(Boolean),
    phone: d.phone || null, email: d.email || null, website,
    bankAccountName: d.bank_account_name || null, bsb, accountNumber: accountNumber || null,
    // Uploaded on its own form below; a save of the text fields keeps it.
    logoPath: existing.logoPath,
  };
  const { error } = await writeProfile(supabase, session.tenantId, profile);
  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId, action: "update",
    summary: "invoice details updated",
    metadata: { abn_set: Boolean(abn), address_lines: profile.addressLines.length, bank_set: bankParts === 3 },
  });
  revalidatePath(BACK);
  return done(BACK, "Invoice details saved. They print on every invoice from now on.");
}

/**
 * Upload the logo printed top-left on every invoice and credit note (brief 1.10).
 *
 * The file is the tenant's data, so it goes to the private `tenant-branding`
 * bucket (0054) under the tenant's own prefix — written on the caller's
 * RLS-bound client, so the storage policy (Owner only) is what decides, not
 * this action. The format is read from the file's bytes, never its name. The
 * previous logo is removed once the new one is saved, so the bucket holds one.
 */
export async function uploadInvoiceLogo(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return fail(BACK, "Choose a PNG or JPEG file to upload.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const refusal = logoRefusal(bytes);
  if (refusal) return fail(BACK, refusal);
  const format = imageFormat(bytes)!;

  const supabase = await createClient();
  const path = logoObjectPath(session.tenantId, format, Date.now());
  const { error: uploadError } = await supabase.storage.from(BRANDING_BUCKET).upload(path, bytes, {
    contentType: format === "png" ? "image/png" : "image/jpeg", upsert: false,
  });
  if (uploadError) {
    return fail(BACK, "The logo could not be stored. If this keeps happening, the logo storage may not be set up on this deployment yet.");
  }

  const existing = await currentProfile(supabase, session.tenantId);
  const { error } = await writeProfile(supabase, session.tenantId, { ...existing, logoPath: path });
  if (error) {
    await supabase.storage.from(BRANDING_BUCKET).remove([path]);
    return fail(BACK, describeDbError(error));
  }
  if (isTenantLogoPath(session.tenantId, existing.logoPath) && existing.logoPath !== path) {
    await supabase.storage.from(BRANDING_BUCKET).remove([existing.logoPath]);
  }

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId, action: "update",
    summary: "invoice logo uploaded", metadata: { bytes: bytes.length, format },
  });
  revalidatePath(BACK);
  return done(BACK, "Logo saved. It prints on every invoice and credit note from now on.");
}

/** Take the logo off the invoices. The file is removed too — nothing else reads it. */
export async function removeInvoiceLogo(): Promise<void> {
  const session = await assertCapability("admin.write");
  const supabase = await createClient();
  const existing = await currentProfile(supabase, session.tenantId);
  if (!existing.logoPath) return done(BACK, "There is no logo to remove.");

  const { error } = await writeProfile(supabase, session.tenantId, { ...existing, logoPath: null });
  if (error) return fail(BACK, describeDbError(error));
  if (isTenantLogoPath(session.tenantId, existing.logoPath)) {
    await supabase.storage.from(BRANDING_BUCKET).remove([existing.logoPath]);
  }

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId, action: "update",
    summary: "invoice logo removed",
  });
  revalidatePath(BACK);
  return done(BACK, "Logo removed. Invoices print without one.");
}

/**
 * From when an imported invoice counts on Today (brief 1.9). Imported MYOB
 * invoices dated before this day are left out of the Overdue tile and Needs a
 * decision until their balances have been reconciled; moving the date back is
 * how the owner says they have been. Written through `save_tenant_settings`
 * under the `receivables` key, which 0055 adds.
 */
export async function saveReceivablesSettings(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const raw = String(formData.get("ar_trusted_from") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    return fail(BACK, "Pick the date imported balances can be trusted from.");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("save_tenant_settings", {
    t: session.tenantId, p_key: "receivables", p_value: { ar_trusted_from: raw },
  });
  if (error) {
    return fail(BACK, error.code === "22023"
      ? "This setting cannot be saved until the latest database update has been applied."
      : describeDbError(error));
  }

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId, action: "update",
    summary: `imported balances trusted from ${raw}`,
  });
  revalidatePath(BACK);
  revalidatePath("/dashboard");
  return done(BACK, "Saved. Today counts imported invoices from that date on.");
}

/**
 * What the app does on its own (Darshan's BA review, Phase 2). Four switches
 * under the `automation` key, which 0056 adds to `save_tenant_settings`. The
 * form always renders all four, so an absent box means unticked. Defaults —
 * what an unset key reads as — are in `DEFAULT_AUTOMATION`.
 */
export async function saveAutomationSettings(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const value = Object.fromEntries(
    AUTOMATION_KEYS.map((key) => [key, formData.get(key) === "on"]),
  ) as Record<(typeof AUTOMATION_KEYS)[number], boolean>;

  const supabase = await createClient();
  const { error } = await supabase.rpc("save_tenant_settings", {
    t: session.tenantId, p_key: "automation", p_value: value,
  });
  if (error) {
    return fail(BACK, error.code === "22023"
      ? "This setting cannot be saved until the latest database update has been applied."
      : describeDbError(error));
  }

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId, action: "update",
    summary: "automation settings changed", metadata: value,
  });
  revalidatePath(BACK);
  return done(BACK, "Saved. These apply from the next job.");
}
