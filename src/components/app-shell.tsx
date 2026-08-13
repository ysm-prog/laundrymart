"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, PanelLeft, PanelLeftClose, X } from "lucide-react";
import { cx } from "./ui";
import { AppNav, BrandMark, type NavCounts } from "./app-nav";
import type { NavItem } from "@/lib/nav";

/**
 * The application frame: rail, header, content.
 *
 * A client component because two pieces of state live here — whether the
 * desktop rail is collapsed, and whether the phone drawer is open. Everything
 * inside is still server-rendered and handed in as slots, so making the frame
 * interactive costs nothing in what ships to the browser.
 *
 * The collapsed preference arrives from a cookie read in the layout rather than
 * from localStorage in an effect: the server already knows it, so the rail
 * renders at the right width on the first paint instead of snapping after it.
 */
export function AppShell({
  items, counts, tenantName, headerSlot, sectionSlot, defaultCollapsed, children,
}: {
  items: NavItem[];
  counts?: NavCounts;
  tenantName: string;
  headerSlot: ReactNode;
  sectionSlot: ReactNode;
  defaultCollapsed: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  const [lastPathname, setLastPathname] = useState(pathname);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Close the drawer whenever a navigation actually lands. Adjusting state
  // during render (rather than in an effect) means the closed drawer is part of
  // the same commit as the new route — no flash of the old menu over the new page.
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setDrawerOpen(false);
  }

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    // A year, path-wide, lax: a layout preference, not a credential.
    document.cookie = `es_rail=${next ? "collapsed" : "expanded"};path=/;max-age=31536000;samesite=lax`;
  }

  // Move focus into the drawer when it opens, and hold it there while it is up.
  useEffect(() => {
    if (!drawerOpen) return;
    closeRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  return (
    <div className={cx(
      "min-h-screen lg:grid",
      collapsed ? "lg:grid-cols-[4.5rem_1fr]" : "lg:grid-cols-[16rem_1fr]",
    )}>
      {/* ------------------------------------------------ desktop rail --- */}
      <aside className="sticky top-0 hidden h-screen flex-col border-r bg-sidebar lg:flex">
        <div className={cx(
          "flex h-16 flex-none items-center border-b border-sidebar-border",
          collapsed ? "justify-center px-2" : "px-4",
        )}>
          <Link href="/dashboard"
                className="flex min-w-0 items-center gap-2.5"
                title={collapsed ? "Electro Services" : undefined}>
            <BrandMark />
            {collapsed ? null : (
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold leading-tight">
                  Electro Services
                </span>
                <span className="block truncate text-2xs text-sidebar-muted">{tenantName}</span>
              </span>
            )}
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-3">
          <AppNav items={items} counts={counts} collapsed={collapsed} />
        </div>

        <div className="flex-none border-t border-sidebar-border p-2">
          <button type="button" onClick={toggleCollapsed}
                  aria-pressed={collapsed}
                  className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm
                             text-sidebar-muted transition hover:bg-sidebar-hover hover:text-sidebar-foreground">
            {collapsed
              ? <PanelLeft className="size-[1.15rem] shrink-0" aria-hidden />
              : <PanelLeftClose className="size-[1.15rem] shrink-0" aria-hidden />}
            {collapsed ? null : <span>Collapse menu</span>}
            <span className="sr-only">{collapsed ? "Expand menu" : "Collapse menu"}</span>
          </button>
        </div>
      </aside>

      {/* ------------------------------------------------ phone drawer --- */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" tabIndex={-1} aria-hidden
                  onClick={() => setDrawerOpen(false)}
                  className="absolute inset-0 animate-fade-in bg-foreground/40 backdrop-blur-[2px]" />
          {/* The dialog role goes on the panel, so the scrim is not announced
              as part of the menu. */}
          <div ref={drawerRef} id="mobile-nav"
               role="dialog" aria-modal="true" aria-label="Main menu"
               className="absolute inset-y-0 left-0 flex w-[17.5rem] max-w-[85vw] animate-slide-in-left
                          flex-col bg-sidebar shadow-2xl">
            <div className="flex h-16 flex-none items-center justify-between gap-2 border-b
                            border-sidebar-border px-4">
              <Link href="/dashboard" className="flex min-w-0 items-center gap-2.5">
                <BrandMark />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold leading-tight">
                    Electro Services
                  </span>
                  <span className="block truncate text-2xs text-sidebar-muted">{tenantName}</span>
                </span>
              </Link>
              <button ref={closeRef} type="button" onClick={() => setDrawerOpen(false)}
                      className="flex size-10 shrink-0 items-center justify-center rounded-lg
                                 text-sidebar-muted transition hover:bg-sidebar-hover">
                <X className="size-5" aria-hidden />
                <span className="sr-only">Close menu</span>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-3">
              <AppNav items={items} counts={counts} onNavigate={() => setDrawerOpen(false)} />
            </div>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------------ content --- */}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-16 flex-none items-center gap-2 border-b
                           bg-surface/90 px-3 backdrop-blur sm:px-5 print:hidden">
          <button type="button" onClick={() => setDrawerOpen(true)}
                  aria-expanded={drawerOpen} aria-controls="mobile-nav"
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg
                             text-muted-foreground transition hover:bg-surface-muted lg:hidden">
            <Menu className="size-5" aria-hidden />
            <span className="sr-only">Open menu</span>
          </button>
          <Link href="/dashboard" className="flex items-center gap-2 lg:hidden">
            <BrandMark />
            <span className="hidden text-sm font-semibold sm:inline">Electro Services</span>
          </Link>
          {headerSlot}
        </header>

        {sectionSlot}

        <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
