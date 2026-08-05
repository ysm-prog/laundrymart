import Link from "next/link";
import { requireSession } from "@/lib/auth/context";
import { navigationFor } from "@/lib/nav";
import { ROLE_LABELS } from "@/lib/roles";
import { AppNav, MobileNav, ThemeToggle } from "@/components/app-nav";
import { signOut } from "@/app/login/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Gate the whole group once; child pages reuse the memoised session.
  const session = await requireSession();
  const items = navigationFor(session.role);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b bg-surface/95 backdrop-blur">
        <div className="relative flex items-center gap-3 px-4 py-3">
          <MobileNav items={items} />
          <Link href="/dashboard" className="font-semibold tracking-tight">
            LaundryMart
          </Link>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {session.tenantName}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-right text-xs leading-tight sm:block">
              <span className="block font-medium">{session.email ?? "Signed in"}</span>
              <span className="block text-muted-foreground">{ROLE_LABELS[session.role]}</span>
            </span>
            <ThemeToggle />
            <form action={signOut}>
              <button type="submit" className="rounded-md border px-3 py-2 text-sm hover:bg-surface-muted">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="flex">
        <aside className="hidden w-60 shrink-0 border-r p-3 lg:block">
          <div className="sticky top-[4.25rem]">
            <AppNav items={items} />
          </div>
        </aside>
        <main id="main" className="min-w-0 flex-1 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
