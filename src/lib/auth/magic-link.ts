/**
 * What to tell somebody who asked for a sign-in link.
 *
 * Pure, and outside `login/actions.ts` on purpose: that file is `"use server"`,
 * so it can export nothing but server actions and a rule written inside it is
 * unreachable from a unit test — the trap `plan.ts` and `order-items.ts` both
 * record, and both of those shipped broken behind a green `verify`.
 *
 * The rule itself is one distinction. **A failure that is true of every address
 * says nothing about any address**, so hiding it buys no privacy and costs the
 * operator the only clue they had. A failure that is true of *this* address is
 * exactly what an attacker wants, so it stays behind the same answer as success.
 */

/** The Supabase error shape we actually read. */
export type MagicLinkError = { code?: string; status?: number; message?: string } | null;

export type MagicLinkOutcome = { ok: string } | { error: string };

/**
 * Said whether or not the address exists, so the form cannot be used to find
 * out which addresses have logins.
 */
export const MAGIC_LINK_SENT = "If that address has an account, a sign-in link is on its way.";

/**
 * Failures of the deployment rather than of the address. Every one of these
 * comes back for *any* address typed into the box, so naming them enumerates
 * nothing — and each names something only an administrator can put right.
 *
 * `otp_disabled` is deliberately not here. With `shouldCreateUser: false` it is
 * what an address with no login comes back as, which is precisely the fact this
 * form must not confirm.
 */
const DEPLOYMENT_FAULTS: Record<string, string> = {
  error_sending_email:
    "Sign-in emails are not working on this deployment — the mail sender is not set up or is refusing. " +
    "Ask your administrator to configure SMTP in Supabase, and sign in with your password meanwhile.",
  email_provider_disabled:
    "Email sign-in is switched off for this deployment. Ask your administrator to turn the email provider " +
    "back on in Supabase, and sign in with your password meanwhile.",
  over_email_send_rate_limit:
    "Too many sign-in emails have been requested recently. Wait an hour and try again, or sign in with your password.",
  over_request_rate_limit:
    "Too many attempts from here recently. Wait a few minutes and try again.",
  validation_failed:
    "This deployment cannot send a sign-in link — its redirect address is not one Supabase allows. " +
    "Ask your administrator to add it to the project's redirect URLs.",
};

/**
 * A `null` error is a send that Supabase accepted. Note what that does *not*
 * promise: the mail provider still has to deliver it.
 */
export function magicLinkOutcome(error: MagicLinkError): MagicLinkOutcome {
  if (!error) return { ok: MAGIC_LINK_SENT };

  const named = error.code ? DEPLOYMENT_FAULTS[error.code] : undefined;
  if (named) return { error: named };

  // A 5xx is the deployment falling over, whatever it called itself. Same
  // reasoning as the table above: it happens to every address alike.
  if (typeof error.status === "number" && error.status >= 500) {
    return {
      error:
        "The sign-in service could not be reached just now. Try again in a moment, " +
        "or sign in with your password.",
    };
  }

  // Anything left is about this address — most of all "no such login".
  return { ok: MAGIC_LINK_SENT };
}
