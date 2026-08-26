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

import {
  EMAIL_PALETTE, emailShell, escapeHtml, mutedParagraph, paragraph, summary, withTextCredit,
} from "@/lib/email/layout";

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
      timeZone: "Australia/Adelaide",
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

  // The linen goes through `summary()` so it matches the invoice's money rows,
  // with the total kept as its own emphasised line beneath the rule.
  const items = summary([
    ...data.lines.map((line) => ({ label: line.name, value: String(line.quantity) })),
    { label: "Total items", value: String(total) },
  ]);

  const rule = EMAIL_PALETTE.ruleSoft;
  const proof = [
    data.signatureUrl
      ? `<div style="margin:0 0 10px;">
           <p style="margin:0 0 4px;font-size:12px;color:${EMAIL_PALETTE.inkMuted};">Signature</p>
           <img src="${escapeHtml(data.signatureUrl)}" alt="Signature"
                style="max-width:100%;border:1px solid ${rule};border-radius:8px;" />
         </div>`
      : "",
    ...data.photoUrls.map((url) => `
         <img src="${escapeHtml(url)}" alt="Photo of the delivery"
              style="max-width:100%;margin:0 0 8px;border:1px solid ${rule};border-radius:8px;" />`),
  ].filter((block) => block !== "").join("");

  const html = emailShell({
    audience: "customer",
    brandName: data.tenantName,
    eyebrow: "Delivery confirmation",
    preview: `${total} items delivered on ${when}.`,
    body: [
      paragraph(
        `Hello ${data.customerName}, we delivered${where} on ${when}.`
        + (data.signedBy ? ` Signed for by ${data.signedBy}.` : ""),
      ),
      items,
      proof
        ? `<div style="margin:16px 0;">${proof}`
          + `<p style="margin:4px 0 0;font-size:12px;color:${EMAIL_PALETTE.inkFaint};">`
          + `These links work for the next 7 days.</p></div>`
        : "",
      mutedParagraph(
        "If anything is missing or not right, reply to this email and we will sort it out.",
      ),
    ].join("\n"),
    footNote: data.tenantName,
  });

  return { subject, html, text: withTextCredit("customer", text) };
}
