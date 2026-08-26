"use server";

import { z } from "zod";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { assertCapability, requireSession, ACTIVE_TENANT_COOKIE } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, firstIssue, optionalText, toObject } from "@/lib/actions";
import { platformSettingsSchema } from "./settings-shape";

const PLATFORM = "/platform";
const ADMINS = "/platform/admins";
const SETTINGS = "/platform/settings";

const TENANT_STATUSES = ["active", "suspended", "archived"] as const;

/**
 * Look at a different laundry.
 *
 * Deliberately **not** gated on `platform.*`: somebody who holds a membership
 * in two laundries has always been able to reach both, they just had no way to
 * say which one they wanted — `requireSession()` picked for them. So this is
 * open to any signed-in member and narrows to what they can already see.
 *
 * The cookie is a preference, never a grant. RLS still answers every query, so
 * a hand-edited cookie naming a laundry you have no business in produces empty
 * screens rather than somebody else's data. It is checked here anyway, because
 * a switcher that silently does nothing is worse than one that says no.
 */
export async function switchTenant(formData: FormData): Promise<void> {
  const session = await requireSession();
  const parsed = z.object({ tenant_id: z.string().uuid() }).safeParse(toObject(formData));
  if (!parsed.success) return fail(PLATFORM, firstIssue(parsed.error));

  const supabase = await createClient();
  const { data: tenant } = await supabase
    .from("tenants").select("id, name")
    .eq("id", parsed.data.tenant_id)
    .maybeSingle();
  if (!tenant) return fail(PLATFORM, "You do not have access to that laundry.");

  (await cookies()).set(ACTIVE_TENANT_COOKIE, parsed.data.tenant_id, {
    // Not httpOnly-sensitive and not a credential — but there is no reason for
    // a script to read it either, and `lax` is enough for a same-site switch.
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  if (session.tenantId === parsed.data.tenant_id) {
    return done("/dashboard", `Already looking at ${tenant.name}.`);
  }
  return done("/dashboard", `Now looking at ${tenant.name}.`);
}

const tenantSchema = z.object({
  name: z.string().trim().min(2, "Give the laundry a name"),
  abn: optionalText,
  timezone: z.string().trim().min(3).default("Australia/Adelaide"),
});

/** Add a laundry to this deployment. */
export async function createTenant(formData: FormData): Promise<void> {
  const session = await assertCapability("platform.write");
  const parsed = tenantSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(PLATFORM, firstIssue(parsed.error));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenants")
    .insert({
      name: parsed.data.name,
      abn: parsed.data.abn ?? null,
      timezone: parsed.data.timezone,
    })
    .select("id")
    .single();
  if (error) return fail(PLATFORM, describeDbError(error));

  await recordAudit(session, {
    entity: "tenant", entityId: data.id, action: "create", summary: parsed.data.name,
  });
  revalidatePath(PLATFORM);
  return done(
    PLATFORM,
    `${parsed.data.name} added. Give it an owner from People once you switch to it.`,
    { href: "/admin/users", label: "People" },
  );
}

export async function updateTenant(formData: FormData): Promise<void> {
  const session = await assertCapability("platform.write");
  const parsed = z.object({
    tenant_id: z.string().uuid(),
    name: z.string().trim().min(2, "Give the laundry a name"),
    status: z.enum(TENANT_STATUSES),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(PLATFORM, firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({ name: parsed.data.name, status: parsed.data.status })
    .eq("id", parsed.data.tenant_id);
  if (error) return fail(PLATFORM, describeDbError(error));

  await recordAudit(session, {
    entity: "tenant", entityId: parsed.data.tenant_id, action: "update",
    summary: `${parsed.data.name} — ${parsed.data.status}`,
  });
  revalidatePath(PLATFORM);
  return done(PLATFORM, "Laundry updated.");
}

/**
 * Add another platform administrator, by the address they already sign in with.
 *
 * Unlike `inviteMember`, this does **not** create a login. Reaching every
 * laundry on the deployment is not something to hand to an address somebody
 * typed and nobody has verified — the person must already have an account, and
 * the usual way to get one is to be invited to a laundry first.
 */
export async function addPlatformAdmin(formData: FormData): Promise<void> {
  const session = await assertCapability("platform.write");
  const parsed = z.object({
    email: z.preprocess(
      (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
      z.string().email("Enter a valid email address"),
    ),
    note: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(ADMINS, firstIssue(parsed.error));

  let userId: string;
  try {
    const admin = createAdminClient();
    // `generateLink` resolves the account without sending anything — the same
    // trick `resolveInvitee` uses for an address that already has a login.
    const { data, error } = await admin.auth.admin
      .generateLink({ type: "magiclink", email: parsed.data.email });
    if (error || !data.user) {
      return fail(ADMINS, `${parsed.data.email} has no login yet. Invite them to a laundry first.`);
    }
    userId = data.user.id;
  } catch {
    return fail(ADMINS, "This deployment has no service key set up, so accounts cannot be looked up.");
  }

  const supabase = await createClient();
  const { error } = await supabase.from("platform_admins").insert({
    user_id: userId,
    note: parsed.data.note ?? null,
    created_by: session.userId,
  });
  if (error) return fail(ADMINS, describeDbError(error));

  await recordAudit(session, {
    entity: "platform_admin", entityId: userId, action: "create",
    summary: `${parsed.data.email} can now reach every laundry`,
  });
  revalidatePath(ADMINS);
  return done(ADMINS, `${parsed.data.email} is now a platform administrator.`);
}

/**
 * Take platform access away.
 *
 * The last one cannot be removed, and that rule lives in the database
 * (`guard_last_platform_admin`, 0019) rather than here — removing the last row
 * hides the table from everybody who is left, so there would be no screen able
 * to put it back. The check below is the readable message; the trigger is the
 * boundary.
 */
export async function removePlatformAdmin(formData: FormData): Promise<void> {
  const session = await assertCapability("platform.write");
  const parsed = z.object({ user_id: z.string().uuid() }).safeParse(toObject(formData));
  if (!parsed.success) return fail(ADMINS, firstIssue(parsed.error));

  const supabase = await createClient();
  const { count } = await supabase
    .from("platform_admins").select("user_id", { count: "exact", head: true });
  if ((count ?? 0) <= 1) {
    return fail(ADMINS, "This is the last platform administrator. Add another one first.");
  }

  const { error } = await supabase
    .from("platform_admins").delete().eq("user_id", parsed.data.user_id);
  if (error) return fail(ADMINS, describeDbError(error));

  await recordAudit(session, {
    entity: "platform_admin", entityId: parsed.data.user_id, action: "delete",
    summary: "platform access removed",
  });
  revalidatePath(ADMINS);
  return done(ADMINS, "Platform access removed.");
}

export async function savePlatformSettings(formData: FormData): Promise<void> {
  const session = await assertCapability("platform.write");
  const parsed = platformSettingsSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(SETTINGS, firstIssue(parsed.error));

  const supabase = await createClient();
  // Read-merge-write rather than replace, for the reason 0013 gives about
  // `tenants.settings`: a switch added later must survive a save made by a
  // form that predates it.
  const { data: current } = await supabase
    .from("platform_settings").select("settings").eq("id", true).maybeSingle();

  const merged = { ...(current?.settings ?? {}), ...parsed.data };
  const { error } = await supabase
    .from("platform_settings")
    .update({ settings: merged, updated_by: session.userId })
    .eq("id", true);
  if (error) return fail(SETTINGS, describeDbError(error));

  await recordAudit(session, {
    entity: "platform_settings", entityId: null, action: "update",
    summary: "deployment settings changed",
  });
  revalidatePath(SETTINGS);
  return done(SETTINGS, "Settings saved.");
}
