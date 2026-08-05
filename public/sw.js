/*
 * Service worker for the driver PWA.
 *
 * Scope is deliberately narrow: keep the app shell reachable without signal so
 * a driver can open their run and capture stops. Field data is NOT cached here
 * — it goes through the IndexedDB outbox in src/lib/offline/queue.ts, which is
 * idempotent and replayable. Caching mutations in the worker would risk
 * silently re-posting them.
 */
const CACHE = "laundrymart-shell-v1";
const SHELL = ["/run", "/offline", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Never intercept writes — the outbox owns offline mutations.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // Network-first so drivers see live data whenever they have signal.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          return response;
        })
        .catch(async () => (await caches.match(request)) ?? (await caches.match("/offline")) ??
          new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } })),
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    // Immutable build assets: cache-first is safe and makes cold starts quick.
    event.respondWith(
      caches.match(request).then((cached) =>
        cached ?? fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          return response;
        }),
      ),
    );
  }
});

// Nudge open tabs to flush their outbox as soon as connectivity returns.
self.addEventListener("sync", (event) => {
  if (event.tag !== "laundrymart-outbox") return;
  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true })
      .then((clients) => clients.forEach((client) => client.postMessage({ type: "flush-outbox" }))),
  );
});
