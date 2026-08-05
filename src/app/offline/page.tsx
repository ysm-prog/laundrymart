export const metadata = { title: "Offline" };

/** Served by the service worker when a navigation fails with no cached copy. */
export default function OfflinePage() {
  return (
    <main id="main" className="mx-auto max-w-md px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">You are offline</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Anything you captured on your run is saved on this device and will sync
        automatically as soon as you have signal again. Nothing has been lost.
      </p>
      <a href="/run" className="mt-6 inline-block rounded-md border px-4 py-2 text-sm font-medium">
        Back to my run
      </a>
    </main>
  );
}
