"use client";

import { useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { cx } from "./ui";

/**
 * The one box that finds anything with a name or a number on it.
 *
 * It submits to `/search`, which searches customers, contracts, invoices,
 * stops, item types, drivers and vehicles — each group gated exactly like its
 * own screen. (It used to submit to the customers list, which quietly meant an
 * invoice number typed here returned "no customers match".)
 *
 * From `sm` up it is a normal field in the header. Below that the header has no
 * room for a 320px input beside the menu button and the bell, so it collapses
 * to an icon and expands over the header when tapped.
 */
export function GlobalSearch() {
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const field = (
    <div className="relative w-full">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2
                         text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        id="global-q" name="q" type="search"
        placeholder="Search customers, jobs, invoices, stops…"
        className="min-h-10 w-full rounded-lg border border-strong bg-surface-muted py-2 pl-9 pr-3
                   text-sm transition placeholder:text-muted-foreground
                   focus:border-primary focus:bg-surface
                   focus:ring-2 focus:ring-primary/25"
      />
    </div>
  );

  return (
    <>
      {/* Tablet and desktop: always present, capped so it does not swallow the bar. */}
      <form action="/search" className="ml-1 hidden min-w-0 max-w-[26rem] flex-1 sm:block">
        <label htmlFor="global-q" className="sr-only">
          Search customers, jobs, invoices and stops
        </label>
        {field}
      </form>

      {/* Phone: an icon that expands over the header. */}
      <button type="button" onClick={() => setExpanded(true)}
              className="ml-auto flex size-10 shrink-0 items-center justify-center rounded-lg
                         text-muted-foreground transition hover:bg-surface-muted sm:hidden">
        <Search className="size-[1.15rem]" aria-hidden />
        <span className="sr-only">Search</span>
      </button>

      {expanded ? (
        <div className={cx(
          "absolute inset-x-0 top-0 z-40 flex h-16 items-center gap-2 border-b bg-surface px-3",
          "animate-fade-in sm:hidden",
        )}>
          <form action="/search" className="min-w-0 flex-1">
            <label htmlFor="global-q" className="sr-only">
              Search customers, jobs, invoices and stops
            </label>
            {field}
          </form>
          <button type="button" onClick={() => setExpanded(false)}
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg
                             text-muted-foreground transition hover:bg-surface-muted">
            <X className="size-5" aria-hidden />
            <span className="sr-only">Close search</span>
          </button>
        </div>
      ) : null}
    </>
  );
}
