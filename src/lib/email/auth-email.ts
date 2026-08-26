/**
 * The two emails that let somebody sign in: an invitation, and a sign-in link.
 *
 * Pure, like the other three templates, and for the same reason — the wording
 * and the escaping are the parts that can be wrong in a way a green build hides.
 * The send lives in `lib/auth/send-link.ts`.
 *
 * Both are written for somebody who has been shown this once, which is the
 * whole brief of the 2026-08-24 work: no jargon, one obvious button, the link
 * repeated as plain text underneath (a mail client that strips the button must
 * not strip the only way in), and a sentence saying what to do if it has gone
 * stale. Neither ever names the laundry's internal words — "tenant", "board",
 * "membership" — because the person reading it has not seen the app yet.
 */

import {
  EMAIL_PALETTE, button, emailShell, escapeHtml, mutedParagraph, paragraph,
} from "@/lib/email/layout";
import type { AuthLinkKind } from "@/lib/auth/auth-links";

export type AuthEmailData = {
  kind: AuthLinkKind;
  /** The business they are being let into. Shown, so a two-laundry deployment reads right. */
  tenantName: string;
  /** Their name, when we have one. An invitation always does; a sign-in link may not. */
  recipientName?: string;
  /** The full URL built by `authLinkUrl()`. */
  link: string;
  /** Whoever pressed the button, for an invitation. Omitted on a sign-in link. */
  invitedBy?: string;
};

export type AuthEmail = { subject: string; html: string; text: string };

/**
 * How long the link is good for, in the words on the tin.
 *
 * These are GoTrue's defaults, and they are stated rather than computed because
 * nothing in this codebase can read the project's setting — an approximate
 * "about a day" that is honest beats a precise expiry that is a guess.
 */
const LIFETIME: Record<AuthLinkKind, string> = {
  invite: "about a day",
  "sign-in": "about an hour",
};

function greeting(name: string | undefined): string {
  return name ? `Hello ${name},` : "Hello,";
}

/** The one sentence that says what this email is. */
function lead(data: AuthEmailData): string {
  if (data.kind === "invite") {
    const by = data.invitedBy ? `${data.invitedBy} has added you` : "You have been added";
    return `${by} to ${data.tenantName}. The button below signs you in and lets you `
      + "choose a password — after that you sign in with your email address and that password.";
  }
  return `Here is your sign-in link for ${data.tenantName}. It signs you straight in, `
    + "and gives you the chance to set a new password while you are there.";
}

export function buildAuthEmail(data: AuthEmailData): AuthEmail {
  const invite = data.kind === "invite";
  const subject = invite
    ? `${data.tenantName} — you have been added, here is how to sign in`
    : `${data.tenantName} — your sign-in link`;
  const action = invite ? "Sign in and choose a password" : "Sign me in";
  const lifetime = LIFETIME[data.kind];

  // The stale-link sentence differs because the remedy differs: an invitation
  // has to be re-sent by whoever sent it, a sign-in link the person can ask for
  // again themselves.
  const stale = invite
    ? "Links can only be used once and this one lasts " + lifetime
      + ". If it has stopped working, ask whoever invited you to send another."
    : "Links can only be used once and this one lasts " + lifetime
      + ". If it has stopped working, just ask for another from the sign-in page.";

  const text = [
    greeting(data.recipientName),
    "",
    lead(data),
    "",
    data.link,
    "",
    stale,
    "",
    "If you were not expecting this email, you can ignore it — nothing happens until",
    "somebody opens the link.",
    "",
    data.tenantName,
  ].join("\n");

  const safeLink = escapeHtml(data.link);

  // **Staff-facing, so no Core IT credit.** An invitation telling a counter hand
  // to choose a password is not marketing surface — YSM Hub draws the same line
  // at the top of its own `lib/_credit.js`, and this is the audience it excludes.
  const html = emailShell({
    audience: "staff",
    brandName: data.tenantName,
    eyebrow: data.kind === "invite" ? "You have been invited" : "Sign-in link",
    preview: data.kind === "invite"
      ? `Set a password and get into ${data.tenantName}.`
      : `Your link into ${data.tenantName}, good for ${LIFETIME[data.kind]}.`,
    body: [
      paragraph(greeting(data.recipientName)),
      paragraph(lead(data)),
      button(data.link, action),
      // The link repeated as text, because a client that strips the button must
      // not strip the only way in. `word-break` so a long token cannot stretch
      // the card past the viewport on a phone.
      `<p style="margin:0 0 6px;font-size:13px;color:${EMAIL_PALETTE.inkMuted};">`
      + `If the button does not work, copy this address into your browser:</p>`,
      `<p style="margin:0 0 20px;font-size:13px;word-break:break-all;">`
      + `<a href="${safeLink}" style="color:${EMAIL_PALETTE.accent};">${safeLink}</a></p>`,
      mutedParagraph(stale),
      mutedParagraph(
        "If you were not expecting this email, you can ignore it — nothing happens "
        + "until somebody opens the link.",
      ),
    ].join("\n"),
    footNote: data.tenantName,
  });

  return { subject, html, text };
}
