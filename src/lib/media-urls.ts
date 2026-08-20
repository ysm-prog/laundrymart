/**
 * Server-side signing for stored run media (spec §7.10).
 *
 * The bucket is private, so nothing renders straight from a stored path. Every
 * page mints its own short-lived signed URLs, which keeps a proof-of-delivery
 * photo from turning into a link that outlives the session it was viewed in —
 * copied into an email, pasted into a ticket, still live months later.
 *
 * Server-only: this reaches for the request's cookies. Never import it from a
 * client component.
 */

import { createClient } from "@/lib/supabase/server";
import { MEDIA_BUCKET, MEDIA_URL_TTL_SECONDS, isTenantPath } from "@/lib/media";

export type SignedMedia = { path: string; url: string };

/**
 * Sign the paths that belong to this tenant. Anything else is dropped rather
 * than signed — a stray key in the column is a bug, not something to serve.
 *
 * `ttlSeconds` defaults to the on-screen lifetime. The one caller that overrides
 * it is the delivery-confirmation email, which needs a link that survives the
 * trip to an inbox — see `MEDIA_EMAIL_TTL_SECONDS`.
 */
export async function signMedia(
  paths: ReadonlyArray<string | null | undefined>,
  tenantId: string,
  ttlSeconds: number = MEDIA_URL_TTL_SECONDS,
): Promise<SignedMedia[]> {
  const wanted = paths.filter(
    (path): path is string => typeof path === "string" && isTenantPath(path, tenantId),
  );
  if (wanted.length === 0) return [];

  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrls(wanted, ttlSeconds);

  if (error || !data) return [];

  return data.flatMap((entry, index) => {
    const path = wanted[index];
    return entry.signedUrl && path ? [{ path, url: entry.signedUrl }] : [];
  });
}
