import Link from "next/link";

/**
 * The context-bar bell (AD-4).
 *
 * Presentational and server-rendered: the count is resolved once per request in
 * the `(app)` layout, next to the four nav badges and by the same rule — a
 * `head: true` count, no realtime, no polling. A laundry does not need live
 * push; it needs the number to be right when someone looks at it.
 *
 * Zero renders no badge at all, matching the nav: a badge showing "0" is noise,
 * and the badge exists to pull attention.
 *
 * The count is deliberately not colour-coded. Colour means status in this design
 * language, and "there are things to read" is not a status — the border and the
 * numeral carry it.
 */
export function NotificationBell({ count }: { count?: number }) {
  const label = count
    ? `Notifications — ${count} unread`
    : "Notifications";

  return (
    <Link
      href="/notifications"
      title={label}
      aria-label={label}
      className="relative flex items-center gap-1.5 border border-strong px-2 py-1.5
                 font-mono text-2xs hover:bg-surface-muted"
    >
      {/* Inline, monochrome, `currentColor` — the rail and bar are near-black in
          both themes, and an emoji bell would drag colour into a surface where
          colour is reserved for status. */}
      <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none"
           stroke="currentColor" strokeWidth="1.3" strokeLinecap="square">
        <path d="M4 6.5a4 4 0 0 1 8 0c0 3 1 4 1 4H3s1-1 1-4Z" />
        <path d="M6.5 13a1.6 1.6 0 0 0 3 0" />
      </svg>
      {count ? (
        <span className="min-w-[1.25rem] bg-foreground px-1 text-center text-3xs
                         font-semibold leading-4 text-surface">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
