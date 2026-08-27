"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAudit } from "@/lib/audit";
import { sendInvite, sendSignInLink } from "@/lib/auth/send-link";
import { requestOrigin } from "@/lib/auth/request-origin";
import { listMembers } from "@/lib/directory";
import { inviteFailureMessage } from "@/lib/auth/magic-link";
import { createLoginFailureMessage, passwordProblem } from "@/lib/auth/passwords";
import { MEMBERSHIP_ROLES, membershipRolesWith, type MembershipRole } from "@/lib/roles";
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
const ADMIN_ROLES = membershipRolesWith("admin.write");

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
  nextRole: MembershipRole | null,
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
    full_name: optionalText,
    role: z.enum(MEMBERSHIP_ROLES),
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

  // The name goes first, so a failure to save it refuses the whole change
  // rather than leaving the row half-saved and the message about the half that
  // did not land.
  if (parsed.data.full_name) {
    const named = await setMemberName(parsed.data.user_id, parsed.data.full_name);
    if (!named.ok) return fail(PEOPLE, named.message);
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
  // Required, and that is the point of asking. Every screen that has to put a
  // person beside a job — the assignment picker, the completion picker, the
  // activity log — has only ever had an address or eight characters of a UUID
  // to show. A name is what those screens are for, so it is collected once at
  // the moment somebody is added rather than reconstructed later.
  full_name: z.string().trim().min(2, "Enter the person's name"),
  role: z.enum(MEMBERSHIP_ROLES),
  depot_id: optionalUuid,
});

/**
 * The same four questions as an invitation, plus the password.
 *
 * `password` is a bare string on purpose. Every other string helper in this
 * file trims — `optionalText` folds `""` to absent, `z.string().trim()` would
 * strip the ends — and a password is the exact bytes the administrator chose,
 * so any of them would quietly store a different credential from the one that
 * was typed. Whether those bytes are acceptable is `passwordProblem`'s to say
 * (`lib/auth/passwords.ts`), which is also where the surrounding-whitespace
 * case is refused out loud rather than resolved silently either way.
 *
 * A missing field reads as `""` rather than failing the parse, so the operator
 * gets that module's sentence — which names the other button — instead of Zod's
 * account of a field they can see is empty.
 */
const passwordLoginSchema = inviteSchema.extend({
  password: z.preprocess((v) => (typeof v === "string" ? v : ""), z.string()),
});

/**
 * Set what a person is called.
 *
 * The name is read out of `auth.users` by a definer function (0030) and written
 * through the auth admin API, which is the asymmetry worth knowing about: that
 * table belongs to Supabase's own auth role, so nothing this deployment owns may
 * update it directly. Existing metadata is spread back in so a key this app does
 * not know about — the `role_profile` marker the seed script writes, say — is not
 * dropped by a rename.
 */
async function setMemberName(
  userId: string, fullName: string, existing?: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { ok: false, message: "This deployment has no service key set up, so names cannot be changed here yet." };
  }

  const { error } = await admin.auth.admin.updateUserById(userId, {
    user_metadata: { ...(existing ?? {}), full_name: fullName },
  });
  if (error) return { ok: false, message: `That name could not be saved. ${error.message}` };
  return { ok: true };
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
  const { email, full_name, role, depot_id } = parsed.data;

  // The two ways in share one form and one set of questions (see the People
  // screen), so the password box is on screen when this action runs. Ignoring a
  // filled-in one would be the worst outcome available: the invitation goes,
  // the administrator believes they set a password, and they hand over a
  // credential this app never stored. Refuse and name the button that uses it.
  const typedPassword = formData.get("password");
  if (typeof typedPassword === "string" && typedPassword !== "") {
    return fail(
      PEOPLE,
      "You typed a password, so nothing was sent. Press Create login to use it, "
        + "or clear the box to email them a link instead.",
    );
  }

  // Minted here and emailed by this app's own provider — Supabase's built-in
  // mailer needs custom SMTP this deployment has never had, so before this every
  // invitation was a form that reported success and sent nothing.
  const invitee = await sendInvite({
    email,
    fullName: full_name,
    tenantName: session.tenantName,
    invitedBy: session.email ?? undefined,
    origin: await requestOrigin(),
  });
  if (!invitee.ok) return fail(PEOPLE, inviteFailureMessage(invitee.failure));

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
    summary: `${full_name} (${email}) invited as ${role}`,
  });

  revalidatePath(PEOPLE);
  return done(
    PEOPLE,
    invitee.emailed
      ? `Invitation emailed to ${full_name} at ${email}. They can sign in as soon as they follow the link.`
      : `${full_name} already had a login, so no email was sent — they have access now.`,
  );
}

/**
 * Create a login with a password an administrator sets, here and now.
 *
 * The second way onto this laundry's list, beside the invitation — adopted from
 * `ysm-prog/ysm-hub`'s `api/create-staff.js`, which is the same act in that
 * product. It exists because an invitation hands over a *link* and there are
 * real cases where the owner needs to hand over a *credential*: a counter hand
 * with no work email, somebody being set up in the room, or a round's shared
 * tablet. On 2026-08-27 this laundry's first two real staff had to be written
 * in by hand SQL for exactly that reason, which is the argument for the screen
 * being able to do it.
 *
 * ## What it does not change
 *
 * **The authority is the invitation's, unchanged.** Same `admin.write` gate,
 * same `MEMBERSHIP_ROLES` picker, same last-administrator rules elsewhere on
 * the screen. This is a different *delivery*, not a wider power.
 *
 * ysm-hub additionally refuses to let a manager create anything but
 * `shop_staff`, so a lesser role cannot mint an admin and climb. That guard has
 * **no analogue here and is deliberately not ported**: `membershipRolesWith(
 * "admin.write")` is `["super_admin"]` alone — no lesser membership role can
 * add anybody at all — so the escalation it prevents is unreachable. A guard
 * against an impossible state reads as protection and is really just a branch
 * nobody can test. `roles.test.ts` pins that set, so if a second role ever gains
 * `admin.write` a test fails and this comment is what to come back to.
 *
 * ## What it does that ysm-hub does not
 *
 * **A failed membership insert takes the login with it.** Creating the auth user
 * is what makes the rest recoverable-or-not: an `auth.users` row with no
 * membership is a login that signs in successfully and dead-ends on "not linked
 * to a laundry yet", and the retry answers "that address already has a login" —
 * which is precisely the message that stops an administrator finishing the job.
 * ysm-hub returns `User created but profile update failed` and leaves the orphan
 * behind. §10c already settled this for the invitation path, where a refused
 * send deletes the login it just minted; the same reasoning applies here, so the
 * same thing happens.
 */
export async function createMemberWithPassword(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = passwordLoginSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(PEOPLE, firstIssue(parsed.error));
  const { email, full_name, role, depot_id, password } = parsed.data;

  // Stated once, in `lib/auth/passwords.ts`, and checked here rather than in the
  // Zod schema so the sentence the operator reads is the module's own — the
  // whole point being that this app does not repeat ysm-hub's split rule, where
  // the form says six characters and the server says ten.
  const problem = passwordProblem(password);
  if (problem) return fail(PEOPLE, problem);

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return fail(PEOPLE, "This deployment has no service key set up, so a login cannot be created here yet.");
  }

  // `email_confirm: true` because an administrator is standing there setting
  // them up: there is nothing to confirm and no mail to wait for. That is also
  // what makes this path work on a deployment with no mail provider at all.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // The name is why the invitation asks for one too. Every screen that puts a
    // person beside a job reads `user_metadata.full_name` first
    // (`memberDisplayName`), and it never invents a name from an email local
    // part — so a login created without one renders as an address for ever.
    user_metadata: { full_name },
  });
  if (createError || !created?.user) {
    return fail(PEOPLE, createLoginFailureMessage(createError?.message));
  }

  // Through the caller's **own RLS-bound client**, exactly as `inviteMember`
  // does: which laundry somebody joins is the database's decision, not a server
  // action's. The admin client above bypasses RLS and is used for the one thing
  // only it can do — writing `auth.users`.
  const supabase = await createClient();
  const { error } = await supabase.from("memberships").insert({
    user_id: created.user.id,
    tenant_id: session.tenantId,
    role,
    depot_id: depot_id ?? null,
  });
  if (error) {
    await admin.auth.admin.deleteUser(created.user.id);
    return fail(PEOPLE, describeDbError(error));
  }

  // Never the password. This message rides a flash cookie that is **not**
  // httpOnly (§2) and survives a redirect, so putting the credential in it would
  // write it into the browser's cookie jar and into anything reading the
  // response. The administrator typed it; they have it.
  await recordAudit(session, {
    entity: "membership", entityId: created.user.id, action: "create",
    summary: `${full_name} (${email}) created with a password as ${role}`,
  });

  revalidatePath(PEOPLE);
  return done(
    PEOPLE,
    `${full_name} can sign in now with the password you set. `
      + "Ask them to change it once they are in.",
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
/**
 * Email one of your people a link that signs them in.
 *
 * The missing rung. An invitation only ever goes out once, so until now a
 * person who never opened theirs, or who has simply lost their password, had
 * no way back in that an owner could offer — the People screen could change
 * their role and take their access away and nothing in between.
 *
 * It exists now because it *can*: the same `sendSignInLink` the login page uses
 * needs no SMTP, so an owner can get anybody in from the screen they are
 * already looking at. It is also how the four board logins (§24) stop sharing
 * one bootstrap password — send each round its own link and let it set one.
 *
 * Deliberately not enumeration-guarded like the login form: the address is
 * already on the administrator's own screen, so there is nothing here they
 * could learn that the row above the button has not already told them.
 */
export async function sendMemberSignInLink(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = z.object({ user_id: z.string().uuid() }).safeParse(toObject(formData));
  if (!parsed.success) return fail(PEOPLE, firstIssue(parsed.error));

  // Resolve the address from **this laundry's own directory** rather than
  // trusting the posted id. `tenant_members()` is scoped to a laundry the
  // caller belongs to (0030), so an id from anywhere else resolves to nothing
  // at all instead of quietly mailing a stranger a way into somebody's app.
  const member = (await listMembers()).find((row) => row.id === parsed.data.user_id);
  if (!member?.email) {
    return fail(PEOPLE, "That person is not on this laundry's list, so nothing was sent.");
  }

  const result = await sendSignInLink({
    email: member.email,
    origin: await requestOrigin(),
    tenantName: session.tenantName,
  });
  if (!result.ok) return fail(PEOPLE, inviteFailureMessage(result.failure));

  await recordAudit(session, {
    entity: "membership", entityId: parsed.data.user_id, action: "update",
    summary: `sign-in link emailed to ${member.email}`,
  });

  return done(PEOPLE, `A sign-in link is on its way to ${member.email}.`);
}

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
