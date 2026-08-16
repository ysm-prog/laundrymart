"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAudit } from "@/lib/audit";
import { ROLES, rolesWith, type Role } from "@/lib/roles";
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

const PEOPLE = "/admin/users";

/** The roles that can manage the tenant's logins. Derived, never hand-listed. */
const ADMIN_ROLES = rolesWith("admin.write");

/**
 * True when this change would leave nobody able to manage the tenant's people.
 *
 * Only reachable now that access can be removed as well as granted: with two
 * administrators, each could demote or remove the other, and the second one to
 * act would lock the whole tenant out of its own People screen with no way back
 * short of a database console. `updateMembership` already refuses to change
 * *your own* role, which is what made this safe before; removing somebody else
 * is the hole that opens.
 *
 * `nextRole` is null for a removal. Counted through the caller's own RLS-bound
 * client, so it can only ever see its own tenant's rows.
 */
async function wouldStrandTenant(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  userId: string,
  nextRole: Role | null,
): Promise<boolean> {
  // Keeping their admin role (or gaining one) can never strand anyone.
  if (nextRole && ADMIN_ROLES.includes(nextRole)) return false;

  const { data, error } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .in("role", ADMIN_ROLES)
    .neq("user_id", userId)
    .limit(1);
  // A failed count must not be read as "nobody is left" — that would refuse a
  // legitimate change on a transient error. RLS is still the real boundary.
  if (error) return false;
  return (data ?? []).length === 0;
}

export async function updateMembership(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = z.object({
    user_id: z.string().uuid(),
    role: z.enum(ROLES),
    depot_id: optionalUuid,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(PEOPLE, firstIssue(parsed.error));

  if (parsed.data.user_id === session.userId && parsed.data.role !== session.role) {
    return fail(PEOPLE, "You cannot change your own role — ask another administrator.");
  }

  const supabase = await createClient();
  if (await wouldStrandTenant(supabase, session.tenantId, parsed.data.user_id, parsed.data.role)) {
    return fail(PEOPLE, "This is your last administrator. Give someone else that role first.");
  }

  const { error } = await supabase
    .from("memberships")
    .update({ role: parsed.data.role, depot_id: parsed.data.depot_id ?? null })
    .eq("user_id", parsed.data.user_id).eq("tenant_id", session.tenantId);
  if (error) return fail(PEOPLE, describeDbError(error));

  await recordAudit(session, {
    entity: "membership", entityId: parsed.data.user_id, action: "update", summary: parsed.data.role,
  });
  revalidatePath(PEOPLE);
  return done(PEOPLE, "Access updated.");
}

const inviteSchema = z.object({
  email: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.string().email("Enter a valid email address"),
  ),
  role: z.enum(ROLES),
  depot_id: optionalUuid,
});

/**
 * Where the invitation link lands.
 *
 * `/auth/invite`, **not** the `/auth/callback` the magic link uses. Supabase
 * bounces an accepted invitation back with the session in the URL fragment,
 * which never reaches the server; and an invite cannot use the PKCE `?code=`
 * flow either, because the browser that sent the invitation is not the browser
 * that opens it, so no code verifier is waiting. `/auth/invite` is the one
 * client-rendered screen in the app for exactly that reason.
 *
 * The origin is read off the request rather than out of an environment
 * variable, so a preview deployment invites into itself instead of mailing a
 * link to production — and so nothing new has to be configured for the feature
 * to work at all. Supabase must still list this URL under its allowed redirect
 * URLs, or it falls back to the project's Site URL.
 */
async function inviteRedirect(): Promise<string> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  return `${protocol}://${host}/auth/invite`;
}

type Invitee =
  | { ok: true; userId: string; invited: boolean }
  | { ok: false; message: string };

/** Someone can already sign in with this address — here before, or elsewhere. */
function isExistingAccount(error: { code?: string; status?: number; message: string }): boolean {
  if (error.code === "email_exists" || error.code === "user_already_exists") return true;
  return /already (been )?registered|already exists/i.test(error.message);
}

/**
 * The login behind an invited address, creating it if there is none.
 *
 * This is the one part of the flow that needs the service role: creating an
 * `auth.users` row is not something a signed-in member can do through RLS. The
 * **membership** row is deliberately not written here — it goes in through the
 * caller's own RLS-bound client, so which tenant a person joins stays the
 * database's decision rather than this file's.
 */
async function resolveInvitee(email: string, redirectTo: string): Promise<Invitee> {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return {
      ok: false,
      message: "This deployment has no service key set up, so invitations cannot be sent yet.",
    };
  }

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (!error && data.user) return { ok: true, userId: data.user.id, invited: true };

  // They already have a login — with another laundry on this deployment, or
  // here before their access was removed. Ask the auth API who they are without
  // sending anything: an invitation mail would be wrong (they have a password
  // already) and issuing one would only invalidate a link they may still hold.
  if (error && isExistingAccount(error)) {
    const { data: link, error: linkError } =
      await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (!linkError && link.user) return { ok: true, userId: link.user.id, invited: false };
  }

  return {
    ok: false,
    message: error
      ? `The invitation could not be sent. ${error.message}`
      : "The invitation could not be sent.",
  };
}

/**
 * Invite somebody to this laundry by email (roadmap D5).
 *
 * Until now the People screen could only re-role people who had somehow already
 * signed in — the page said accounts were "set up by your system administrator",
 * which for an owner running a three-person laundry meant they could not add
 * their own counter staff or their own driver at all.
 */
export async function inviteMember(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = inviteSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(PEOPLE, firstIssue(parsed.error));
  const { email, role, depot_id } = parsed.data;

  const invitee = await resolveInvitee(email, await inviteRedirect());
  if (!invitee.ok) return fail(PEOPLE, invitee.message);

  const supabase = await createClient();

  // Refuse rather than upsert. Someone typing an address that is already on the
  // list means to add a person, not to silently re-role the one who is there —
  // and the row below is where that change belongs, beside their current role.
  const { data: existing } = await supabase
    .from("memberships").select("user_id")
    .eq("user_id", invitee.userId).eq("tenant_id", session.tenantId)
    .maybeSingle();
  if (existing) {
    return fail(PEOPLE, `${email} is already on your team — change their role in the list below.`);
  }

  const { error } = await supabase.from("memberships").insert({
    user_id: invitee.userId,
    tenant_id: session.tenantId,
    role,
    depot_id: depot_id ?? null,
  });
  if (error) return fail(PEOPLE, describeDbError(error));

  await recordAudit(session, {
    entity: "membership", entityId: invitee.userId, action: "create",
    summary: `${email} invited as ${role}`,
  });

  revalidatePath(PEOPLE);
  return done(
    PEOPLE,
    invitee.invited
      ? `Invitation emailed to ${email}. They can sign in as soon as they follow the link.`
      : `${email} already had a login, so no email was sent — they have access now.`,
  );
}

/**
 * Take somebody off this laundry's list.
 *
 * Deletes the membership and nothing else: their login survives, because it may
 * be their access to another laundry on the same deployment, and because a
 * person who comes back should not need a new account. Every row they wrote —
 * jobs, stops, audit entries — keeps pointing at them, which is the whole point
 * of an audit trail.
 */
export async function removeMember(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = z.object({ user_id: z.string().uuid() })
    .safeParse(toObject(formData));
  if (!parsed.success) return fail(PEOPLE, firstIssue(parsed.error));

  if (parsed.data.user_id === session.userId) {
    return fail(PEOPLE, "You cannot remove your own access — ask another administrator.");
  }

  const supabase = await createClient();
  if (await wouldStrandTenant(supabase, session.tenantId, parsed.data.user_id, null)) {
    return fail(PEOPLE, "This is your last administrator. Give someone else that role first.");
  }

  const { error } = await supabase
    .from("memberships").delete()
    .eq("user_id", parsed.data.user_id).eq("tenant_id", session.tenantId);
  if (error) return fail(PEOPLE, describeDbError(error));

  await recordAudit(session, {
    entity: "membership", entityId: parsed.data.user_id, action: "delete",
    summary: "access removed",
  });

  revalidatePath(PEOPLE);
  return done(PEOPLE, "That person can no longer sign in to this laundry.");
}
