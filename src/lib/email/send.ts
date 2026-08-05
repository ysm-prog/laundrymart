/**
 * Transactional email via Resend (spec §18 — the open question on delivery).
 *
 * The provider is optional configuration, so this never throws on a missing key:
 * it returns a result the caller can turn into a message a human can act on
 * ("no email provider is configured") instead of a 500 that says nothing.
 *
 * Server-only. Never import from a client component — it carries the API key.
 */

import { Resend } from "resend";
import { env } from "@/lib/env";

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export type Attachment = { filename: string; content: Buffer };

/** Null when the deployment has no mail provider wired up. */
function configured(): { apiKey: string; from: string } | null {
  const apiKey = env.RESEND_API_KEY;
  const address = env.INVOICE_FROM_EMAIL;
  if (!apiKey || !address) return null;

  const name = env.INVOICE_FROM_NAME;
  return { apiKey, from: name ? `${name} <${address}>` : address };
}

export function emailIsConfigured(): boolean {
  return configured() !== null;
}

export async function sendEmail(message: {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Attachment[];
}): Promise<SendResult> {
  const config = configured();
  if (!config) {
    return {
      ok: false,
      error: "No email provider is configured. Set RESEND_API_KEY and INVOICE_FROM_EMAIL.",
    };
  }

  try {
    const { data, error } = await new Resend(config.apiKey).emails.send({
      from: config.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: env.INVOICE_REPLY_TO,
      attachments: message.attachments?.map((file) => ({
        filename: file.filename,
        content: file.content,
      })),
    });

    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "The email provider accepted nothing back." };
    return { ok: true, id: data.id };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "Email send failed." };
  }
}
