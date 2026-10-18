"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button, CONTROL, Notice } from "@/components/ui";
import { Overlay } from "@/components/overlay";
import { PhotoPicker, SignaturePad } from "@/components/media-capture";
import { dataUrlToBlob } from "@/lib/offline/queue";
import { DELIVERY_NOTE_MAX, RECEIVED_BY_MAX } from "@/lib/domain/automation";
import { markJobDelivered } from "./actions";

/**
 * "Delivered", on the job's own card (brief 2.4, G8/G23).
 *
 * A round used to have to open the job first and press Mark Delivered there,
 * and nothing about the handover was captured but the time. Now it is the
 * button on the card, and one sheet: a signature, a photo if it helps, who took
 * it, a note, and the counts — prefilled with what was taken in, so the
 * ordinary delivery is **Delivered, then Confirm delivered: two taps**.
 *
 * The files go to `/api/media` (the private `run-media` bucket, tenant-scoped,
 * under this job's own folder) one at a time before the delivery is posted, so
 * the action only ever receives their keys — and checks that each one is this
 * job's (`isDeliveryProofPath`). An upload that fails stops the delivery with a
 * sentence rather than recording it without the evidence the round collected:
 * half a proof of delivery is worse than one more press.
 */

export type DeliverableLine = { id: string; description: string; takenIn: number | null };

export function DeliverButton({
  orderId, orderNumber, customerName, lines, returnTo, size = "md",
}: {
  orderId: string;
  orderNumber: string;
  customerName: string;
  lines: DeliverableLine[];
  returnTo: string;
  size?: "md" | "lg";
}) {
  const [open, setOpen] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [receivedBy, setReceivedBy] = useState("");
  const [note, setNote] = useState("");
  const [short, setShort] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>(
    () => Object.fromEntries(lines.map((line) => [line.id, line.takenIn === null ? "" : String(line.takenIn)])),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const anyShort = short || lines.some((line) =>
    line.takenIn !== null && counts[line.id] !== "" && Number(counts[line.id]) < line.takenIn);

  async function upload(kind: "photo" | "signature", index: number, dataUrl: string): Promise<string> {
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) throw new Error("That picture could not be read. Take it again.");
    const form = new FormData();
    form.set("scope", "delivery");
    form.set("kind", kind);
    form.set("ownerRef", orderId);
    form.set("index", String(index));
    form.set("file", blob, `${kind}-${index}`);
    const response = await fetch("/api/media", { method: "POST", body: form });
    const body = (await response.json().catch(() => ({}))) as { path?: string; error?: string };
    if (!response.ok || !body.path) {
      throw new Error(body.error ?? "The signature or photo could not be saved. Check the signal and try again.");
    }
    return body.path;
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      try {
        const signaturePath = signature ? await upload("signature", 0, signature) : null;
        const photoPaths: string[] = [];
        for (const [index, photo] of photos.entries()) photoPaths.push(await upload("photo", index, photo));

        const form = new FormData();
        form.set("order_id", orderId);
        form.set("return_to", returnTo);
        if (receivedBy.trim()) form.set("received_by", receivedBy.trim());
        if (note.trim()) form.set("note", note.trim());
        if (signaturePath) form.set("signature_path", signaturePath);
        if (photoPaths.length > 0) form.set("photo_paths", JSON.stringify(photoPaths));
        if (short) form.set("short", "on");
        for (const line of lines) form.set(`delivered_${line.id}`, counts[line.id] ?? "");
        await markJobDelivered(form);
      } catch (cause) {
        // A redirect is how the action reports success; let Next handle it.
        if (cause && typeof cause === "object" && "digest" in cause
            && String((cause as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) {
          throw cause;
        }
        setError(cause instanceof Error ? cause.message : "That could not be recorded. Try again.");
      }
    });
  }

  return (
    <>
      <Button type="button" size={size} onClick={() => setOpen(true)}>
        <Check aria-hidden /> Delivered
      </Button>
      <Overlay
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        title={`Deliver ${orderNumber}`}
        description={customerName}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>Not yet</Button>
            <Button type="button" onClick={confirm} disabled={pending}>
              {pending ? "Recording…" : anyShort ? "Confirm short delivery" : "Confirm delivered"}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          {error ? <Notice tone="danger">{error}</Notice> : null}

          <SignaturePad value={signature} onChange={setSignature} label="Signature" disabled={pending} />

          <div>
            <label htmlFor={`received-by-${orderId}`} className="mb-1 block text-sm font-medium">
              Received by <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input id={`received-by-${orderId}`} value={receivedBy} maxLength={RECEIVED_BY_MAX}
                   onChange={(event) => setReceivedBy(event.target.value)} placeholder="Name at the door"
                   className={CONTROL} disabled={pending} autoComplete="off" />
          </div>

          <PhotoPicker photos={photos} onChange={setPhotos} label="Photo (optional)" disabled={pending} />

          {lines.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">What you handed over</legend>
              {lines.map((line) => (
                <div key={line.id} className="flex items-center justify-between gap-3">
                  <label htmlFor={`delivered-${line.id}`} className="min-w-0 flex-1 text-sm">
                    {line.description}
                    {line.takenIn !== null ? (
                      <span className="text-muted-foreground"> · {line.takenIn} taken in</span>
                    ) : null}
                  </label>
                  <input
                    id={`delivered-${line.id}`} inputMode="numeric" pattern="[0-9]*"
                    value={counts[line.id] ?? ""} disabled={pending}
                    onChange={(event) => setCounts((current) => ({ ...current, [line.id]: event.target.value }))}
                    className={`${CONTROL} w-24 text-right tabular-nums`}
                  />
                </div>
              ))}
            </fieldset>
          ) : null}

          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input type="checkbox" checked={short} onChange={(event) => setShort(event.target.checked)}
                   disabled={pending} className="size-[1.15rem] shrink-0 rounded border-strong accent-primary" />
            Short delivery — not everything came back
          </label>

          <div>
            <label htmlFor={`delivery-note-${orderId}`} className="mb-1 block text-sm font-medium">
              Notes <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <textarea id={`delivery-note-${orderId}`} rows={2} value={note} maxLength={DELIVERY_NOTE_MAX}
                      onChange={(event) => setNote(event.target.value)} placeholder="Left with reception"
                      disabled={pending} className={`${CONTROL} min-h-11 py-2`} />
          </div>
        </div>
      </Overlay>
    </>
  );
}
