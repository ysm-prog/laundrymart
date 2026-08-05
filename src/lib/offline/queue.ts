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

export type QueuedRecord =
  | {
      kind: "pickup";
      clientRef: string;
      jobId: string;
      capturedAt: string;
      bagCount: number;
      totalWeightKg?: number | null;
      signedBy?: string | null;
      notes?: string | null;
      lines: QueuedLine[];
    }
  | {
      kind: "delivery";
      clientRef: string;
      jobId: string;
      capturedAt: string;
      signedBy?: string | null;
      notes?: string | null;
      lines: QueuedLine[];
    };

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

  let response: Response;
  try {
    response = await fetch("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ records }),
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
