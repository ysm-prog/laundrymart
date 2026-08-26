import { requireSession } from "@/lib/auth/context";
import { listNotifications } from "@/lib/notifications/query";
import { NOTIFICATION_KINDS } from "@/lib/notifications/kinds";
import { NotificationList } from "@/components/notification-list";
import { PageHeader, ButtonLink, Button, humanise } from "@/components/ui";
import { FilterChips, FilterSummary, ToggleChips } from "@/components/filters";
import { isFiltered, parseMulti } from "@/lib/filters";
import { can } from "@/lib/roles";
import { markAllRead, openNotification } from "./actions";

export const metadata = { title: "Notifications" };

type Search = { show?: string; kind?: string };
const FILTER_KEYS = ["show", "kind"] as const;

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
  searchParams: Promise<Search>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const includeRead = params.show === "all";

  const all = await listNotifications(session, { includeRead });
  const hasUnread = all.some((item) => item.read_at === null);

  // Filtered in memory: the list is capped at 50 and every chip has to carry the
  // number of rows it would show, which a filtered read cannot answer.
  const kinds = parseMulti(params.kind, NOTIFICATION_KINDS);
  const items = kinds.length ? all.filter((item) => kinds.includes(item.kind)) : all;
  const filtered = isFiltered(params, FILTER_KEYS);
  const kindCount = (kind: string) => all.filter((item) => item.kind === kind).length;

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

      {/* Read/unread is a single-select view rather than a toggle button: the
          button said "Show read too" and its own label was the only thing on
          screen saying which view you were in. */}
      <div className="mb-4 flex flex-col gap-3">
        <FilterChips
          basePath="/notifications" params={params} name="show" label="Read or unread"
          allLabel="Unread only" allCount={all.filter((item) => item.read_at === null).length}
          options={[{ value: "all", label: "Read too", title: "Nothing is ever deleted" }]}
        />
        {/* Only the kinds this laundry has actually been told about — six chips
            of which four show nothing is a filter that mostly cannot be used. */}
        {NOTIFICATION_KINDS.some((kind) => kindCount(kind) > 0) ? (
          <ToggleChips
            basePath="/notifications" params={params} name="kind" label="Kind of notice"
            allLabel="Everything" allCount={all.length}
            options={NOTIFICATION_KINDS
              .filter((kind) => kindCount(kind) > 0)
              .map((kind) => ({
                value: kind, label: humanise(kind), count: kindCount(kind),
              }))}
          />
        ) : null}
        <FilterSummary basePath="/notifications" shown={items.length} total={all.length}
                       noun="notification" filtered={filtered} />
      </div>

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
