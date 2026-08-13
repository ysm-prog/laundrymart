"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAudit } from "@/lib/audit";
import { ROLES, ROLE_LABELS } from "@/lib/roles";
import { emailIsConfigured, sendEmail } from "@/lib/email/send";
import { buildInviteEmail } from "@/lib/email/invite-email";
import {
  describeDbError, done, fail, firstIssue, optionalText, optionalUuid, requiredDate, toObject,
} from "@/lib/actions";

const depotSchema = z.object({
  code: z.string().trim().min(1, "A depot code is required").max(16),
  name: z.string().trim().min(2, "Name is required"),
  address_line1: optionalText,
  suburb: optionalText,
  state: optionalText,
  postcode: optionalText,
  contact_name: optionalText,
  contact_phone: optionalText,
  contact_email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().email("Enter a valid email").optional(),
  ),
  timezone: z.string().trim().min(3),
  status: z.enum(["active", "inactive"]),
});

export async function createDepot(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = depotSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/admin/depots", firstIssue(parsed.error));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("depots")
    .insert({ ...parsed.data, tenant_id: session.tenantId, created_by: session.userId })
    .select("id, code")
    .single();
  if (error) return fail("/admin/depots", describeDbError(error));

  await recordAudit(session, { entity: "depot", entityId: data.id, action: "create", summary: data.code });
  revalidatePath("/admin/depots");
  return done("/admin/depots", `Depot ${data.code} created.`);
}

export async function updateDepotStatus(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = z.object({
    id: z.string().uuid(),
    status: z.enum(["active", "inactive", "archived"]),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/admin/depots", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase
    .from("depots").update({ status: parsed.data.status })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) return fail("/admin/depots", describeDbError(error));

  await recordAudit(session, {
    entity: "depot", entityId: parsed.data.id, action: "status_change", summary: parsed.data.status,
  });
  revalidatePath("/admin/depots");
  return done("/admin/depots", "Depot updated.");
}

export async function addHoliday(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = z.object({
    holiday_date: requiredDate,
    name: z.string().trim().min(2, "Give the holiday a name"),
    region: z.string().trim().min(2).max(4),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/admin/holidays", firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase.from("public_holidays").insert({
    ...parsed.data, tenant_id: session.tenantId, created_by: session.userId,
  });
  if (error) return fail("/admin/holidays", describeDbError(error));

  await recordAudit(session, {
    entity: "public_holiday", action: "create",
    summary: `${parsed.data.name} ${parsed.data.holiday_date} (${parsed.data.region})`,
  });
  revalidatePath("/admin/holidays");
  return done("/admin/holidays", "Public holiday added.");
}

export async function removeHoliday(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/admin/holidays", "That holiday could not be found.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("public_holidays").delete()
    .eq("id", id.data).eq("tenant_id", session.tenantId);
  if (error) return fail("/admin/holidays", describeDbError(error));

  await recordAudit(session, { entity: "public_holiday", entityId: id.data, action: "delete" });
  revalidatePath("/admin/holidays");
  return done("/admin/holidays", "Public holiday removed.");
}

/**
 * Invite a teammate by email (roadmap D5 / audit G9).
 *
 * Until now a new person could only be added by someone with database access:
 * the app had no way to create the `memberships` row, so the People screen's
 * own advice was "ask your system administrator". This closes that, and it is
 * the one flow in the app that has to reach the auth provider directly.
 *
 * Three deliberate choices:
 *
 * - **The membership row is written with the RLS-bound client**, not the
 *   service-role one, even though the service key is already in hand. The
 *   `memberships_admin` policy from 0001 permits exactly this insert for
 *   exactly these roles, so the database check runs rather than being bypassed
 *   by a client that happens to be nearby.
 * - **The service-role client is used for two things only**: creating the auth
 *   user (nothing else can) and one cross-tenant safety check, described below.
 * - **No link is put in front of the browser.** It is emailed when a provider is
 *   configured, and otherwise dropped — the person signs in from the login
 *   screen with "Email me a sign-in link", which is the same door and already
 *   worked. A one-time credential in a flash cookie, on a screen, or in the
 *   history of whoever is sharing their display is not worth the convenience.
 */
const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  role: z.enum(ROLES),
  depot_id: optionalUuid,
});

/** GoTrue's way of saying the address already has a login. */
function alreadyRegistered(error: { code?: string; message: string }): boolean {
  return error.code === "email_exists"
    || /already (been )?registered|already exists/i.test(error.message);
}

export async function inviteMember(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = inviteSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/admin/users", firstIssue(parsed.error));

  const { email, role, depot_id: depotId } = parsed.data;
  const origin = (await headers()).get("origin") ?? "";
  const admin = createAdminClient();

  // Creates the auth user without sending anything — this app decides whether
  // an email goes out, and through which provider.
  let link: string | null = null;
  let userId: string | null = null;

  const invited = await admin.auth.admin.generateLink({
    type: "invite", email, options: { redirectTo: `${origin}/auth/callback` },
  });

  if (invited.error && !alreadyRegistered(invited.error)) {
    console.error("invite link generation failed", invited.error.message);
    return fail("/admin/users", "That invite could not be created. Try again in a moment.");
  }

  if (invited.error) {
    // The address already has a login — from another business on this
    // deployment, from an earlier invite here, or because they typed it into
    // the sign-in page themselves and got as far as "no membership". A magic
    // link resolves the same person without creating a second account. It is a
    // live credential, so it is generated here and only ever leaves the process
    // further down, after the checks below have passed.
    const existing = await admin.auth.admin.generateLink({
      type: "magiclink", email, options: { redirectTo: `${origin}/auth/callback` },
    });
    if (existing.error) {
      console.error("magic link generation failed", existing.error.message);
      return fail("/admin/users", "That address already has a login, and it could not be reached.");
    }
    userId = existing.data.user?.id ?? null;
    link = existing.data.properties?.action_link ?? null;
  } else {
    userId = invited.data.user?.id ?? null;
    link = invited.data.properties?.action_link ?? null;
  }

  if (!userId) return fail("/admin/users", "That invite could not be created. Try again in a moment.");

  // The one query in this action that cannot filter on `tenant_id`, and the
  // reason is the tenancy model itself: `requireSession()` resolves a person to
  // *one* membership, and a second one in another business would make which
  // business they land in arbitrary. So this asks whether this user belongs
  // anywhere else and refuses if they do, rather than quietly creating an
  // account that signs into the wrong company. It reads one column for one user
  // id and never names the other tenant.
  const { data: elsewhere, error: lookupError } = await admin
    .from("memberships").select("tenant_id").eq("user_id", userId);
  // Fail closed: an unreadable answer here is not "they belong nowhere". Taking
  // it as such is exactly how the ambiguous second membership gets created.
  if (lookupError) {
    console.error("membership lookup failed", lookupError.message);
    return fail("/admin/users", "That invite could not be completed. Try again in a moment.");
  }
  const otherTenant = (elsewhere ?? []).some((row) => row.tenant_id !== session.tenantId);
  if (otherTenant) {
    return fail(
      "/admin/users",
      "That email already belongs to another business using LaundryMart. "
      + "Ask them to use a different address.",
    );
  }
  if ((elsewhere ?? []).length > 0) {
    return fail(
      "/admin/users",
      `${email} is already on your team — change their role in the list below.`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.from("memberships").insert({
    user_id: userId, tenant_id: session.tenantId, role, depot_id: depotId ?? null,
  });
  if (error) return fail("/admin/users", describeDbError(error));

  await recordAudit(session, {
    entity: "membership", entityId: userId, action: "create",
    summary: `${email} invited as ${ROLE_LABELS[role]}`,
  });
  revalidatePath("/admin/users");

  if (!link || !emailIsConfigured()) {
    return done(
      "/admin/users",
      `${email} can now sign in. Tell them to go to the sign-in page, type that address `
      + "and choose “Email me a sign-in link”.",
    );
  }

  const message = buildInviteEmail({
    tenantName: session.tenantName,
    invitedBy: session.email,
    actionLink: link,
    signInUrl: `${origin}/login`,
  });
  const sent = await sendEmail({ to: email, ...message });

  await recordAudit(session, {
    entity: "membership", entityId: userId,
    action: sent.ok ? "send" : "send_failed",
    summary: sent.ok ? `invite emailed to ${email}` : `invite email failed: ${sent.error}`,
  });

  if (!sent.ok) {
    return done(
      "/admin/users",
      `${email} can now sign in, but the invite email could not be sent. Tell them to go `
      + "to the sign-in page and choose “Email me a sign-in link”.",
    );
  }
  return done("/admin/users", `Invite sent to ${email}.`);
}

export async function updateMembership(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = z.object({
    user_id: z.string().uuid(),
    role: z.enum(ROLES),
    depot_id: optionalUuid,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/admin/users", firstIssue(parsed.error));

  if (parsed.data.user_id === session.userId && parsed.data.role !== session.role) {
    return fail("/admin/users", "You cannot change your own role — ask another administrator.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("memberships")
    .update({ role: parsed.data.role, depot_id: parsed.data.depot_id ?? null })
    .eq("user_id", parsed.data.user_id).eq("tenant_id", session.tenantId);
  if (error) return fail("/admin/users", describeDbError(error));

  await recordAudit(session, {
    entity: "membership", entityId: parsed.data.user_id, action: "update", summary: parsed.data.role,
  });
  revalidatePath("/admin/users");
  return done("/admin/users", "Access updated.");
}
