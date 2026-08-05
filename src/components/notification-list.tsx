import { Eyebrow, EmptyState, cx } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { NOTIFICATION_EVENTS, type NotificationKind } from "@/lib/notifications/kinds";

export type NotificationListItem = {
  id: string;
  kind: NotificationKind;
  title: string;
  href: string;
  created_at: string;
  read_at: string | null;
};

/**
 * The notification panel, presentational so `/design-preview` can render it
 * without a database.
 *
 * Each row is a **form**, not a link. Next prefetches links on hover and in the
 * viewport, and the row's destination marks the notification read on the way
 * through — so links would empty the bell for anyone who merely scrolled past.
 *
 * Read/unread is carried by weight and a marker rather than by colour. The
 * design language reserves colour for status (on track, warning, late,
 * resolved), and "you have not looked at this yet" is not one of those.
 */
export function NotificationList({
  items, action, emptyTitle, emptyDescription,
}: {
  items: NotificationListItem[];
  /** Server action receiving `id`. Marks read, then redirects to the row's href. */
  action: (formData: FormData) => void | Promise<void>;
  emptyTitle: string;
  emptyDescription?: string;
}) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <ul className="divide-y border">
      {items.map((item) => {
        const unread = item.read_at === null;
        return (
          <li key={item.id}>
            <form action={action}>
              <input type="hidden" name="id" value={item.id} />
              <button
                type="submit"
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left
                           transition hover:bg-surface-muted"
              >
                <span
                  aria-hidden
                  className={cx(
                    "mt-1.5 h-1.5 w-1.5 shrink-0",
                    unread ? "bg-foreground" : "bg-transparent",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block">
                    <Eyebrow>{NOTIFICATION_EVENTS[item.kind].label}</Eyebrow>
                  </span>
                  <span className={cx(
                    "mt-0.5 block text-[12.5px] leading-snug",
                    unread ? "font-medium" : "text-muted-foreground",
                  )}>
                    {item.title}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-3xs text-muted-foreground">
                  {dateTime(item.created_at)}
                </span>
                <span className="sr-only">
                  {unread ? "Unread — open and mark as read" : "Open"}
                </span>
              </button>
            </form>
          </li>
        );
      })}
    </ul>
  );
}
