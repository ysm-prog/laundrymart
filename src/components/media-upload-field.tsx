"use client";

/**
 * Media field for ordinary online forms — the office pickup/delivery screens and
 * the vehicle inspection (spec §7.8, §7.10).
 *
 * Each file uploads as it is captured and the form carries only the returned
 * storage keys, so a server action never has to accept a multi-megabyte body.
 * This deliberately does not queue. The offline path is the driver's stop
 * capture, which goes through the outbox; these forms are used from a desk or a
 * depot, where a failed upload should say so rather than disappear into a queue
 * nobody is watching.
 */

import { useState } from "react";
import { MAX_PHOTOS, type MediaScope } from "@/lib/media";
import { newClientRef } from "@/lib/offline/queue";
import { PhotoPicker, SignaturePad } from "./media-capture";

const FAILED = "That upload did not go through. Check your connection and try again.";

export function MediaUploadField({
  scope, photosName, signatureName, photoLabel = "Photos", signatureLabel = "Signature",
}: {
  scope: MediaScope;
  photosName: string;
  signatureName?: string;
  photoLabel?: string;
  signatureLabel?: string;
}) {
  // One ref per mounted form groups this form's uploads under a single folder.
  const [ownerRef] = useState(newClientRef);
  const [photos, setPhotos] = useState<string[]>([]);
  const [photoPaths, setPhotoPaths] = useState<string[]>([]);
  const [signature, setSignature] = useState<string | null>(null);
  const [signaturePath, setSignaturePath] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(dataUrl: string, kind: "photo" | "signature", index: number) {
    const blob = await (await fetch(dataUrl)).blob();
    const form = new FormData();
    form.set("scope", scope);
    form.set("kind", kind);
    form.set("ownerRef", ownerRef);
    form.set("index", String(index));
    form.set("file", blob, kind);

    const response = await fetch("/api/media", { method: "POST", body: form });
    if (!response.ok) throw new Error(FAILED);
    const { path } = (await response.json()) as { path: string };
    return path;
  }

  /**
   * Photos are re-uploaded from scratch whenever the set changes. Removing one
   * shifts every later index, and the object key contains the index — so the
   * only way to keep the stored set honest is to rewrite it.
   */
  async function onPhotosChange(next: string[]) {
    setPhotos(next);
    setError(null);
    setBusy(true);
    try {
      const paths: string[] = [];
      for (const [index, photo] of next.entries()) {
        paths.push(await upload(photo, "photo", index));
      }
      setPhotoPaths(paths);
    } catch {
      setError(FAILED);
      setPhotoPaths([]);
    } finally {
      setBusy(false);
    }
  }

  async function onSignatureChange(next: string | null) {
    setSignature(next);
    setError(null);
    if (!next) { setSignaturePath(""); return; }

    setBusy(true);
    try {
      setSignaturePath(await upload(next, "signature", 0));
    } catch {
      setError(FAILED);
      setSignaturePath("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <input type="hidden" name={photosName} value={JSON.stringify(photoPaths)} />
      {signatureName ? <input type="hidden" name={signatureName} value={signaturePath} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <PhotoPicker photos={photos} onChange={onPhotosChange} label={photoLabel} disabled={busy} />
        {signatureName ? (
          <SignaturePad value={signature} onChange={onSignatureChange}
                        label={signatureLabel} disabled={busy} />
        ) : null}
      </div>

      {busy ? <p className="text-xs text-muted-foreground">Uploading…</p> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {photoPaths.length >= MAX_PHOTOS ? (
        <p className="text-xs text-muted-foreground">Photo limit reached.</p>
      ) : null}
    </div>
  );
}
