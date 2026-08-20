/**
 * The delivery-confirmation email (roadmap C3).
 *
 * Pure: data in, subject and body out. No provider, no network, no signing —
 * the caller has already minted the signed URLs. Same shape as
 * `invoice-email.ts`, and for the same reason: the part most likely to be wrong
 * is the wording and the escaping, and that part should be testable without an
 * API key.
 *
 * This one goes to the *customer*, not to staff, so the voice is theirs: what
 * arrived, when, who signed for it, and the proof attached. No internal
 * vocabulary — no job numbers, no run codes, no dollar figures. (§10b already
 * establishes that drivers and floor staff see no money; a customer reading a
 * delivery docket has even less business seeing our billing.)
 */

import { escapeHtml } from "@/lib/email/invoice-email";

export type DeliveredLine = { name: string; quantity: number };

export type DeliveryEmailData = {
  tenantName: string;
  customerName: string;
  /** Site or address the drop was made at, when we know it. */
  locationName: string | null;
  /** ISO timestamp of the drop. */
  completedAt: string;
  signedBy: string | null;
  lines: DeliveredLine[];
  /** Already-signed, already-tenant-checked URLs. May be empty. */
  photoUrls: string[];
  signatureUrl: string | null;
};

export type DeliveryEmail = { subject: string; html: string; text: string };

function auDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function buildDeliveryEmail(data: DeliveryEmailData): DeliveryEmail {
  const when = auDateTime(data.completedAt);
  const where = data.locationName ? ` to ${data.locationName}` : "";
  const total = data.lines.reduce((sum, line) => sum + line.quantity, 0);

  const subject = `${data.tenantName} — linen delivered ${when}`;

  const text = [
    `Hello ${data.customerName},`,
    "",
    `We delivered${where} on ${when}.`,
    data.signedBy ? `Signed for by ${data.signedBy}.` : "",
    "",
    "What we dropped off:",
    ...data.lines.map((line) => `  ${line.quantity} × ${line.name}`),
    `  ${total} items in total.`,
    "",
    data.signatureUrl ? `Signature: ${data.signatureUrl}` : "",
    ...data.photoUrls.map((url, index) => `Photo ${index + 1}: ${url}`),
    data.photoUrls.length > 0 || data.signatureUrl
      ? "(Those links work for the next 7 days.)"
      : "",
    "",
    "If anything is missing or not right, reply to this email and we will sort it out.",
    "",
    data.tenantName,
  ].filter((line) => line !== "").join("\n");

  const lineRows = data.lines.map((line) => `
      <tr>
        <td style="padding:4px 0;color:#6b7280;">${escapeHtml(line.name)}</td>
        <td style="padding:4px 0;text-align:right;font-weight:600;">${line.quantity}</td>
      </tr>`).join("");

  const proof = [
    data.signatureUrl
      ? `<div style="margin:0 0 10px;">
           <p style="margin:0 0 4px;font-size:12px;color:#6b7280;">Signature</p>
           <img src="${escapeHtml(data.signatureUrl)}" alt="Signature"
                style="max-width:100%;border:1px solid #e5e7eb;" />
         </div>`
      : "",
    ...data.photoUrls.map((url) => `
         <img src="${escapeHtml(url)}" alt="Photo of the delivery"
              style="max-width:100%;margin:0 0 8px;border:1px solid #e5e7eb;" />`),
  ].filter((block) => block !== "").join("");

  const html = `<!doctype html>
<html lang="en-AU">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px;">
      <h1 style="margin:0 0 4px;font-size:18px;">${escapeHtml(data.tenantName)}</h1>
      <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">Delivery confirmation</p>

      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
        Hello ${escapeHtml(data.customerName)}, we delivered${escapeHtml(where)} on ${escapeHtml(when)}.${
          data.signedBy ? ` Signed for by ${escapeHtml(data.signedBy)}.` : ""
        }
      </p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
        ${lineRows}
        <tr>
          <td style="padding:8px 0 0;border-top:1px solid #e5e7eb;">Total</td>
          <td style="padding:8px 0 0;border-top:1px solid #e5e7eb;text-align:right;font-weight:600;">${total}</td>
        </tr>
      </table>

      ${proof
        ? `<div style="margin:16px 0;">
             ${proof}
             <p style="margin:4px 0 0;font-size:12px;color:#9ca3af;">
               These links work for the next 7 days.
             </p>
           </div>`
        : ""}

      <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
        If anything is missing or not right, reply to this email and we will sort it out.
      </p>

      <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">${escapeHtml(data.tenantName)}</p>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}
