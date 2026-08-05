"use client";

import { useCallback, useEffect, useState, useSyncExternalStore, useTransition } from "react";
import {
  enqueue, flush, newClientRef, pending, type QueuedLine, type QueuedRecord,
} from "@/lib/offline/queue";
import { PhotoPicker, SignaturePad } from "./media-capture";
import { cx } from "./ui";

export type CaptureItem = { id: string; name: string; sku: string };

function subscribeToConnectivity(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Field capture for pickups and deliveries.
 *
 * Save writes to the local outbox first and syncs second, so the driver gets the
 * same confirmation whether or not there is signal. The queue drains on save, on
 * `online`, and when the service worker pings after a background sync.
 */
export function OfflineCapture({
  jobId, kind, items, onSynced,
}: {
  jobId: string;
  kind: "pickup" | "delivery";
  items: CaptureItem[];
  onSynced?: () => void;
}) {
  const [queued, setQueued] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [signature, setSignature] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Connectivity lives in the browser, not in React — subscribe to it rather
  // than copying it into state on mount.
  const online = useSyncExternalStore(
    subscribeToConnectivity,
    () => navigator.onLine,
    () => true, // Server render: assume online so the UI is not alarming.
  );

  const refresh = useCallback(async () => {
    const records = await pending();
    setQueued(records.length);
  }, []);

  const drain = useCallback(async () => {
    const result = await flush();
    setQueued(result.remaining);
    if (result.synced > 0) {
      setStatus(`${result.synced} record(s) synced.`);
      onSynced?.();
    } else if (result.offline && result.remaining > 0) {
      setStatus(`Offline — ${result.remaining} record(s) waiting to sync.`);
    }
  }, [onSynced]);

  // Drain on mount, whenever signal returns, and when the service worker's
  // background sync pings us. None of these set state synchronously.
  useEffect(() => {
    // `drain` already reports what is left in the queue, so a separate refresh
    // here would only duplicate the read.
    //
    // set-state-in-effect guards against cascading synchronous renders; every
    // setState inside `drain` happens after IndexedDB and network I/O, so it can
    // never run during this commit. Attempting a sync on mount is the point of
    // the component — a driver who opens the app in signal must not have to
    // tap anything for yesterday's queue to go up.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void drain();

    const onOnline = () => { void drain(); };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "flush-outbox") void drain();
    };

    window.addEventListener("online", onOnline);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("online", onOnline);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [drain]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    const lines: QueuedLine[] = [];
    for (const item of items) {
      const quantity = Number(data.get(`qty_${item.id}`) ?? 0) || 0;
      const damaged = Number(data.get(`damaged_${item.id}`) ?? 0) || 0;
      const missing = Number(data.get(`missing_${item.id}`) ?? 0) || 0;
      if (quantity <= 0 && damaged <= 0 && missing <= 0) continue;
      lines.push({
        itemId: item.id,
        quantity,
        ...(kind === "pickup" ? { damagedQuantity: damaged, missingQuantity: missing } : {}),
      });
    }

    if (lines.length === 0) {
      setStatus("Enter at least one quantity before saving.");
      return;
    }

    const shared = {
      clientRef: newClientRef(),
      jobId,
      capturedAt: new Date().toISOString(),
      signedBy: (data.get("signed_by") as string) || null,
      notes: (data.get("notes") as string) || null,
      lines,
      photos,
      signature,
    };

    const record: QueuedRecord = kind === "pickup"
      ? { kind, ...shared, bagCount: Number(data.get("bag_count") ?? 0) || 0,
          totalWeightKg: Number(data.get("total_weight_kg") ?? 0) || null }
      : { kind, ...shared };

    await enqueue(record);
    form.reset();
    // The media lives in React state, so form.reset() cannot clear it — and
    // leaving it would attach this stop's proof to the next one.
    setPhotos([]);
    setSignature(null);
    setStatus("Saved on this device.");
    await refresh();
    startTransition(() => { void drain(); });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={cx(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
          online ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
        )}>
          <span aria-hidden>●</span> {online ? "Online" : "Offline"}
        </span>
        {queued > 0 ? (
          <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
            {queued} waiting to sync
          </span>
        ) : null}
        {status ? <span className="text-muted-foreground">{status}</span> : null}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted text-left">
            <tr>
              <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Item</th>
              <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {kind === "pickup" ? "Collected" : "Delivered"}
              </th>
              {kind === "pickup" ? (
                <>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Damaged</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Missing</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t">
                <td className="px-3 py-2">
                  <label htmlFor={`${kind}_qty_${item.id}`}>{item.name}</label>
                  <span className="ml-2 text-xs text-muted-foreground">{item.sku}</span>
                </td>
                <td className="px-2 py-1 text-right">
                  <input id={`${kind}_qty_${item.id}`} name={`qty_${item.id}`} type="number" min={0}
                         inputMode="numeric" placeholder="0"
                         className="w-20 rounded-md border bg-surface px-2 py-1 text-right text-sm" />
                </td>
                {kind === "pickup" ? (
                  <>
                    <td className="px-2 py-1 text-right">
                      <input name={`damaged_${item.id}`} type="number" min={0} inputMode="numeric" placeholder="0"
                             aria-label={`${item.name} damaged`}
                             className="w-20 rounded-md border bg-surface px-2 py-1 text-right text-sm" />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <input name={`missing_${item.id}`} type="number" min={0} inputMode="numeric" placeholder="0"
                             aria-label={`${item.name} missing`}
                             className="w-20 rounded-md border bg-surface px-2 py-1 text-right text-sm" />
                    </td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kind === "pickup" ? (
          <>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Bags</span>
              <input name="bag_count" type="number" min={0} inputMode="numeric" defaultValue={0}
                     className="w-full rounded-md border bg-surface px-3 py-2 text-sm" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Weight (kg)</span>
              <input name="total_weight_kg" type="number" min={0} step="0.001" inputMode="decimal"
                     className="w-full rounded-md border bg-surface px-3 py-2 text-sm" />
            </label>
          </>
        ) : null}
        <label className="text-sm">
          <span className="mb-1 block font-medium">Signed by</span>
          <input name="signed_by" className="w-full rounded-md border bg-surface px-3 py-2 text-sm" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Notes</span>
          <input name="notes" className="w-full rounded-md border bg-surface px-3 py-2 text-sm" />
        </label>
      </div>

      <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
        <PhotoPicker
          photos={photos}
          onChange={setPhotos}
          label={kind === "pickup" ? "Collection photos" : "Delivery photos"}
        />
        <SignaturePad value={signature} onChange={setSignature} label="Customer signature" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={isPending}
                className="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground
                           transition hover:opacity-90 disabled:opacity-60">
          Save {kind}
        </button>
        {queued > 0 ? (
          <button type="button" onClick={() => void drain()}
                  className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-surface-muted">
            Sync now
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Registers the service worker once, on the client. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration is best-effort; the app works online without it.
    });
  }, []);
  return null;
}
