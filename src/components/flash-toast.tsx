"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cx } from "./ui";
import type { Flash } from "@/lib/actions";

/**
 * The toast half of the flash convention: the server (`(app)/template.tsx`)
 * reads the one-shot cookie and passes it down; this component shows it and
 * deletes the cookie so it is never replayed. Success dismisses itself after
 * five seconds; an error stays until the user closes it — good news can pass
 * by, bad news must be acknowledged.
 *
 * Visually this is the `Notice` grammar (hairline box, 5px status rule on the
 * leading edge, square corners) floated above the page — colour keeps meaning
 * status, nothing else.
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
    <div className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex justify-center sm:inset-x-auto sm:bottom-4 sm:right-4 sm:justify-end">
      <div
        role={isError ? "alert" : "status"}
        className={cx(
          "pointer-events-auto flex max-w-[440px] items-start gap-2.5 border border-l-[5px] bg-surface px-3 py-2 text-[12.5px] shadow-sm",
          isError
            ? "border-danger/40 border-l-danger text-danger"
            : "border-success/40 border-l-success text-success",
        )}
      >
        <div className="min-w-0 flex-1">
          <p>{current.message}</p>
          {current.link ? (
            // The one-click fix: a prerequisite failure names the screen that
            // resolves it. Same status colour — the link is part of the message.
            <Link href={current.link.href} onClick={() => setCurrent(null)}
                  className="mt-0.5 inline-block font-medium underline underline-offset-2">
              {current.link.label} →
            </Link>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setCurrent(null)}
          aria-label="Dismiss"
          className="shrink-0 border border-transparent px-1 leading-none hover:border-strong"
        >
          ×
        </button>
      </div>
    </div>
  );
}
