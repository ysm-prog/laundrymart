/**
 * The two rules a text message depends on, pure so they can be tested without a
 * provider: what counts as a number a text can reach, and what the text says.
 */

/**
 * An Australian mobile as `+614XXXXXXXX`, or null for anything else.
 *
 * `customers.phone` holds whatever the office typed, and most of them are
 * landlines. A landline must come back null rather than be sent to: the provider
 * would accept it, charge for it, and nobody would receive anything.
 */
export function normaliseMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[\s().-]/g, "");
  const national = digits.startsWith("+61") ? `0${digits.slice(3).replace(/^0/, "")}`
    : digits.startsWith("0061") ? `0${digits.slice(4).replace(/^0/, "")}`
    : digits.startsWith("61") && digits.length === 11 ? `0${digits.slice(2)}`
    : digits;
  return /^04\d{8}$/.test(national) ? `+61${national.slice(1)}` : null;
}

/** `+61412345678` as a person reads it: `0412 345 678`. */
export function displayMobile(mobile: string): string {
  const national = mobile.startsWith("+61") ? `0${mobile.slice(3)}` : mobile;
  return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
}

/**
 * The invoice text. One line, and short enough to stay one message part with the
 * link on the end: a second part costs a second credit on every invoice.
 */
export function buildInvoiceSms(input: {
  business: string; invoiceNumber: string; amount: string; due: string | null; link: string;
}): string {
  const due = input.due ? ` due ${input.due}` : "";
  return `${input.business} invoice ${input.invoiceNumber} ${input.amount}${due}: ${input.link}`;
}

export type SmsResult = { ok: true; id: string | null } | { ok: false; error: string };

export type ClickSendResponse = {
  response_code?: string;
  response_msg?: string;
  data?: { messages?: Array<{ status?: string; message_id?: string }> };
};

/**
 * Read ClickSend's answer. This is the part that can lie: the top level says SUCCESS when the request was received, and a message
 * inside it can still have been refused (`INSUFFICIENT_CREDIT`, `INVALID_RECIPIENT`).
 * SUCCESS on a message means queued, not delivered.
 */
export function readClickSendResponse(status: number, body: ClickSendResponse | null): SmsResult {
  const code = body?.response_code;
  if (status === 401 || code === "INVALID_CREDENTIALS") {
    return { ok: false, error: "ClickSend refused the username or API key." };
  }
  if (status < 200 || status >= 300 || (code && code !== "SUCCESS")) {
    return { ok: false, error: `ClickSend refused the message: ${code ?? status}.` };
  }
  const message = body?.data?.messages?.[0];
  if (message?.status && message.status !== "SUCCESS") {
    return message.status === "INSUFFICIENT_CREDIT"
      ? { ok: false, error: "The ClickSend account is out of credit." }
      : { ok: false, error: `ClickSend refused the message: ${message.status}.` };
  }
  return { ok: true, id: message?.message_id ?? null };
}
