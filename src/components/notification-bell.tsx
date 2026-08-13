import Link from "next/link";
import { Bell } from "lucide-react";

/**
 * The header bell (AD-4).
 *
 * Presentational and server-rendered: the count is resolved once per request in
 * the `(app)` layout, next to the five nav badges and by the same rule — a
 * `head: true` count, no realtime, no polling. A laundry does not need live
 * push; it needs the number to be right when someone looks at it.
 *
 * Zero renders no badge at all, matching the nav: a badge showing "0" is noise,
 * and the badge exists to pull attention. The unread count reads as the brand
 * dot rather than as a status colour — unread mail is not an alert.
 */
export function NotificationBell({ count }: { count?: number }) {
  const label = count ? `Notifications — ${count} unread` : "Notifications";

  return (
    <Link
      href="/notifications"
      title={label}
      aria-label={label}
      className="relative flex size-10 shrink-0 items-center justify-center rounded-lg
                 text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
    >
      <Bell className="size-[1.15rem]" aria-hidden />
      {count ? (
        <span className="absolute right-1 top-1 min-w-[1.05rem] rounded-full bg-primary px-1
                         text-center text-3xs font-semibold leading-[1.05rem]
                         text-primary-foreground">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
