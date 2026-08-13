/**
 * The invite a teammate receives (roadmap D5 / audit G9).
 *
 * Pure, like the other templates. Two things it deliberately does not do:
 *
 * - **It does not say what the person can do.** The role is a decision the
 *   administrator can change a minute later, and an email that says "you are a
 *   Dispatcher" becomes wrong without anyone touching it. The app shows the
 *   current answer; this only gets them in.
 * - **It does not carry a password**, because there is no password to carry —
 *   the link is the credential and it expires. If it has expired by the time
 *   they read it, the sign-in page will send them another, which is why the
 *   plain address is in here beside the link.
 */

import { escapeHtml } from "@/lib/email/invoice-email";

export type InviteEmailData = {
  tenantName: string;
  /** The person doing the inviting, so the email is from someone, not something. */
  invitedBy: string | null;
  /** One-time sign-in link from the auth provider. */
  actionLink: string;
  /** Where to sign in from if the link has expired. */
  signInUrl: string;
};

export type InviteEmail = { subject: string; html: string; text: string };

export function buildInviteEmail(data: InviteEmailData): InviteEmail {
  const from = data.invitedBy
    ? `${data.invitedBy} has set you up with an account`
    : "You have been set up with an account";

  const subject = `${data.tenantName} — your LaundryMart sign-in`;

  const text = [
    `Hello,`,
    "",
    `${from} for ${data.tenantName} on LaundryMart, which is where the`,
    "collections, deliveries, stock and invoices are kept.",
    "",
    "Use this link to sign in — it works once and expires:",
    data.actionLink,
    "",
    `If it has expired by the time you read this, go to ${data.signInUrl},`,
    "type this email address and choose \"Email me a sign-in link\".",
    "",
    data.tenantName,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en-AU">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px;">
      <h1 style="margin:0 0 4px;font-size:18px;">${escapeHtml(data.tenantName)}</h1>
      <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">Your sign-in</p>

      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
        ${escapeHtml(from)} for ${escapeHtml(data.tenantName)} on LaundryMart, which is
        where the collections, deliveries, stock and invoices are kept.
      </p>

      <p style="margin:0 0 20px;">
        <a href="${escapeHtml(data.actionLink)}"
           style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;font-size:14px;font-weight:600;">
          Sign in
        </a>
      </p>

      <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
        The link works once and expires. If it has already expired, go to
        <a href="${escapeHtml(data.signInUrl)}" style="color:#111827;">${escapeHtml(data.signInUrl)}</a>,
        type this email address and choose &ldquo;Email me a sign-in link&rdquo;.
      </p>

      <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">${escapeHtml(data.tenantName)}</p>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}
