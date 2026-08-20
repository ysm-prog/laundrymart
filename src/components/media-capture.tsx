"use client";

/**
 * Photo and signature capture for the field (spec §7.8, §7.10).
 *
 * Everything here produces a data URL and nothing here talks to the network.
 * That is what lets the same two controls serve the offline driver run — where
 * the result is parked in IndexedDB until there is signal — and the online
 * inspection form, which uploads straight away. Photos are downscaled on the
 * device first: a modern phone camera produces ~5 MB per shot, which is a
 * pointless thing to push through a tail-end 3G connection at the back of a
 * loading dock.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_PHOTOS, PHOTO_MAX_EDGE_PX, PHOTO_QUALITY } from "@/lib/media";
import { cx } from "./ui";

/** Reads a file into a data URL unchanged — the fallback when canvas is unavailable. */
function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Longest-edge downscale to JPEG. Falls back to the original on any failure. */
export async function downscale(file: File): Promise<string> {
  if (typeof createImageBitmap !== "function") return readAsDataUrl(file);

  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > PHOTO_MAX_EDGE_PX ? PHOTO_MAX_EDGE_PX / longest : 1;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const context = canvas.getContext("2d");
    if (!context) return readAsDataUrl(file);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    return canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
  } catch {
    return readAsDataUrl(file);
  }
}

export function PhotoPicker({
  photos, onChange, label = "Photos", disabled,
}: {
  photos: string[];
  onChange: (photos: string[]) => void;
  label?: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const room = MAX_PHOTOS - photos.length;

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).slice(0, room);
    event.target.value = "";
    if (files.length === 0) return;

    setBusy(true);
    try {
      const added = await Promise.all(files.map(downscale));
      onChange([...photos, ...added].slice(0, MAX_PHOTOS));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{photos.length}/{MAX_PHOTOS}</span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || busy || room <= 0}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-surface-muted disabled:opacity-60"
        >
          {busy ? "Processing…" : "Add photo"}
        </button>
        <input
          ref={inputRef} type="file" accept="image/*" capture="environment" multiple
          onChange={onPick} className="sr-only" aria-label={label}
        />
      </div>

      {photos.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {photos.map((photo, index) => (
            <li key={photo.slice(-48) + index} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo} alt={`${label} ${index + 1}`}
                   className="h-20 w-20 rounded-md border object-cover" />
              <button
                type="button"
                onClick={() => onChange(photos.filter((_, i) => i !== index))}
                aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                className="absolute -right-1.5 -top-1.5 h-6 w-6 border bg-surface
 text-xs font-semibold leading-none shadow-sm hover:bg-surface-muted"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Signature capture. Pointer events cover finger, stylus and mouse in one code
 * path; the canvas is backed at device pixel ratio so a signature taken on a
 * phone is not a blurry mess when it lands on a printed invoice.
 */
export function SignaturePad({
  value, onChange, label = "Signature", disabled,
}: {
  value: string | null;
  onChange: (signature: string | null) => void;
  label?: string;
  disabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const drawn = useRef(false);

  const context = useCallback(() => {
    const canvas = canvasRef.current;
    return canvas ? canvas.getContext("2d") : null;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
  }, []);

  // A cleared value from the parent has to wipe the canvas too, or the driver
  // sees a signature the record no longer holds.
  useEffect(() => {
    if (value !== null) return;
    const canvas = canvasRef.current;
    const ctx = context();
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawn.current = false;
  }, [value, context]);

  function pointFor(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const ctx = context();
    if (!ctx) return;
    const { x, y } = pointFor(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
    drawing.current = true;
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    event.preventDefault();
    const ctx = context();
    if (!ctx) return;
    const { x, y } = pointFor(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    drawn.current = true;
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    if (!canvas || !drawn.current) return;
    // PNG keeps the strokes crisp; a signature is line art, not a photograph.
    onChange(canvas.toDataURL("image/png"));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {value ? (
          <span className="bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
            Captured
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Sign in the box</span>
        )}
        <button
          type="button" onClick={() => onChange(null)} disabled={disabled || !value}
          className="rounded-md border px-3 py-1 text-sm font-medium hover:bg-surface-muted disabled:opacity-60"
        >
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        aria-label={label}
        className={cx(
          "h-32 w-full max-w-md rounded-md border bg-white",
          disabled ? "opacity-60" : "cursor-crosshair touch-none",
        )}
      />
    </div>
  );
}
