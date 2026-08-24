"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore, type ComponentType } from "react";
import {
  ChartColumn, CircleQuestionMark, ClipboardList, LayoutDashboard, MapPin, Moon,
  Receipt, Route, Server, Settings, Shirt, Sun, Truck, Users,
} from "lucide-react";
import { cx } from "./ui";
import { isActive, sectionFor, type NavCountKey, type NavIcon, type NavItem } from "@/lib/nav";
import {
  DEFAULT_TEXT_SIZE, TEXT_SIZE_ATTRIBUTE, TEXT_SIZE_STORAGE_KEY, nextTextSize,
  parseTextSize, textSizeActionLabel, type TextSize,
} from "@/lib/display";

export type NavCounts = Partial<Record<NavCountKey, number>>;

/**
 * Icon per area, resolved from the name held in `nav.ts`.
 *
 * Icons are here to make a row recognisable at a glance, not to decorate it —
 * one set, one weight, one size, and every row has one so the column of labels
 * stays aligned.
 */
const NAV_ICONS: Record<NavIcon, ComponentType<{ className?: string }>> = {
  today: LayoutDashboard,
  myRun: Truck,
  runs: Route,
  stops: MapPin,
  jobs: ClipboardList,
  customers: Users,
  invoices: Receipt,
  linen: Shirt,
  reports: ChartColumn,
  settings: Settings,
  platform: Server,
  help: CircleQuestionMark,
};

/** The Electro Services mark, used in the rail, the drawer and the phone header. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span aria-hidden
          className={cx(
            "flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary",
            /* The monogram is the one place the shell spends mono, and it is
               where YSM Hub spends it too (`.side-shop .av`). A single letter
               in a teal tile is a mark, not prose — the objection that retired
               mono from labels does not apply to it. */
            "font-mono text-sm font-bold text-primary-foreground",
            className,
          )}>
      E
    </span>
  );
}

/**
 * The sidebar rail.
 *
 * One flat list of areas — no headings, no nesting, no expanding tree. The
 * screens inside an area are tabs (`SectionNav`) rather than rail rows, because
 * a rail that lists every screen in the product is a table of contents for the
 * database, not a way to get to work.
 *
 * The rail used to be a near-black console with literal hex colours. It is now
 * an ordinary light surface driven by the `--sidebar-*` tokens, so it reads as
 * part of the application rather than as a terminal bolted to the side of it.
 *
 * Counts sit right-aligned per item. A zero is not rendered at all — a badge
 * showing "0" is noise, and the point of the badge is to pull attention.
 */
export function AppNav({
  items, counts, onNavigate, collapsed = false,
}: {
  items: NavItem[];
  counts?: NavCounts;
  onNavigate?: () => void;
  /** Icon-only rail. The label becomes the tooltip and the accessible name. */
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const current = sectionFor(pathname, items);

  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {items.map((item) => {
        // The area owning the current path highlights, so a detail route still
        // says where you are — `isActive` alone would unlight the whole rail on
        // `/customers/abc`.
        const active = current ? current.href === item.href : isActive(pathname, item.href);
        const count = item.count ? counts?.[item.count] : undefined;
        const Icon = item.icon ? NAV_ICONS[item.icon] : undefined;

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            title={collapsed ? item.label : undefined}
            className={cx(
              "group relative flex min-h-11 items-center rounded-lg text-sm transition",
              collapsed ? "justify-center px-2" : "gap-3 px-3",
              active
                ? "bg-sidebar-active-bg font-semibold text-sidebar-active"
                : "font-medium text-sidebar-foreground hover:bg-sidebar-hover",
            )}
          >
            {Icon ? (
              <Icon className={cx(
                "size-[1.15rem] shrink-0",
                active ? "text-sidebar-active" : "text-sidebar-muted",
              )} />
            ) : null}
            {collapsed ? (
              <span className="sr-only">{item.label}</span>
            ) : (
              <span className="truncate">{item.label}</span>
            )}
            {count ? (
              <span className={cx(
                "tabular-nums",
                collapsed
                  ? "absolute right-1 top-1 min-w-4 rounded-full bg-primary px-1 text-center " +
                    "text-3xs font-semibold leading-4 text-primary-foreground"
                  : "ml-auto rounded-full px-2 py-0.5 text-2xs font-semibold " +
                    (active
                      ? "bg-primary text-primary-foreground"
                      : "bg-surface-sunken text-muted-foreground"),
              )}>
                {count}
                {collapsed ? <span className="sr-only"> needing attention</span> : null}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The screens inside the current area, as a tab strip under the header.
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
           className="flex gap-1 overflow-x-auto px-3 sm:px-5">
        {tabs.map((tab) => {
          const active = isActive(pathname, tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "-mb-px flex min-h-12 shrink-0 items-center border-b-2 px-3 text-sm transition",
                active
                  ? "border-b-primary font-semibold text-primary"
                  : "border-b-transparent font-medium text-muted-foreground hover:text-foreground",
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
      className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground
                 transition hover:bg-surface-muted hover:text-foreground"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="size-[1.15rem]" aria-hidden /> : <Moon className="size-[1.15rem]" aria-hidden />}
      <span className="sr-only">{dark ? "Switch to light mode" : "Switch to dark mode"}</span>
    </button>
  );
}

/* ------------------------------------------------------- reading comfort --- */

/**
 * Watches the root element's text-size attribute, the same way
 * `subscribeToTheme` watches its class — so both controls in the header stay
 * truthful if the value is changed from anywhere else (the guided home screen
 * carries the same preference in a fuller form).
 */
function subscribeToTextSize(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true, attributeFilter: [TEXT_SIZE_ATTRIBUTE],
  });
  return () => observer.disconnect();
}

function readTextSize(): TextSize {
  return parseTextSize(document.documentElement.getAttribute(TEXT_SIZE_ATTRIBUTE));
}

/** Apply and remember. Shared by this button and the picker on the home screen. */
export function applyTextSize(size: TextSize) {
  if (size === DEFAULT_TEXT_SIZE) {
    document.documentElement.removeAttribute(TEXT_SIZE_ATTRIBUTE);
  } else {
    document.documentElement.setAttribute(TEXT_SIZE_ATTRIBUTE, size);
  }
  try {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, size);
  } catch {
    // Private browsing with storage disabled — it still holds for this session.
  }
}

/**
 * Make the text bigger, from the header.
 *
 * A cycle rather than a menu, because it sits beside the theme toggle in a
 * header that has no room for a third popover, and because the effect is
 * visible the instant it is pressed — you do not need to read a list to find
 * out what a size looks like, you press again.
 *
 * The letters in the button are drawn at the size they select, so the control
 * shows what it does rather than describing it. `title` and the accessible name
 * still say it in words, and name the size it will move *to* — the same promise
 * `ThemeToggle` makes.
 */
export function TextSizeControl() {
  const size = useSyncExternalStore(
    subscribeToTextSize,
    readTextSize,
    () => DEFAULT_TEXT_SIZE, // Server render: the bootstrap script has not run yet.
  );
  const label = textSizeActionLabel(size);

  return (
    <button
      type="button"
      onClick={() => applyTextSize(nextTextSize(size))}
      className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground
                 transition hover:bg-surface-muted hover:text-foreground"
      title={label}
    >
      <span aria-hidden className="font-semibold leading-none">
        <span className="text-[0.8em]">A</span>
        <span className={cx(
          size === "normal" && "text-[1em]",
          size === "large" && "text-[1.2em]",
          size === "xlarge" && "text-[1.45em]",
        )}>A</span>
      </span>
      <span className="sr-only">{label}</span>
    </button>
  );
}
