/**
 * Text messages via ClickSend.
 *
 * Optional configuration, on the same footing as the mail provider
 * (`lib/email/send.ts`): this never throws on a missing key, it returns a result
 * the caller can turn into a sentence. The screen says texting is not set up, and
 * the rest of the deployment is unaffected.
 *
 * Server-only. Never import from a client component: it carries the API key.
 *
 * **`from` is left out unless `CLICKSEND_FROM` is set.** Since 1 July 2026 an
 * alphanumeric sender in Australia has to be on the ACMA SMS Sender ID Register or
 * it arrives marked Unverified or is blocked, whereas a numeric sender is not
 * affected. So the safe default is whatever number the ClickSend account sends
 * from, and a name is something somebody registers first and then sets.
 */

import { env } from "@/lib/env";
import { readClickSendResponse, type ClickSendResponse, type SmsResult } from "@/lib/domain/sms";

const ENDPOINT = "https://rest.clicksend.com/v3/sms/send";

export type { SmsResult };

function configured(): { username: string; apiKey: string; from: string | null } | null {
  const username = env.CLICKSEND_USERNAME;
  const apiKey = env.CLICKSEND_API_KEY;
  if (!username || !apiKey) return null;
  return { username, apiKey, from: env.CLICKSEND_FROM ?? null };
}

export function smsIsConfigured(): boolean {
  return configured() !== null;
}

export async function sendSms(message: { to: string; body: string }): Promise<SmsResult> {
  const config = configured();
  if (!config) {
    return {
      ok: false,
      error: "Text messages are not set up. Set CLICKSEND_USERNAME and CLICKSEND_API_KEY.",
    };
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${config.username}:${config.apiKey}`).toString("base64")}`,
      },
      body: JSON.stringify({
        messages: [{
          source: "electro-services",
          to: message.to,
          body: message.body,
          ...(config.from ? { from: config.from } : {}),
        }],
      }),
      // A stuck provider must not hold an office screen open.
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null) as ClickSendResponse | null;
    return readClickSendResponse(response.status, body);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The text could not be sent." };
  }
}
