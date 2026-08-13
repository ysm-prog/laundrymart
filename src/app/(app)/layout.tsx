import Link from "next/link";
import { requireSession, type Session } from "@/lib/auth/context";
import { navigationFor } from "@/lib/nav";
import { ROLE_LABELS } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { today } from "@/lib/format";
import { AppNav, MobileNav, SectionNav, ThemeToggle, type NavCounts } from "@/components/app-nav";
import { NotificationBell } from "@/components/notification-bell";
import { unreadNotificationCount } from "@/lib/notifications/query";
import { signOut } from "@/app/login/actions";

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

    const [routes, exceptions, batches, unpaid, overdueJobs] = await Promise.all([
      supabase.from("daily_routes").select("id", head).eq("route_date", today()),
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
    ]);

    return {
      routesToday: routes.count ?? undefined,
      exceptions: exceptions.count ?? undefined,
      batches: batches.count ?? undefined,
      unpaidInvoices: unpaid.count ?? undefined,
      overdueJobs: overdueJobs.count ?? undefined,
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
  const [counts, unread] = await Promise.all([
    navCounts(),
    unreadNotificationCount(session),
  ]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[212px_1fr]">
      {/* The rail keeps its own near-black surface in both themes, as designed. */}
      {/* The right border matters in dark mode, where the page background is the
          same near-black as the rail and the edge would otherwise vanish. */}
      <aside className="hidden border-r border-[#262c31] bg-[#14171a] pb-3 pt-3.5 lg:flex lg:flex-col">
        <div className="border-b border-[#262c31] px-4 pb-3.5">
          <Link href="/dashboard" className="block text-sm font-semibold tracking-[-0.01em] text-white">
            LaundryMart
          </Link>
          <span className="mt-0.5 block truncate font-mono text-3xs text-[#7d8791]">
            {session.tenantName}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto">
          <AppNav items={items} counts={counts} />
        </div>

        <div className="mt-auto border-t border-[#262c31] px-4 pt-3">
          <div className="flex items-center gap-2">
            <span aria-hidden
                  className="grid h-6 w-6 shrink-0 place-items-center bg-[#3a444d] text-2xs font-semibold text-white">
              {initials(session)}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs text-white">{session.email ?? "Signed in"}</span>
              <span className="block font-mono text-3xs text-[#7d8791]">{ROLE_LABELS[session.role]}</span>
            </span>
          </div>
          <form action={signOut} className="mt-2.5">
            <button type="submit"
                    className="w-full border border-[#3a444d] px-2 py-1 text-left text-xs text-[#c7ced4]
                               transition hover:border-[#5b6570] hover:text-white">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* Context bar: what you are looking at, and one search that works. */}
        <header className="sticky top-0 z-30 flex h-[52px] flex-none items-center gap-2.5
                           border-b bg-surface/95 px-3 backdrop-blur sm:px-4">
          <MobileNav items={items} counts={counts} />
          <Link href="/dashboard" className="text-sm font-semibold lg:hidden">LaundryMart</Link>

          {/* One box that finds anything with a name or a number on it. It used
              to submit to the customers list, which quietly meant an invoice
              number typed here returned "no customers match". */}
          <form action="/search" className="hidden min-w-0 flex-1 sm:block">
            <label htmlFor="global-q" className="sr-only">
              Search customers, invoices, stops, vehicles
            </label>
            <input
              id="global-q" name="q" type="search"
              placeholder="Search a customer, invoice, stop or rego…"
              className="min-h-9 w-full max-w-[420px] border border-strong bg-surface-muted px-2.5 py-1.5
                         text-[12.5px] placeholder:text-muted-foreground"
            />
          </form>

          <Link href="/search"
                className="ml-auto min-h-9 border border-strong px-2.5 py-1.5 text-[12.5px] sm:hidden">
            Search
          </Link>

          <span className="ml-auto hidden border border-border px-2 py-1 font-mono text-2xs
                           text-muted-foreground md:inline">
            {today()}
          </span>
          <NotificationBell count={unread} />
          <ThemeToggle />
        </header>

        <SectionNav items={items} />

        <main id="main" className="min-w-0 flex-1 p-4 sm:p-5">{children}</main>
      </div>
    </div>
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
