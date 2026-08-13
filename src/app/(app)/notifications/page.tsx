import { requireSession } from "@/lib/auth/context";
import { listNotifications } from "@/lib/notifications/query";
import { NotificationList } from "@/components/notification-list";
import { PageHeader, ButtonLink, Button } from "@/components/ui";
import { can } from "@/lib/roles";
import { markAllRead, openNotification } from "./actions";

export const metadata = { title: "Notifications" };

/**
 * Everything the app has spoken up about, newest first.
 *
 * No capability guard: what a role may see is decided by the audience filter in
 * `listNotifications()`, and a role with nothing to be told simply gets an empty
 * list. Guarding the page instead would leave the bell in the context bar
 * pointing at a redirect.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const session = await requireSession();
  const { show } = await searchParams;
  const includeRead = show === "all";

  const items = await listNotifications(session, { includeRead });
  const hasUnread = items.some((item) => item.read_at === null);

  return (
    <>
      <PageHeader
        eyebrow="Notifications"
        title={includeRead ? "Everything you've been told" : "Needs your attention"}
        description={
          includeRead
            ? "Read and unread, newest first. Nothing is ever deleted."
            : "Things the app noticed on its own. Open one to go where it gets handled."
        }
        actions={
          <>
            <ButtonLink href={includeRead ? "/notifications" : "/notifications?show=all"}>
              {includeRead ? "Unread only" : "Show read too"}
            </ButtonLink>
            {hasUnread ? (
              <form action={markAllRead}>
                <Button variant="secondary">Mark all as read</Button>
              </form>
            ) : null}
            {can(session.role, "admin.write") ? (
              <ButtonLink href="/admin/notifications">Settings</ButtonLink>
            ) : null}
          </>
        }
      />

      <NotificationList
        items={items}
        action={openNotification}
        emptyTitle={includeRead ? "Nothing here yet." : "You're all caught up."}
        emptyDescription={
          includeRead
            ? "The app will tell you when an invoice passes its terms, a run doesn't leave on time, or something goes wrong on the floor."
            : "Anything the app notices — an overdue invoice, a run still at the depot, a failed inspection — turns up here."
        }
      />
    </>
  );
}
