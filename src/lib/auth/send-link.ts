/**
 * Sending an invitation or a sign-in link **through this app's own mail
 * provider**, rather than asking Supabase to send it.
 *
 * Server-only: it holds the service role and the Resend key. The rules it obeys
 * are next door in `auth-links.ts` and `lib/email/auth-email.ts`, both pure and
 * both tested — this file is the part that talks to two services, which is the
 * part a unit test cannot reach (it imports `lib/env`).
 *
 * See `auth-links.ts` for why: in short, Supabase's built-in mailer needs custom
 * SMTP that this deployment has never had, so no auth email has ever left the
 * project — while invoices and customer mail have been going out through Resend
 * the whole time. `generateLink()` mints a link and sends nothing, which is
 * exactly the seam that lets one sender do both jobs.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { emailIsConfigured, sendEmail } from "@/lib/email/send";
import { buildAuthEmail } from "@/lib/email/auth-email";
import {
  authLinkUrl, classifyLinkError, GENERATE_TYPE,
  type AuthApiError, type LinkFailure,
} from "@/lib/auth/auth-links";

/** What the product is called to somebody who has not seen it yet. */
const PRODUCT_NAME = "Electro Services";

export type SendLinkResult =
  | { ok: true; userId: string; emailed: boolean }
  | { ok: false; failure: LinkFailure };

type Admin = ReturnType<typeof createAdminClient>;

/** Null when the deployment has no service key — nothing here works without it. */
function adminOrNull(): Admin | null {
  try {
    return createAdminClient();
  } catch {
    return null;
  }
}

/** Someone can already sign in with this address — here before, or elsewhere. */
function isExistingAccount(error: AuthApiError): boolean {
  if (error.code === "email_exists" || error.code === "user_already_exists") return true;
  return /already (been )?registered|already exists/i.test(error.message ?? "");
}

/**
 * The checks that must pass *before* a link is minted.
 *
 * Order matters for the invitation: minting an invite link **creates the
 * login**, so discovering afterwards that we cannot email it would leave a real
 * `auth.users` row nobody can reach and no screen lists.
 */
function preflight(origin: string): LinkFailure | null {
  if (!emailIsConfigured()) return { reason: "not-configured" };
  if (!origin) return { reason: "no-origin" };
  return null;
}

/**
 * Invite somebody, creating their login if there is none.
 *
 * The **membership** row is deliberately not written here — it goes in through
 * the caller's own RLS-bound client, so which laundry a person joins stays the
 * database's decision rather than this file's. Unchanged from the day the
 * invitation flow was built; only the sender moved.
 */
export async function sendInvite(input: {
  email: string;
  fullName: string;
  tenantName: string;
  invitedBy?: string;
  origin: string;
}): Promise<SendLinkResult> {
  const blocked = preflight(input.origin);
  if (blocked) return { ok: false, failure: blocked };

  const admin = adminOrNull();
  if (!admin) return { ok: false, failure: { reason: "no-service-key" } };

  const { data, error } = await admin.auth.admin.generateLink({
    type: GENERATE_TYPE.invite,
    email: input.email,
    options: {
      // Stored on the login rather than on the membership: a person is one
      // person, and a second copy of their name per laundry is a second thing
      // to keep in step. `tenant_members()` (0030) reads it straight back out.
      data: { full_name: input.fullName },
    },
  });

  if (!error && data?.user && data.properties?.hashed_token) {
    const link = authLinkUrl(input.origin, "invite", data.properties.hashed_token);
    if (!link) return { ok: false, failure: { reason: "no-origin" } };

    const message = buildAuthEmail({
      kind: "invite",
      tenantName: input.tenantName,
      recipientName: input.fullName,
      invitedBy: input.invitedBy,
      link,
    });
    const sent = await sendEmail({ to: input.email, ...message });

    if (!sent.ok) {
      // The link we just minted created this login, and nothing points at it
      // yet — the membership insert is the caller's next step and has not run.
      // Leaving it would be worse than removing it: a retry would come back
      // "they already have a login", which is the one answer that stops the
      // administrator sending the email that never went. So the half-done
      // invitation is undone, and the retry behaves like the first attempt.
      await admin.auth.admin.deleteUser(data.user.id).catch(() => {});
      return { ok: false, failure: { reason: "send-refused", detail: sent.error } };
    }

    return { ok: true, userId: data.user.id, emailed: true };
  }

  // They already have a login — with another laundry on this deployment, or
  // here before their access was removed. Ask the auth API who they are without
  // sending anything: an invitation would be wrong (they have a password
  // already) and issuing one would only invalidate a link they may still hold.
  if (error && isExistingAccount(error)) {
    const { data: found, error: lookupError } = await admin.auth.admin.generateLink({
      type: GENERATE_TYPE["sign-in"],
      email: input.email,
    });
    if (!lookupError && found?.user) {
      // Their login is theirs and may serve another laundry, so an existing
      // name is left alone; one is only set where there is none to overwrite.
      // Existing metadata is spread back in so a key this app does not know
      // about — the `role_profile` marker the seed script writes, say — is not
      // dropped by filling in a blank.
      if (!nameOf(found.user.user_metadata)) {
        await admin.auth.admin.updateUserById(found.user.id, {
          user_metadata: { ...(found.user.user_metadata ?? {}), full_name: input.fullName },
        });
      }
      return { ok: true, userId: found.user.id, emailed: false };
    }
    return { ok: false, failure: classifyLinkError(lookupError) ?? { reason: "unreachable" } };
  }

  return { ok: false, failure: classifyLinkError(error) ?? { reason: "unreachable" } };
}

/**
 * Email somebody a link that signs them in.
 *
 * A `recovery` link, not a magic link, for two reasons `auth-links.ts` sets out:
 * the login page offers this under "No password, or forgotten it?", so it has to
 * let them set one; and it cannot create an account, so a mistyped address still
 * cannot mint the orphan login `signInWithOtp`'s default would have.
 *
 * Nothing here is told to the person at the form — the caller runs the answer
 * through `magicLinkOutcome`, which hides anything true of this address alone.
 */
export async function sendSignInLink(input: {
  email: string;
  origin: string;
  tenantName?: string;
}): Promise<SendLinkResult> {
  const blocked = preflight(input.origin);
  if (blocked) return { ok: false, failure: blocked };

  const admin = adminOrNull();
  if (!admin) return { ok: false, failure: { reason: "no-service-key" } };

  const { data, error } = await admin.auth.admin.generateLink({
    type: GENERATE_TYPE["sign-in"],
    email: input.email,
  });
  if (error || !data?.user || !data.properties?.hashed_token) {
    return { ok: false, failure: classifyLinkError(error) ?? { reason: "unknown-address" } };
  }

  const link = authLinkUrl(input.origin, "sign-in", data.properties.hashed_token);
  if (!link) return { ok: false, failure: { reason: "no-origin" } };

  const message = buildAuthEmail({
    kind: "sign-in",
    tenantName: input.tenantName ?? PRODUCT_NAME,
    // Only what the login already carries. The form was given an address and
    // nothing else, so a name here would be one more thing to get wrong.
    recipientName: nameOf(data.user.user_metadata),
    link,
  });
  const sent = await sendEmail({ to: input.email, ...message });
  if (!sent.ok) return { ok: false, failure: { reason: "send-refused", detail: sent.error } };

  return { ok: true, userId: data.user.id, emailed: true };
}

/** What a login is called, in either of the two keys `tenant_members()` reads (0030). */
function nameOf(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  for (const key of ["full_name", "name"] as const) {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
