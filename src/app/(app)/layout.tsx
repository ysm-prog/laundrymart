import { cookies } from "next/headers";
import { requireSession, type Session } from "@/lib/auth/context";
import { navigationFor } from "@/lib/nav";
import { ROLE_LABELS } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { today } from "@/lib/format";
import { SectionNav, ThemeToggle, type NavCounts } from "@/components/app-nav";
import { AppShell } from "@/components/app-shell";
import { GlobalSearch } from "@/components/global-search";
import { UserMenu } from "@/components/user-menu";
import { NotificationBell } from "@/components/notification-bell";
import { unreadNotificationCount } from "@/lib/notifications/query";

/**
 * Counts for the sidebar badges.
 *
 * Five head-only counts, issued together — no rows come back, just the numbers,
 * and each is served by an existing index. They are the reason the rail is worth
 * looking at, so they run inline rather than streaming in afterwards; a badge
 * that appears a second late is a badge nobody trusts.
 *
 * Any failure yields no badges at all rather than a wrong one: an empty rail is
 * honest, a stale count is not.
 */
async function navCounts(): Promise<NavCounts> {
  try {
    const supabase = await createClient();
    const head = { count: "exact" as const, head: true };

    // No runs-today count: the rail no longer has a Runs row to hang it on, and
    // querying for a badge nothing renders is a request every page load pays for.
    const [exceptions, batches, unpaid, overdueJobs, awaitingInvoice] = await Promise.all([
      supabase.from("jobs").select("id", head).eq("status", "exception"),
      supabase.from("production_batches").select("id", head)
        .in("stage", ["received", "washing", "drying", "folding", "packing", "ready_for_dispatch"])
        .is("deleted_at", null),
      supabase.from("invoices").select("id", head)
        .in("status", ["issued", "part_paid", "overdue"]).is("deleted_at", null),
      // Late jobs. Computed, never stored — `due_date` is the generated column
      // that already picks delivery-or-collection, and the partial index in
      // 0014 covers exactly this predicate.
      supabase.from("laundry_orders").select("id", head)
        .lt("due_date", today())
        .not("status", "in", "(completed,cancelled)"),
      // Work finished and not yet billed. Served by the partial index 0017 adds
      // on exactly this predicate. For a role with no billing capability the
      // row this badge hangs on is not rendered at all, so the count is never
      // shown — but it still costs a query, which is why it is head-only.
      supabase.from("laundry_orders").select("id", head)
        .in("billing_status", ["awaiting_review", "approved"]),
    ]);

    return {
      exceptions: exceptions.count ?? undefined,
      batches: batches.count ?? undefined,
      unpaidInvoices: unpaid.count ?? undefined,
      overdueJobs: overdueJobs.count ?? undefined,
      awaitingInvoice: awaitingInvoice.count ?? undefined,
    };
  } catch {
    return {};
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Gate the whole group once; child pages reuse the memoised session.
  const session = await requireSession();
  const items = navigationFor(session.role);
  // Both resolve to head-only counts; issued together so the bell is no slower
  // than the rail it sits beside.
  const [counts, unread, cookieStore] = await Promise.all([
    navCounts(),
    unreadNotificationCount(session),
    cookies(),
  ]);

  // Read here rather than in the browser so the rail paints at the right width
  // on the very first frame instead of snapping after hydration.
  const collapsed = cookieStore.get("es_rail")?.value === "collapsed";

  return (
    <AppShell
      items={items}
      counts={counts}
      tenantName={session.tenantName}
      defaultCollapsed={collapsed}
      sectionSlot={<SectionNav items={items} />}
      headerSlot={
        <>
          <GlobalSearch />
          {/* No `ml-auto` here: on a phone the search icon carries it, and on
              `sm` and up the search field is `flex-1` and pushes these right. */}
          <div className="flex items-center gap-1">
            <span className="mr-1 hidden text-sm text-muted-foreground lg:inline">{today()}</span>
            <NotificationBell count={unread} />
            <ThemeToggle />
            <UserMenu
              email={session.email ?? "Signed in"}
              role={ROLE_LABELS[session.role]}
              initials={initials(session)}
            />
          </div>
        </>
      }
    >
      {children}
    </AppShell>
  );
}

function initials(session: Session): string {
  const source = session.email ?? "";
  const name = source.split("@")[0] ?? "";
  const parts = name.split(/[.\-_]/).filter(Boolean);
  const letters = parts.length >= 2
    ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`
    : name.slice(0, 2);
  return letters.toUpperCase() || "??";
}
