import { can, type Capability, type Role } from "@/lib/roles";
import { DEFAULT_UI_MODE, type UiMode } from "@/lib/ui-mode";

/**
 * The navigation map.
 *
 * Organised by the operator's day, not by the database. Every destination the
 * app has is still reachable, but the rail lists **areas of work** (at most ten
 * rows, usually fewer) and the screens inside an area appear as tabs once you
 * are in it. The previous rail was a flat inventory of 22 tables under six
 * headings named after internal concepts (Plant, Fleet, Accounts) — a
 * first-timer had to know the data model to find anything.
 *
 * Two rules hold this together:
 *
 *  - **An area is visible if any screen inside it is.** Capabilities are per
 *    destination, so `hrefFor()` resolves an area's link to the first screen the
 *    role can actually open. A dispatcher has no `admin.read`, so "Runs" points
 *    them at today's runs; a driver never sees the area at all.
 *  - **One area owns a path.** `sectionFor()` walks the tree, so the tab strip
 *    and the highlighted rail row always agree, including on detail routes
 *    (`/customers/abc` is inside Customers).
 *
 * Labels are the operator's words; hrefs and schema names are unchanged.
 *
 * A third rule arrived with simple mode (roadmap D2): **`advanced` marks a
 * destination the smallest laundry does not need in its menu.** In simple mode
 * those rows are not rendered — but nothing about them changes. They keep their
 * capability, their guard and their URL, and every link the rest of the app
 * makes to them still works. See `lib/ui-mode.ts` for why hiding is all it does.
 */

/** Counts the rail can surface. Resolved once per request in the layout. */
export type NavCountKey = "routesToday" | "exceptions" | "batches" | "unpaidInvoices";

export type NavItem = {
  label: string;
  href: string;
  /** Omitted means "everyone who is signed in" — the home and help screens. */
  capability?: Capability;
  count?: NavCountKey;
  /** One plain sentence, shown under the tab strip and on the help page. */
  blurb?: string;
  /**
   * Kept out of the rail in simple mode. Not a permission: the screen still
   * exists, still checks the same capability, and is still linked to from
   * wherever the app already links to it.
   */
  advanced?: true;
  /** Screens inside this area. Rendered as tabs, never as a nested menu. */
  children?: NavItem[];
  /**
   * Resolved by `navigationFor` only: screens this person may open that simple
   * mode has taken out of the rail. Never rendered as tabs — `sectionFor` reads
   * it to answer "where am I" when the tenant lands on one anyway. Empty in
   * full mode.
   */
  hidden?: NavItem[];
};

export const NAVIGATION: NavItem[] = [
  {
    // No capability: every role lands here after signing in, and the page
    // already shows each of them only the panels their role may see. A driver
    // holds no `reports.read`, which is why this row used to be missing for the
    // one person guaranteed to be sent to it.
    label: "Today",
    href: "/dashboard",
    blurb: "What needs a decision right now.",
  },
  {
    label: "My run",
    href: "/run",
    capability: "run.execute",
    blurb: "Your stops for today. Works without signal.",
  },
  {
    label: "Runs",
    href: "/routes/daily",
    capability: "routes.read",
    count: "routesToday",
    blurb: "Who is driving where, today and every week.",
    children: [
      {
        label: "Today's runs", href: "/routes/daily", capability: "routes.read",
        blurb: "Every run for a chosen day, and how far along it is.",
      },
      {
        // Advanced: the board is for a day with choices in it. A small laundry
        // reaches the same outcome through "Plan my day" on the dashboard,
        // which only sends them here when something needs a human decision.
        label: "Plan the day", href: "/routes/planner", capability: "routes.write",
        advanced: true,
        blurb: "Drag stops between runs, then apply the whole day at once.",
      },
      {
        label: "Weekly runs", href: "/routes/templates", capability: "routes.read",
        blurb: "The repeating week each day's runs are built from.",
      },
      {
        label: "Drivers", href: "/drivers", capability: "fleet.read",
        blurb: "The people who drive, and the login each one uses.",
      },
      {
        label: "Vehicles", href: "/vehicles", capability: "fleet.read",
        blurb: "Your trucks and trailers, and which are off the road.",
      },
    ],
  },
  {
    label: "Stops",
    href: "/jobs",
    capability: "routes.read",
    count: "exceptions",
    blurb: "Every visit to a customer: what was collected, what was dropped off.",
    children: [
      {
        label: "All stops", href: "/jobs", capability: "routes.read",
        blurb: "Every stop, filtered by day, run or customer.",
      },
      {
        label: "Problems", href: "/operations/exceptions", capability: "operations.read",
        count: "exceptions",
        blurb: "Stops a driver could not finish. Clearing one puts it back in the queue.",
      },
      {
        // Advanced: both are one slice of the stops above them. The stop itself
        // shows what was collected and what was dropped off, so a small laundry
        // reads the story in one place rather than three.
        label: "Collections", href: "/operations/pickups", capability: "operations.read",
        advanced: true,
        blurb: "Linen picked up, with anything damaged or short.",
      },
      {
        label: "Deliveries", href: "/operations/deliveries", capability: "operations.read",
        advanced: true,
        blurb: "Clean linen handed over, with the signature taken at the door.",
      },
    ],
  },
  {
    label: "Customers",
    href: "/customers",
    capability: "customers.read",
    blurb: "Who you collect from, and what you have agreed to do for them.",
    children: [
      {
        label: "Customers", href: "/customers", capability: "customers.read",
        blurb: "Businesses you serve, their sites and their contacts.",
      },
      {
        label: "Contracts", href: "/agreements", capability: "agreements.read",
        blurb: "Which days you serve a customer, and what you charge them.",
      },
    ],
  },
  {
    label: "Invoices",
    href: "/invoices",
    capability: "invoices.read",
    count: "unpaidInvoices",
    blurb: "Bill the work, chase what is unpaid, record what comes in.",
  },
  {
    label: "Linen",
    href: "/inventory",
    capability: "inventory.read",
    count: "batches",
    blurb: "Where your stock is right now, and what the plant is working on.",
    children: [
      {
        label: "Stock", href: "/inventory", capability: "inventory.read",
        blurb: "How much of each item is where, and every movement behind it.",
      },
      {
        // Advanced: tracking a load through four named stages is a plant with
        // shifts. A laundry where the same person washes and folds knows where
        // the load is by looking at it.
        label: "In the plant", href: "/warehouse", capability: "warehouse.read",
        count: "batches", advanced: true,
        blurb: "Loads moving through washing, drying, folding and packing.",
      },
      {
        label: "Item types", href: "/items", capability: "items.read",
        blurb: "The linen you handle — sheets, towels, mats — and its default price.",
      },
    ],
  },
  {
    // Advanced: seven period reports answer questions a small operator asks
    // once a quarter, and the ones they ask daily are on the dashboard already.
    label: "Reports",
    href: "/reports",
    capability: "reports.read",
    advanced: true,
    blurb: "How the business did over a period you choose.",
  },
  {
    label: "Settings",
    href: "/admin/depots",
    capability: "admin.read",
    blurb: "Your sites, your people, and the record of who changed what.",
    children: [
      {
        label: "Sites", href: "/admin/depots", capability: "admin.read",
        blurb: "Each place you operate from. Runs, vehicles and stock belong to one.",
      },
      {
        label: "People", href: "/admin/users", capability: "admin.read",
        blurb: "Who can sign in, and how much of the app each person sees.",
      },
      {
        // Gated on write, not read: the page is a form and nothing else, so a
        // read-only role would get a screen it cannot submit.
        label: "Notifications", href: "/admin/notifications", capability: "admin.write",
        blurb: "What the app tells you about, and what it emails your customers.",
      },
      {
        // Gated on write for the same reason as Notifications, and never
        // advanced: it is the way back to the full menu, so simple mode must
        // not be the thing that hides it.
        label: "What you see", href: "/admin/display", capability: "admin.write",
        blurb: "Show the whole app, or just the screens a small laundry uses daily.",
      },
      {
        // Kept in simple mode: a laundry of any size has to say which days it
        // does not collect, and nothing else in the app offers that.
        label: "Public holidays", href: "/admin/holidays", capability: "admin.read",
        blurb: "Days you do not serve. Contracts decide what happens on each one.",
      },
      {
        label: "Activity log", href: "/admin/audit", capability: "admin.read",
        advanced: true,
        blurb: "Every change anyone has made, kept permanently.",
      },
    ],
  },
  {
    // No capability, deliberately: no role should be unable to look up what a
    // word means.
    label: "Help",
    href: "/help",
    blurb: "What the words mean, and how a normal day runs.",
  },
];

/** Every destination inside an item, itself first. */
function destinations(item: NavItem): NavItem[] {
  return [item, ...(item.children ?? [])];
}

/**
 * Everything simple mode leaves out of the rail, with the area each one sits in.
 *
 * Read by the settings screen so the list it shows is the list the code acts
 * on. A hand-written summary of what a mode hides is wrong the first time
 * someone marks one more screen `advanced` and does not think to update it.
 */
export function advancedDestinations(): Array<{ area: string; item: NavItem }> {
  return NAVIGATION.flatMap((area) =>
    destinations(area)
      .filter((entry) => entry.advanced)
      .map((item) => ({ area: area.label, item })),
  );
}

/** A destination with no capability is open to every signed-in member. */
function allowed(role: Role, item: NavItem): boolean {
  return item.capability === undefined || can(role, item.capability);
}

/** True when the role can open at least one screen in this area. */
function reachable(role: Role, item: NavItem): boolean {
  return destinations(item).some((entry) => allowed(role, entry));
}

/**
 * The area's link for this role: its own screen when they can open it, else the
 * first child they can. An area is never linked to a screen that would bounce
 * the user back to the dashboard with "you do not have access to that area".
 *
 * The capability travels with the href. Returning a borrowed href beside the
 * area's own capability would leave a row claiming to be gated on something it
 * is not — harmless today, and a trap for the next reader who filters on it.
 */
function resolve(role: Role, item: NavItem): Pick<NavItem, "href" | "capability"> {
  const entry = destinations(item).find((candidate) => allowed(role, candidate)) ?? item;
  return { href: entry.href, capability: entry.capability };
}

/** True in simple mode for a destination that mode leaves out of the rail. */
function hiddenByMode(mode: UiMode, item: NavItem): boolean {
  return mode === "simple" && item.advanced === true;
}

/**
 * The rail for a role: areas they can reach, each with the tabs they can open.
 * An area whose own screen is out of reach keeps its label and borrows the first
 * child's href, so "Runs" still reads as Runs for a driverless dispatcher.
 *
 * `mode` narrows it further for a tenant that has chosen simple mode. The two
 * filters are not the same kind of thing and compose in one direction only:
 * the role decides what a person *may* open, the mode decides what this tenant
 * puts in the menu.
 */
export function navigationFor(role: Role, mode: UiMode = DEFAULT_UI_MODE): NavItem[] {
  // The mode filter runs first, so an area left with nothing but advanced
  // screens disappears rather than resolving its link to one of them.
  const visible = NAVIGATION
    .filter((item) => !hiddenByMode(mode, item))
    .map((item) => ({
      ...item,
      children: item.children?.filter((child) => !hiddenByMode(mode, child)),
      // Both filters applied, in the order that matters: a screen is only
      // "hidden" if this person could otherwise have opened it. Anything the
      // role cannot open is absent for a different reason and stays absent.
      hidden: item.children?.filter(
        (child) => hiddenByMode(mode, child) && allowed(role, child),
      ),
    }));

  return visible
    .filter((item) => reachable(role, item))
    .map((item) => ({
      ...item,
      ...resolve(role, item),
      children: item.children?.filter((child) => allowed(role, child)),
    }));
}

export function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The deepest destination matching a path, and the area that owns it. */
function locate(
  pathname: string, items: NavItem[],
): { area: NavItem; entry: NavItem } | undefined {
  let best: { area: NavItem; entry: NavItem } | undefined;
  let bestLength = -1;

  for (const item of items) {
    for (const entry of destinations(item)) {
      if (isActive(pathname, entry.href) && entry.href.length > bestLength) {
        best = { area: item, entry };
        bestLength = entry.href.length;
      }
    }
  }
  return best;
}

/**
 * The area a path belongs to. Longest match wins, so `/routes/templates` lands
 * on Weekly runs rather than on Runs' own `/routes/daily`, and a detail route
 * like `/customers/abc/edit` still resolves to Customers.
 *
 * Simple mode hides screens from the rail without closing them, so a tenant can
 * land on one — from the dashboard, a bookmark, or an action's redirect. Rather
 * than leave that page with no rail row lit and no tabs, the area is resolved
 * from the full map and the screen you are actually on is added back as a tab.
 * The menu stays short until the moment being short would leave you lost.
 */
export function sectionFor(pathname: string, items: NavItem[]): NavItem | undefined {
  const direct = locate(pathname, items);
  if (direct) return direct.area;

  // Nothing in the rail matches. The screen may still be one this person may
  // open that the mode took out — `navigationFor` resolved that list already,
  // with the role applied, so a tab is never offered to a screen the auth gate
  // would bounce. Anything else off the map stays off it.
  let best: { area: NavItem; entry: NavItem } | undefined;
  let bestLength = -1;
  for (const area of items) {
    for (const entry of area.hidden ?? []) {
      if (isActive(pathname, entry.href) && entry.href.length > bestLength) {
        best = { area, entry };
        bestLength = entry.href.length;
      }
    }
  }
  if (!best) return undefined;
  return { ...best.area, children: [...(best.area.children ?? []), best.entry] };
}
