"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { cx } from "./ui";
import { isActive, sectionFor, type NavCountKey, type NavItem } from "@/lib/nav";

export type NavCounts = Partial<Record<NavCountKey, number>>;

/**
 * The sidebar rail, on the pack's near-black surface.
 *
 * One flat list of areas — no headings, no nesting, no expanding tree. The
 * screens inside an area are tabs (`SectionNav`) rather than rail rows, because
 * a rail that lists every screen in the product is a table of contents for the
 * database, not a way to get to work.
 *
 * Deliberately not themed with the app's surface tokens: the rail is the one
 * surface that stays dark in both light and dark mode, exactly as the mockups
 * show, so it needs literal colours rather than `bg-surface`.
 *
 * Counts sit right-aligned per item. A zero is not rendered at all — a badge
 * showing "0" is noise, and the point of the badge is to pull attention.
 */
export function AppNav({
  items, counts, onNavigate,
}: {
  items: NavItem[];
  counts?: NavCounts;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const current = sectionFor(pathname, items);

  return (
    <nav aria-label="Main" className="flex flex-col py-1">
      {items.map((item) => {
        // The area owning the current path highlights, so a detail route still
        // says where you are — `isActive` alone would unlight the whole rail on
        // `/customers/abc`.
        const active = current ? current.href === item.href : isActive(pathname, item.href);
        const count = item.count ? counts?.[item.count] : undefined;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cx(
              "flex min-h-9 items-center justify-between gap-2 px-4 py-2 text-[13px] transition",
              active
                ? "bg-primary font-medium text-white"
                : "text-[#c7ced4] hover:bg-white/5 hover:text-white",
            )}
          >
            <span className="truncate">{item.label}</span>
            {count ? (
              <span className={cx(
                "font-mono text-2xs tabular-nums",
                active ? "text-white" : "text-[#7d8791]",
              )}>
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The screens inside the current area, as a tab strip under the context bar.
 *
 * Renders nothing for a single-screen area (a strip of one tab is decoration)
 * and nothing off the map at all, so print sheets and the run screen stay clean.
 * Scrolls horizontally on a phone rather than wrapping into a second row that
 * pushes the page content off the first screenful.
 */
export function SectionNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const section = sectionFor(pathname, items);
  const tabs = section?.children ?? [];
  if (tabs.length < 2) return null;

  return (
    <div className="flex-none border-b bg-surface print:hidden">
      <nav aria-label={section?.label ?? "Section"}
           className="flex gap-1 overflow-x-auto px-3 sm:px-4">
        {tabs.map((tab) => {
          const active = isActive(pathname, tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "-mb-px flex min-h-10 shrink-0 items-center border-b-2 px-2 text-[13px] transition",
                active
                  ? "border-b-action font-medium text-foreground"
                  : "border-b-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function MobileNav({ items, counts }: { items: NavItem[]; counts?: NavCounts }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [lastPathname, setLastPathname] = useState(pathname);

  // Close the drawer whenever a navigation actually lands. Adjusting state
  // during render (rather than in an effect) means the closed drawer is part of
  // the same commit as the new route — no flash of the old menu over the new page.
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        className="min-h-9 border border-strong px-2.5 py-1.5 text-[12.5px] font-medium"
      >
        {open ? "Close" : "Menu"}
      </button>
      {open ? (
        <div id="mobile-nav"
             className="absolute inset-x-0 top-full z-20 max-h-[70vh] overflow-y-auto bg-[#14171a] pb-3 shadow-lg">
          <AppNav items={items} counts={counts} onNavigate={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The `dark` class on <html> is the source of truth — it is set before paint by
 * the bootstrap script in the root layout, so React must read it rather than
 * own it. Subscribing to the attribute keeps the button label correct even if
 * something else flips the theme.
 */
function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

export function ThemeToggle() {
  const dark = useSyncExternalStore(
    subscribeToTheme,
    () => document.documentElement.classList.contains("dark"),
    () => false, // Server render: the bootstrap script has not run yet.
  );

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // Private browsing with storage disabled — the toggle still works for this session.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      className="border border-strong px-2 py-1.5 font-mono text-2xs hover:bg-surface-muted"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span aria-hidden>{dark ? "☀" : "☾"}</span>
      <span className="sr-only">{dark ? "Switch to light mode" : "Switch to dark mode"}</span>
    </button>
  );
}
