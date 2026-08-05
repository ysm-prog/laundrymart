/**
 * Run media: proof-of-service photos and signatures (spec §7.8, §7.10).
 *
 * Shared by the capture UI, the upload endpoint and the sync endpoint, so all
 * three agree on where a file lives and what is allowed through. No database and
 * no browser APIs — safe to import from either side of the wire.
 *
 * The path is the security boundary as much as the policy is:
 *
 *     <tenant_id>/<scope>/<owner_ref>/<kind>-<index>.<ext>
 *
 * The tenant segment is always written from the session server-side, never from
 * anything the client sent, and 0007_media's storage policies read it back
 * through is_member(). The rest of the key is deterministic, so replaying an
 * offline queue overwrites the same object instead of littering duplicates.
 */

export const MEDIA_BUCKET = "run-media";

// "exception" needs no storage change: the policies check only the tenant
// segment of the key, so a new scope segment is just a new folder.
export const MEDIA_SCOPES = ["pickup", "delivery", "inspection", "exception"] as const;
export type MediaScope = (typeof MEDIA_SCOPES)[number];

export const MEDIA_KINDS = ["photo", "signature"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Matches the bucket's own allow-list in 0007_media.sql. */
export const MEDIA_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Also the bucket's file_size_limit — checked here so a bad file fails fast. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/** Per pickup or delivery. Enough for a stop, few enough to sync on 3G. */
export const MAX_PHOTOS = 4;

/** Photos are downscaled to this before upload; a phone original is ~20× bigger. */
export const PHOTO_MAX_EDGE_PX = 1280;
export const PHOTO_QUALITY = 0.72;

/** Signed URLs are minted per request and expire well inside a session. */
export const MEDIA_URL_TTL_SECONDS = 300;

/** Owner refs are client-generated, so they are constrained to path-safe text. */
export const OWNER_REF_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

export function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/png": return "png";
    case "image/webp": return "webp";
    default: return "jpg";
  }
}

export function mediaPath(input: {
  tenantId: string;
  scope: MediaScope;
  ownerRef: string;
  kind: MediaKind;
  index: number;
  contentType: string;
}): string {
  const file = `${input.kind}-${input.index}.${extensionFor(input.contentType)}`;
  return `${input.tenantId}/${input.scope}/${input.ownerRef}/${file}`;
}

/** Guards display code against a path that escaped the bucket's own layout. */
export function isTenantPath(path: string, tenantId: string): boolean {
  return path.startsWith(`${tenantId}/`) && !path.includes("..");
}
