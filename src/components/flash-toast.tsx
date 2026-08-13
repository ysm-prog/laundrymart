"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CircleCheck, CircleX, X } from "lucide-react";
import { cx } from "./ui";
import type { Flash } from "@/lib/actions";

/**
 * The toast half of the flash convention: the server (`(app)/template.tsx`)
 * reads the one-shot cookie and passes it down; this component shows it and
 * deletes the cookie so it is never replayed. Success dismisses itself after
 * five seconds; an error stays until the user closes it — good news can pass
 * by, bad news must be acknowledged.
 *
 * Visually it is a soft card floated over the page with a status icon, matching
 * the `Notice` grammar used inline. The icon matters: it carries success and
 * failure without relying on the green and the red alone.
 */
export function FlashToast({ flash }: { flash: Flash | null }) {
  const [current, setCurrent] = useState(flash);
  // A fresh server render hands over a fresh object; adopt it during render so
  // the toast and the navigation that caused it land in the same paint.
  const [adopted, setAdopted] = useState(flash);
  if (flash !== adopted) {
    setAdopted(flash);
    if (flash) setCurrent(flash);
  }

  useEffect(() => {
    if (!current) return;
    // One-shot: consumed the moment it is shown.
    document.cookie = "flash=; Max-Age=0; path=/";
    if (current.tone === "success") {
      const timer = setTimeout(() => setCurrent(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [current]);

  if (!current) return null;
  const isError = current.tone === "error";

  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex justify-center
                    sm:inset-x-auto sm:bottom-5 sm:right-5 sm:justify-end">
      <div
        role={isError ? "alert" : "status"}
        className={cx(
          "pointer-events-auto flex max-w-[26rem] animate-slide-up items-start gap-3 rounded-xl",
          "border bg-surface py-3 pl-4 pr-3 text-sm shadow-lg",
          isError ? "border-danger/30" : "border-success/30",
        )}
      >
        {isError
          ? <CircleX className="mt-0.5 size-[1.15rem] shrink-0 text-danger" aria-hidden />
          : <CircleCheck className="mt-0.5 size-[1.15rem] shrink-0 text-success" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="font-medium">{current.message}</p>
          {current.link ? (
            // The one-click fix: a prerequisite failure names the screen that
            // resolves it.
            <Link href={current.link.href} onClick={() => setCurrent(null)}
                  className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary
                             underline underline-offset-2">
              {current.link.label} →
            </Link>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setCurrent(null)}
          aria-label="Dismiss"
          className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-lg
                     text-muted-foreground transition hover:bg-surface-muted"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
