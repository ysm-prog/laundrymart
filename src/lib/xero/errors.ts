/**
 * The actionable part of a Xero error body.
 *
 * Xero puts the useful sentence in the body, not the status line: "Invoice #
 * must be unique", "Account code 200 is not a valid code", "Invoice cannot be
 * voided as it has payments applied". Surfacing it is the difference between a
 * message somebody can act on and "400".
 *
 * Shared by all three pushes. It was a private copy in `push.ts` and again in
 * `push-payment.ts`, and the void path would have made three — at which point
 * they drift and the least-used one is the one that stops parsing the shape Xero
 * actually sends.
 */
export function summariseXeroError(detail: string): string {
  if (!detail) return "";
  try {
    const json = JSON.parse(detail) as {
      Message?: string;
      Elements?: { ValidationErrors?: { Message?: string }[] }[];
    };
    const validation = json.Elements?.[0]?.ValidationErrors
      ?.map((e) => e.Message)
      .filter(Boolean);
    if (validation?.length) return validation.join(" ");
    if (json.Message) return json.Message;
  } catch {
    // Not JSON — fall through to the raw text, trimmed.
  }
  return detail.slice(0, 300);
}
