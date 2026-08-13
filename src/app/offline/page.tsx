import { CloudOff } from "lucide-react";

export const metadata = { title: "Offline" };

/** Served by the service worker when a navigation fails with no cached copy. */
export default function OfflinePage() {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16
                               text-center">
      <span aria-hidden
            className="mx-auto flex size-14 items-center justify-center rounded-full
                       bg-surface-sunken text-muted-foreground">
        <CloudOff className="size-6" />
      </span>
      <h1 className="mt-5 text-2xl font-semibold">You are offline</h1>
      <p className="mx-auto mt-2 max-w-sm text-[0.9375rem] leading-relaxed text-muted-foreground">
        Anything you captured on your run is saved on this device and will sync automatically as
        soon as you have signal again. Nothing has been lost.
      </p>
      <a href="/run"
         className="mx-auto mt-7 inline-flex min-h-11 items-center rounded-lg bg-action px-6
                    text-sm font-medium text-action-foreground shadow-sm transition
                    hover:brightness-110">
        Back to my run
      </a>
      <p className="mt-10 text-sm text-muted-foreground">Electro Services</p>
    </main>
  );
}
