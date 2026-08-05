"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { cx } from "./ui";
import { isActive, type NavCountKey, type NavSection } from "@/lib/nav";

export type NavCounts = Partial<Record<NavCountKey, number>>;

/**
 * The sidebar nav, on the pack's near-black rail.
 *
 * Deliberately not themed with the app's surface tokens: the rail is the one
 * surface that stays dark in both light and dark mode, exactly as the mockups
 * show, so it needs literal colours rather than `bg-surface`.
 *
 * Counts sit right-aligned per item. A zero is not rendered at all — a badge
 * showing "0" is noise, and the point of the badge is to pull attention.
 */
export function AppNav({
  sections, counts, onNavigate,
}: {
  sections: NavSection[];
  counts?: NavCounts;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex flex-col">
      {sections.map((section) => (
        <div key={section.label}>
          <div className="px-4 pb-1.5 pt-3 font-mono text-3xs uppercase tracking-[0.12em] text-[#6b757f]">
            {section.label}
          </div>
          {section.items.map((item) => {
            const active = isActive(pathname, item.href);
            const count = item.count ? counts?.[item.count] : undefined;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex items-center justify-between gap-2 px-4 py-1.5 text-[13px] transition",
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
        </div>
      ))}
    </nav>
  );
}

export function MobileNav({ sections, counts }: { sections: NavSection[]; counts?: NavCounts }) {
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
        className="border border-strong px-2.5 py-1.5 text-[12.5px] font-medium"
      >
        {open ? "Close" : "Menu"}
      </button>
      {open ? (
        <div id="mobile-nav"
             className="absolute inset-x-0 top-full z-20 max-h-[70vh] overflow-y-auto bg-[#14171a] pb-3 shadow-lg">
          <AppNav sections={sections} counts={counts} onNavigate={() => setOpen(false)} />
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
