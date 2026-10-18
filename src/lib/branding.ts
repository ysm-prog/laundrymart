/**
 * The laundry's logo on its invoices (brief 1.10) — the shared constants and the
 * one rule about what may be uploaded. No I/O, so the settings action, the PDF
 * loader and the tests read one answer.
 *
 * The logo is **the tenant's data**: uploaded on Settings › Invoicing into the
 * private `tenant-branding` bucket (0054) under the tenant's own prefix, read back
 * at render time, never committed to this repository. The ATS logo used to test
 * it was taken out of the MYOB invoice the brief attached and lives nowhere here.
 */

import { imageFormat } from "@/lib/pdf/line-display";

export const BRANDING_BUCKET = "tenant-branding";

/**
 * 900 KB. A server action's request body is capped at 1 MB by Next.js, and the
 * multipart envelope needs some of that; a logo a few hundred pixels across is a
 * fraction of it, and the PDF carries the file as-is on every invoice.
 */
export const LOGO_MAX_BYTES = 900 * 1024;

/** `<tenant_id>/invoice-logo-<stamp>.png` — the tenant segment is what 0054's policies read. */
export function logoObjectPath(tenantId: string, format: "png" | "jpg", stamp: number): string {
  return `${tenantId}/invoice-logo-${stamp}.${format}`;
}

/** Whether a stored path belongs to this tenant at all — a path is posted back, so it is checked. */
export function isTenantLogoPath(tenantId: string, path: string | null | undefined): path is string {
  return Boolean(path && path.startsWith(`${tenantId}/`) && !path.includes(".."));
}

/** Why an upload is refused, or null. The format is read from the file, never from its name. */
export function logoRefusal(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return "Choose a PNG or JPEG file to upload.";
  if (bytes.length > LOGO_MAX_BYTES) {
    return "That logo is larger than 900 KB. Save a smaller copy — a few hundred pixels across is plenty for an invoice — and try again.";
  }
  if (!imageFormat(bytes)) return "A logo has to be a PNG or a JPEG — those are the two formats a PDF can print.";
  return null;
}
