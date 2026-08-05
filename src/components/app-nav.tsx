"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { cx } from "./ui";
import { isActive, type NavItem } from "@/lib/nav";

export function AppNav({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="space-y-1 text-sm">
      {items.map((item) => {
        const active = isActive(pathname, item.href) ||
          (item.children?.some((child) => isActive(pathname, child.href)) ?? false);
        return (
          <div key={item.label}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cx(
                "block rounded-md px-3 py-2 font-medium transition",
                active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-surface-muted",
              )}
            >
              {item.label}
            </Link>
            {active && item.children?.length ? (
              <div className="ml-3 mt-0.5 space-y-0.5 border-l pl-3">
                {item.children.map((child) => (
                  <Link
                    key={child.href}
                    href={child.href}
                    onClick={onNavigate}
                    aria-current={isActive(pathname, child.href) ? "page" : undefined}
                    className={cx(
                      "block rounded-md px-2 py-1.5 transition",
                      isActive(pathname, child.href)
                        ? "font-medium text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {child.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

export function MobileNav({ items }: { items: NavItem[] }) {
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
        className="rounded-md border px-3 py-2 text-sm font-medium"
      >
        {open ? "Close" : "Menu"}
      </button>
      {open ? (
        <div id="mobile-nav" className="absolute inset-x-0 top-full z-20 border-b bg-surface p-3 shadow-lg">
          <AppNav items={items} onNavigate={() => setOpen(false)} />
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
      className="rounded-md border px-2.5 py-2 text-sm hover:bg-surface-muted"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span aria-hidden>{dark ? "☀" : "☾"}</span>
      <span className="sr-only">{dark ? "Switch to light mode" : "Switch to dark mode"}</span>
    </button>
  );
}
