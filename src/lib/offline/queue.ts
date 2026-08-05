"use client";

/**
 * Offline capture queue for the driver app.
 *
 * Records are written to IndexedDB the moment the driver hits save — before any
 * network attempt — so a dead zone can never lose a stop. A flush is attempted
 * immediately, then again whenever the browser reports it is back online.
 *
 * Idempotency is the `clientRef`: it is generated here, stored with the record,
 * and unique-constrained server-side, so replaying a queue is always safe.
 *
 * Photos and signatures ride along as data URLs and are uploaded one file at a
 * time before the batch goes out (§7.10). Sending them inside the batch would
 * make a queue of stops one multi-megabyte request that fails as a unit; this
 * way a stop that got its media through never has to send it twice.
 */

const DB_NAME = "laundrymart-offline";
const STORE = "outbox";
const DB_VERSION = 1;

export type QueuedLine = {
  itemId: string;
  quantity: number;
  damagedQuantity?: number;
  missingQuantity?: number;
};

/** Captured media, held as data URLs so IndexedDB can round-trip it anywhere. */
export type QueuedMedia = {
  photos?: string[];
  signature?: string | null;
};

export type QueuedRecord =
  | ({
      kind: "pickup";
      clientRef: string;
      jobId: string;
      capturedAt: string;
      bagCount: number;
      totalWeightKg?: number | null;
      signedBy?: string | null;
      notes?: string | null;
      lines: QueuedLine[];
    } & QueuedMedia)
  | ({
      kind: "delivery";
      clientRef: string;
      jobId: string;
      capturedAt: string;
      signedBy?: string | null;
      notes?: string | null;
      lines: QueuedLine[];
    } & QueuedMedia)
  // "Something's wrong at this stop" (design spec P-5): flagged from the run
  // screen, queued and synced exactly like a pickup so it works with no signal.
  | ({
      kind: "exception";
      clientRef: string;
      jobId: string;
      capturedAt: string;
      reason: string;
      notes?: string | null;
    } & QueuedMedia);

export function newClientRef(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `ref-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "clientRef" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function enqueue(record: QueuedRecord): Promise<void> {
  await withStore("readwrite", (store) => store.put(record) as IDBRequest<IDBValidKey>);
}

export async function pending(): Promise<QueuedRecord[]> {
  try {
    return await withStore("readonly", (store) => store.getAll() as IDBRequest<QueuedRecord[]>);
  } catch {
    return [];
  }
}

async function remove(clientRefs: string[]): Promise<void> {
  if (!clientRefs.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    clientRefs.forEach((ref) => store.delete(ref));
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => reject(transaction.error);
  });
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const [, contentType = "application/octet-stream", isBase64, payload = ""] = match;
  try {
    if (!isBase64) return new Blob([decodeURIComponent(payload)], { type: contentType });
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: contentType });
  } catch {
    return null;
  }
}

async function upload(
  record: QueuedRecord, kind: "photo" | "signature", index: number, dataUrl: string,
): Promise<string | null> {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return null;

  const form = new FormData();
  form.set("scope", record.kind);
  form.set("kind", kind);
  form.set("ownerRef", record.clientRef);
  form.set("index", String(index));
  form.set("file", blob, `${kind}-${index}`);

  const response = await fetch("/api/media", { method: "POST", body: form });
  if (!response.ok) return null;
  const body = (await response.json()) as { path?: string };
  return body.path ?? null;
}

/** What `/api/sync` receives: the record minus its raw media, plus the paths. */
type SyncPayload = Omit<QueuedRecord, "photos" | "signature"> & {
  photoPaths?: string[];
  signaturePath?: string | null;
};

/**
 * Upload a record's media and hand back the payload the batch endpoint wants.
 * Returns null when any file fails, which holds the whole record back for the
 * next flush — a stop is proof-of-service or it is not, and half of one on the
 * server is worse than one still sitting in the outbox.
 */
async function withMedia(record: QueuedRecord): Promise<SyncPayload | null> {
  const { photos, signature, ...rest } = record;

  const photoPaths: string[] = [];
  for (const [index, photo] of (photos ?? []).entries()) {
    const path = await upload(record, "photo", index, photo);
    if (!path) return null;
    photoPaths.push(path);
  }

  let signaturePath: string | null = null;
  if (signature) {
    signaturePath = await upload(record, "signature", 0, signature);
    if (!signaturePath) return null;
  }

  return { ...rest, photoPaths, signaturePath } as SyncPayload;
}

export type FlushResult = { synced: number; remaining: number; offline: boolean };

/**
 * Push everything queued. Records the server accepts — or recognises as an
 * already-synced duplicate — leave the queue. Rejections stay so they can be
 * inspected rather than silently vanishing.
 */
export async function flush(): Promise<FlushResult> {
  const records = await pending();
  if (records.length === 0) return { synced: 0, remaining: 0, offline: false };
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { synced: 0, remaining: records.length, offline: true };
  }

  let payloads: SyncPayload[];
  try {
    payloads = (await Promise.all(records.map(withMedia))).filter(
      (payload): payload is SyncPayload => payload !== null,
    );
  } catch {
    return { synced: 0, remaining: records.length, offline: true };
  }
  if (payloads.length === 0) return { synced: 0, remaining: records.length, offline: false };

  let response: Response;
  try {
    response = await fetch("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ records: payloads }),
    });
  } catch {
    return { synced: 0, remaining: records.length, offline: true };
  }

  if (!response.ok) return { synced: 0, remaining: records.length, offline: false };

  const body = (await response.json()) as {
    outcomes: Array<{ clientRef: string; status: string }>;
  };

  const settled = body.outcomes
    .filter((outcome) => outcome.status === "accepted" || outcome.status === "duplicate")
    .map((outcome) => outcome.clientRef);

  await remove(settled);
  const left = await pending();
  return { synced: settled.length, remaining: left.length, offline: false };
}
