import { signMedia } from "@/lib/media-urls";

/**
 * Renders the photos and signature captured at a stop (spec §7.10).
 *
 * A server component on purpose: the URLs are signed per request and expire, so
 * they must not be baked into anything cached or shipped to the client ahead of
 * time. Renders nothing at all when a record has no media, which keeps every
 * pre-media pickup in the history looking exactly as it did before.
 */
export async function ProofOfService({
  photoPaths, signaturePath, signedBy, tenantId,
}: {
  photoPaths?: string[] | null;
  signaturePath?: string | null;
  signedBy?: string | null;
  tenantId: string;
}) {
  const [photos, signature] = await Promise.all([
    signMedia(photoPaths ?? [], tenantId),
    signMedia([signaturePath], tenantId),
  ]);

  if (photos.length === 0 && signature.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-start gap-4 border-t pt-3">
      {photos.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Photos ({photos.length})
          </p>
          <ul className="flex flex-wrap gap-2">
            {photos.map((photo, index) => (
              <li key={photo.path}>
                <a href={photo.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo.url} alt={`Stop photo ${index + 1}`}
                       className="h-20 w-20 rounded-md border object-cover transition hover:opacity-90" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {signature[0] ? (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Signature{signedBy ? ` · ${signedBy}` : ""}
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={signature[0].url} alt="Customer signature"
               className="h-20 rounded-md border bg-white object-contain px-2" />
        </div>
      ) : null}
    </div>
  );
}
