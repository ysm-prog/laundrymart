/**
 * What to tell somebody who asked for a sign-in link.
 *
 * Pure, and outside `login/actions.ts` on purpose: that file is `"use server"`,
 * so it can export nothing but server actions and a rule written inside it is
 * unreachable from a unit test — the trap `plan.ts` and `order-items.ts` both
 * record, and both of those shipped broken behind a green `verify`.
 *
 * The rule itself is one distinction, and it did not change when the sender did.
 * **A failure that is true of every address says nothing about any address**, so
 * hiding it buys no privacy and costs the operator the only clue they had. A
 * failure that is true of *this* address is exactly what an attacker wants, so
 * it stays behind the same answer as success.
 *
 * What *did* change is which failures exist. Links are now minted by
 * `generateLink()` and delivered by Resend (`lib/auth/send-link.ts`), so the
 * deployment faults are this app's mail provider rather than Supabase's — and
 * the messages name the thing an administrator would actually go and fix.
 */

import type { LinkFailure } from "@/lib/auth/auth-links";

export type MagicLinkOutcome = { ok: string } | { error: string };

/**
 * Said whether or not the address exists, so the form cannot be used to find
 * out which addresses have logins.
 */
export const MAGIC_LINK_SENT = "If that address has an account, a sign-in link is on its way.";

/**
 * Faults of the deployment rather than of the address. Every one of these comes
 * back for *any* address typed into the box, so naming them enumerates nothing
 * — and each names something only an administrator can put right.
 *
 * `unknown-address` is deliberately absent: it is what an address with no login
 * comes back as, which is precisely the fact this form must not confirm.
 */
const DEPLOYMENT_FAULTS: Record<Exclude<LinkFailure["reason"], "unknown-address">, string> = {
  "not-configured":
    "Sign-in emails are not set up on this deployment. Ask your administrator to add the "
    + "email settings (RESEND_API_KEY and INVOICE_FROM_EMAIL), and sign in with your password meanwhile.",
  "no-service-key":
    "This deployment cannot send sign-in emails yet — it has no service key configured. "
    + "Ask your administrator, and sign in with your password meanwhile.",
  "no-origin":
    "This deployment could not work out its own web address, so it cannot build a sign-in link. "
    + "Ask your administrator, and sign in with your password meanwhile.",
  "rate-limited":
    "Too many sign-in emails have been requested recently. Wait a few minutes and try again, "
    + "or sign in with your password.",
  unreachable:
    "The sign-in service could not be reached just now. Try again in a moment, "
    + "or sign in with your password.",
  "send-refused":
    "The email could not be sent — this deployment's mail provider refused it. "
    + "Ask your administrator to check the email settings, and sign in with your password meanwhile.",
};

/**
 * A `null` failure is a send the mail provider accepted. Note what that does
 * *not* promise: it still has to be delivered.
 */
export function magicLinkOutcome(failure: LinkFailure | null): MagicLinkOutcome {
  if (!failure) return { ok: MAGIC_LINK_SENT };
  if (failure.reason === "unknown-address") return { ok: MAGIC_LINK_SENT };
  return { error: DEPLOYMENT_FAULTS[failure.reason] };
}

/**
 * The same failure, said to an administrator who typed the address themselves.
 *
 * Enumeration is not a concern here — they chose the address, and they are the
 * person who has to act on the answer — so this one is allowed to say "there is
 * no login at that address" and to pass the provider's own words through.
 */
export function inviteFailureMessage(failure: LinkFailure): string {
  switch (failure.reason) {
    case "not-configured":
      return "Invitations cannot be sent until this deployment has email set up "
        + "(RESEND_API_KEY and INVOICE_FROM_EMAIL).";
    case "no-service-key":
      return "This deployment has no service key set up, so invitations cannot be sent yet.";
    case "no-origin":
      return "This deployment could not work out its own web address, so the invitation "
        + "link could not be built.";
    case "rate-limited":
      return "Too many invitations have been sent recently. Wait a few minutes and try again.";
    case "unreachable":
      return "The sign-in service could not be reached just now. Try again in a moment.";
    case "send-refused":
      return `The invitation could not be emailed, so nothing was changed. ${failure.detail}`;
    case "unknown-address":
      return "That invitation could not be sent. Check the address and try again.";
  }
}
