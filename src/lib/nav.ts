import { can, type Capability, type Role } from "@/lib/roles";

/**
 * The navigation map.
 *
 * Organised by the operator's day, not by the database. Every destination the
 * app has is still reachable, but the rail lists **areas of work** (at most
 * eleven rows, usually fewer) and the screens inside an area appear as tabs once
 * you are in it. The previous rail was a flat inventory of 22 tables under six
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
 */

/** Counts the rail can surface. Resolved once per request in the layout. */
export type NavCountKey =
  | "exceptions" | "batches" | "unpaidInvoices" | "overdueJobs"
  | "unpaidBills" | "awaitingInvoice" | "openDrafts";

/**
 * The rail's icon, named rather than imported.
 *
 * Keeping it a string leaves this module pure data — it is imported by server
 * components and by the unit tests, neither of which should pull in an icon
 * library. `app-nav.tsx` maps the name to the component. Keyed here rather than
 * off the href because `navigationFor()` rewrites an area's href per role.
 */
export type NavIcon =
  | "today" | "myRun" | "runs" | "stops" | "jobs" | "customers"
  | "invoices" | "linen" | "reports" | "settings" | "help" | "platform";

export type NavItem = {
  label: string;
  href: string;
  /** Omitted means "everyone who is signed in" — the home and help screens. */
  capability?: Capability;
  count?: NavCountKey;
  /** Rail icon. Top-level areas only; the tab strip is text. */
  icon?: NavIcon;
  /** One plain sentence, shown under the tab strip and on the help page. */
  blurb?: string;
  /** Screens inside this area. Rendered as tabs, never as a nested menu. */
  children?: NavItem[];
};

export const NAVIGATION: NavItem[] = [
  {
    // No capability: every role lands here after signing in, and the page
    // already shows each of them only the panels their role may see. A driver
    // holds no `reports.read`, which is why this row used to be missing for the
    // one person guaranteed to be sent to it.
    label: "Today",
    href: "/dashboard",
    icon: "today",
    blurb: "What needs a decision right now.",
  },
  {
    // Was a single row pointing at `/run`: today's run, no date, one run only.
    // It is now the area, with `/run` kept inside it rather than replaced —
    // that screen owns the offline outbox and the service worker, and it is the
    // one part of the app that has to work in a car park with no signal.
    //
    // Gated on `routes.read` rather than `run.execute`, because the area is not
    // only the driver's: a manager opens it to see what they have given
    // someone. `/run` keeps `run.execute`, so a manager sees the area with one
    // tab and a driver sees it with two.
    label: "My Runs",
    href: "/my-runs",
    icon: "myRun",
    capability: "routes.read",
    blurb: "The deliveries assigned to you, for any day you choose.",
    children: [
      {
        label: "My Runs", href: "/my-runs", capability: "routes.read",
        blurb: "The jobs assigned to you for a day: confirm the load, start the route, deliver.",
      },
      {
        label: "At the depot", href: "/run", capability: "run.execute",
        blurb: "Record a collection or delivery where you are standing. Works without signal.",
      },
    ],
  },
  {
    /**
     * Runs — a day, a board, and the order it drives in.
     *
     * **Not the run-management area the 2026-08-14 simplification removed.**
     * Nobody creates a run here, opens one, or reads a run code: a job is still
     * given straight to a board and a date, and the `daily_routes` row
     * underneath is still found-or-created by the action. `/routes/daily`,
     * `/routes/planner` and `/routes/templates` remain unlinked, and
     * `nav.test.ts` still asserts that no rail href starts with `/routes/`.
     *
     * What this row is for is the one decision the office was left unable to
     * make — *in what order does the board drive?* — plus moving work between
     * boards. Gated on `routes.read` so a board can see the sequence it will
     * drive; changing it needs `routes.sequence` (0036), which a board, a
     * driver and — deliberately — a dispatcher all lack. Moving work between
     * boards is the separate, wider `routes.write`.
     */
    label: "Runs",
    href: "/runs",
    icon: "runs",
    capability: "routes.read",
    blurb: "A board's day, in the order it drives.",
  },
  {
    // Drivers and Vehicles were children of the old Runs area and are
    // emphatically not run management, so they keep their place under their own
    // heading. Boards leads it, because a board is what work is assigned to.
    label: "Fleet",
    href: "/boards",
    icon: "runs",
    capability: "fleet.read",
    blurb: "The people who drive, and what they drive.",
    children: [
      {
        // First, because a board is what work is assigned to. Drivers sit beside
        // it as the record of which *person* did the work.
        label: "Boards", href: "/boards", capability: "fleet.read",
        blurb: "The delivery rounds. Jobs are assigned to a board, not to a person.",
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
    label: "Driver visits",
    href: "/jobs",
    icon: "stops",
    capability: "routes.read",
    count: "exceptions",
    blurb: "Every time a driver called on a customer: what was collected, what was dropped off.",
    children: [
      {
        label: "All visits", href: "/jobs", capability: "routes.read",
        blurb: "Every visit, filtered by day, delivery round or customer.",
      },
      {
        label: "Problems", href: "/operations/exceptions", capability: "operations.read",
        count: "exceptions",
        blurb: "Stops a driver could not finish. Clearing one puts it back in the queue.",
      },
      {
        label: "Collections", href: "/operations/pickups", capability: "operations.read",
        blurb: "Linen picked up, with anything damaged or short.",
      },
      {
        label: "Deliveries", href: "/operations/deliveries", capability: "operations.read",
        blurb: "Clean linen handed over, with the signature taken at the door.",
      },
    ],
  },
  {
    // The counter's work, and deliberately a separate row from "Stops": a stop
    // is a visit on a driver's run, a job is a customer's laundry from the
    // moment it lands on the counter to the moment it goes back. They meet only
    // when a job is collected or delivered by a driver. `/orders` rather than
    // `/jobs` because the routing module took that path in 0004 — the same
    // label-is-not-the-route arrangement as Contracts (`/agreements`) and Linen
    // (`/inventory`), and /help defines both words.
    label: "Customer laundry",
    href: "/orders",
    icon: "jobs",
    capability: "orders.read",
    count: "overdueJobs",
    blurb: "Laundry taken in at the counter, from drop-off to delivery or collection.",
  },
  {
    label: "Customers",
    href: "/customers",
    icon: "customers",
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
    // Renamed from "Invoices" when the payable side landed: the row now covers
    // money in *and* money out, and an area named after one of its six tabs
    // would read as the odd one out.
    //
    // An operational role reaches none of it. That is enforced twice: no
    // operational role holds `invoices.*`, `billing.*` or `purchases.*`, and
    // the RLS policies on every billing table say the same thing independently
    // through `can_read_billing()` (0017).
    label: "Money",
    href: "/invoices",
    icon: "invoices",
    capability: "invoices.read",
    count: "unpaidInvoices",
    blurb: "What customers owe you, what you owe your suppliers.",
    children: [
      {
        label: "Invoices", href: "/invoices", capability: "invoices.read",
        count: "unpaidInvoices",
        blurb: "Every invoice, and the one you are working on beside it.",
      },
      {
        // The month-end screen: a period, a customer, one invoice for everything
        // they had done in it. Distinct from the queue below, which asks the
        // other question — *what needs pricing?* — over no period at all.
        label: "Billing", href: "/billing", capability: "billing.read",
        blurb: "Bill a customer for a week or a month in one invoice.",
      },
      {
        // A queue of *jobs*, living under Money rather than under Jobs because
        // the question it answers is a billing one. `sectionFor` takes the
        // longest match, so `/invoices/awaiting` lands here rather than on the
        // register.
        label: "Awaiting invoice", href: "/invoices/awaiting", capability: "billing.read",
        count: "awaitingInvoice",
        blurb: "Finished work that has not been billed. Approve the charges, then generate.",
      },
      {
        // The invoices still collecting: one per customer per billing period,
        // gaining each job as it is approved. A tab of its own rather than a
        // filter on the register, because "what is ready to go out?" is the
        // month-end question and the register answers a different one — a list
        // of every invoice, in every state, ever raised.
        label: "Open drafts", href: "/invoices/drafts", capability: "invoices.read",
        count: "openDrafts",
        blurb: "Invoices still collecting this period\u2019s approved jobs. Issue one when you are ready.",
      },
      {
        // The price list belongs to billing, not to Settings: it is what the
        // monthly run charges for the laundry taken in at the counter, and it
        // is gated on the same capability as the invoices it produces.
        label: "Laundry prices", href: "/invoices/prices", capability: "invoices.read",
        blurb: "What each kind of laundry costs, before a customer's own price.",
      },
      {
        // Sits with the register rather than under Settings: which invoices
        // reach the books is a billing decision, and it is gated on the same
        // capability as the invoices it sends.
        label: "Xero", href: "/invoices/xero", capability: "invoices.write",
        blurb: "Connect this laundry's Xero, and see whether invoices are reaching it.",
      },
      {
        label: "Bills", href: "/bills", capability: "purchases.read",
        count: "unpaidBills",
        blurb: "What your suppliers have invoiced you, and what is still owed.",
      },
      {
        label: "Suppliers", href: "/suppliers", capability: "purchases.read",
        blurb: "Businesses you buy from, and what you owe each of them.",
      },
      {
        label: "Accounts", href: "/accounts", capability: "purchases.read",
        blurb: "The chart of accounts every invoice and bill is coded against.",
      },
    ],
  },
  {
    label: "Linen",
    href: "/inventory",
    icon: "linen",
    capability: "inventory.read",
    count: "batches",
    blurb: "Where your stock is right now, and what the plant is working on.",
    children: [
      {
        label: "Stock", href: "/inventory", capability: "inventory.read",
        blurb: "How much of each item is where, and every movement behind it.",
      },
      {
        label: "In the plant", href: "/warehouse", capability: "warehouse.read",
        count: "batches",
        blurb: "Loads moving through washing, drying, folding and packing.",
      },
      {
        // **"Items", not "Item types".** That label dates from when this screen
        // held nine kinds of laundry; it now holds the business's own master
        // list — 254 rows for Adelaide, under the codes staff type — and every
        // job, price tier, charge, invoice line and report resolves through it.
        // "Item types" reads as a small set of categories, which is exactly the
        // thing an owner would not go looking in for `TW`.
        label: "Items", href: "/items", capability: "items.read",
        blurb: "Your master item list, under the codes your books use.",
      },
    ],
  },
  {
    label: "Reports",
    href: "/reports",
    icon: "reports",
    capability: "reports.read",
    blurb: "How the business did over a period you choose.",
  },
  {
    label: "Settings",
    href: "/admin/depots",
    icon: "settings",
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
        // Write, not read: the page is an upload form and nothing else, so a
        // read-only role would get a screen it cannot submit.
        label: "Bring in your books", href: "/admin/import", capability: "admin.write",
        blurb: "Upload the reports from your old accounting system and load them in.",
      },
      {
        label: "Public holidays", href: "/admin/holidays", capability: "admin.read",
        blurb: "Days you do not serve. Contracts decide what happens on each one.",
      },
      {
        label: "Activity log", href: "/admin/audit", capability: "admin.read",
        blurb: "Every change anyone has made, kept permanently.",
      },
      {
        // Write, not read, for the same reason as Notifications: the screen is
        // two buttons and a count, and a read-only role would get a page it
        // cannot act on.
        label: "Your records", href: "/admin/data", capability: "admin.write",
        blurb: "Hide your customers, jobs and invoices while you show the app around.",
      },
    ],
  },
  {
    // No capability, deliberately: no role should be unable to look up what a
    // word means.
    label: "Help",
    href: "/help",
    icon: "help",
    blurb: "What the words mean, and how a normal day runs.",
  },
  {
    // Last on purpose, and invisible to all eleven membership roles: `platform.read`
    // is held by `platform_admin` alone (0019). This is the deployment, not a
    // laundry — an owner opening their own Settings should never see a row that
    // implies there are other businesses on the other side of it.
    label: "Platform",
    href: "/platform",
    icon: "platform",
    capability: "platform.read",
    blurb: "The laundries on this system, and the system itself.",
    children: [
      {
        label: "Laundries", href: "/platform", capability: "platform.read",
        blurb: "Every business on this deployment. Add one, rename one, suspend one.",
      },
      {
        label: "Administrators", href: "/platform/admins", capability: "platform.write",
        blurb: "Who else can reach every laundry on this system.",
      },
      {
        label: "Settings", href: "/platform/settings", capability: "platform.write",
        blurb: "Defaults a new laundry starts with.",
      },
      {
        label: "Release", href: "/platform/release", capability: "platform.read",
        blurb: "What schema this deployment is on, and what shipped.",
      },
    ],
  },
];

/** Every destination inside an item, itself first. */
function destinations(item: NavItem): NavItem[] {
  return [item, ...(item.children ?? [])];
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

/**
 * The rail for a role: areas they can reach, each with the tabs they can open.
 * An area whose own screen is out of reach keeps its label and borrows the first
 * child's href, so "Runs" still reads as Runs for a driverless dispatcher.
 */
export function navigationFor(role: Role): NavItem[] {
  return NAVIGATION
    .filter((item) => reachable(role, item))
    .map((item) => ({
      ...item,
      ...resolve(role, item),
      children: item.children?.filter((child) => allowed(role, child)),
    }));
}

/* ------------------------------------------------------- rail grouping --- */

/**
 * The rail, in three collapsible groups.
 *
 * **This softens a decision §6 records, and it is worth saying so rather than
 * doing it quietly.** The rail was deliberately "one flat list of areas — no
 * headings, no nesting", because what it replaced was a 22-row inventory of
 * database tables under headings named after internal concepts. That objection
 * still stands, and nothing here brings it back: the *screens* inside an area
 * are still tabs, never rail rows, so the rail never becomes a table of
 * contents for the schema.
 *
 * What changed is the count. The flat list was eleven rows when that decision
 * was made; Runs came back on 2026-08-20 and Platform before it, so an owner
 * now opens a column of thirteen with no shape to it — which is what the owner
 * asked to be tidied on 2026-08-24. Three headings in the operator's own words
 * turn thirteen rows into a short list plus two closed drawers, and every
 * destination is still exactly one click from where it was.
 *
 * A group is keyed on the area hrefs it holds rather than on a flag per item,
 * for the reason §19 gives about the rejected simple mode: a second list of
 * "which rows are advanced" hanging off each nav entry is a thing to keep in
 * step, and it drifts. This is one list in one place, and `nav.test.ts` asserts
 * every area lands in exactly one group.
 */
export type NavGroup = { label: string; items: NavItem[] };

const GROUPS: Array<{ label: string; hrefs: string[]; openByDefault: boolean }> = [
  {
    // The work of a day, for every role that has one. Open, because this is
    // what somebody signed in to do.
    label: "Day to day",
    hrefs: ["/dashboard", "/my-runs", "/runs", "/orders", "/jobs"],
    openByDefault: true,
  },
  {
    label: "Customers & money",
    hrefs: ["/customers", "/invoices"],
    openByDefault: false,
  },
  {
    // Things you set up once and come back to occasionally.
    label: "Set-up & reports",
    hrefs: ["/boards", "/inventory", "/reports", "/admin/depots", "/platform"],
    openByDefault: false,
  },
];

/**
 * Help sits outside the groups, pinned last.
 *
 * It is the one row somebody reaches for precisely when they are lost, and
 * putting it inside a drawer that might be shut is the exact moment it stops
 * working. It carries no capability either, so it is the only row guaranteed to
 * be there for all twelve roles.
 */
const UNGROUPED = ["/help"];

export const NAV_GROUP_LABELS = GROUPS.map((group) => group.label);

export function groupIsOpenByDefault(label: string): boolean {
  return GROUPS.find((group) => group.label === label)?.openByDefault ?? true;
}

/**
 * Arrange a role's areas into groups for the rail.
 *
 * Takes the output of `navigationFor()` rather than replacing it: every other
 * caller — `sectionFor`, the tab strip, the tests — still sees one flat list,
 * so this adds a way to *draw* the rail without changing what the rail is.
 *
 * An area a role cannot see is already absent, so a group can come back empty;
 * an empty group renders no heading at all. Anything not named in a group falls
 * through to `rest`, which means a rail row added tomorrow shows up rather than
 * silently disappearing — the failure mode that matters.
 */
export function groupNavigation(items: NavItem[]): { groups: NavGroup[]; rest: NavItem[] } {
  const byHref = new Map(items.map((item) => [item.href, item]));
  const claimed = new Set<string>();

  const groups = GROUPS.map((group) => {
    const found = group.hrefs
      .map((href) => byHref.get(href))
      .filter((item): item is NavItem => item !== undefined);
    found.forEach((item) => claimed.add(item.href));
    return { label: group.label, items: found };
  }).filter((group) => group.items.length > 0);

  // `UNGROUPED` first so Help keeps its place at the foot of the rail, then
  // anything a future release adds without touching this file.
  const rest = [
    ...items.filter((item) => UNGROUPED.includes(item.href)),
    ...items.filter((item) => !claimed.has(item.href) && !UNGROUPED.includes(item.href)),
  ];

  return { groups, rest };
}

export function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The area a path belongs to. Longest match wins, so `/routes/templates` lands
 * on Weekly runs rather than on Runs' own `/routes/daily`, and a detail route
 * like `/customers/abc/edit` still resolves to Customers.
 */
export function sectionFor(pathname: string, items: NavItem[]): NavItem | undefined {
  let best: NavItem | undefined;
  let bestLength = -1;

  for (const item of items) {
    for (const entry of destinations(item)) {
      if (isActive(pathname, entry.href) && entry.href.length > bestLength) {
        best = item;
        bestLength = entry.href.length;
      }
    }
  }
  return best;
}
