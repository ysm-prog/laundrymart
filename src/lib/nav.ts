import { can, type Capability, type Role } from "@/lib/roles";

/**
 * The navigation map.
 *
 * Organised by the operator's day, not by the database. Every destination the
 * app has is still reachable, but the rail lists **five areas of work** —
 * Today, Laundry, Deliveries, Customers, Billing (brief 3.1) — and the screens
 * inside an area appear as tabs once you are in it. The areas somebody sets up
 * once and comes back to (Fleet, Linen, Reports, Settings, Help, Platform) are
 * `placement: "profile"` and live in the account menu instead. The previous rail was a flat inventory of 22 tables under six
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
  /**
   * Where the area is drawn. Omitted is the rail; `"profile"` is the account
   * menu in the header. Either way the area is in `navigationFor()`, so
   * `sectionFor` and the tab strip treat it exactly as before.
   */
  placement?: "profile";
  /**
   * A screen that only exists while a tenant setting says so. `"plant"` is the
   * production-batch screens, off until the laundry records batches (brief
   * 3.9, `parseOperations`). Filtered by `navigationFor`'s options, so a
   * hidden screen is absent from the tab strip and the help page alike.
   */
  feature?: "plant";
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
    // The counter's work, and deliberately a separate area from Deliveries: a
    // visit is a stop on a round, a job is a customer's laundry from the
    // moment it lands on the counter to the moment it goes back. `/orders`
    // rather than `/jobs` because the routing module took that path in 0004 —
    // the same label-is-not-the-route arrangement as Contracts (`/agreements`)
    // and Linen (`/inventory`), and /help defines both words.
    //
    // **Opens on the board** (brief 3.3), not the list: five columns read as
    // where the work is, and the list stays one tab across for searching.
    label: "Laundry",
    href: "/orders/board",
    icon: "jobs",
    capability: "orders.read",
    count: "overdueJobs",
    blurb: "Laundry taken in at the counter, from drop-off to delivery or collection.",
    children: [
      {
        label: "Board", href: "/orders/board", capability: "orders.read",
        blurb: "Every job in a column: in the plant, ready, out, delivered, billed.",
      },
      {
        label: "All jobs", href: "/orders", capability: "orders.read",
        count: "overdueJobs",
        blurb: "Search and filter every job, by customer, status or date.",
      },
    ],
  },
  {
    /**
     * Deliveries — the round's day and the office's view of it, in one area
     * (Darshan's review, brief 3.1).
     *
     * What were two rail rows, My Runs and Runs, are tabs of one area here:
     * a board opens it on its own day, the office opens it on the same screen
     * and moves across to Run order, and the four visit screens that left the
     * rail in Phase 2 ride along at the end. Every href is unchanged, so no
     * bookmark breaks and `/routes/*` is still off the map — `nav.test.ts`
     * still asserts that.
     *
     * Gated on `routes.read`: the round, the driver, the counter and the
     * office all hold it. `/run` keeps `run.execute`, so the depot screen is a
     * tab for the people who drive and not for the people who plan.
     */
    label: "Deliveries",
    href: "/my-runs",
    icon: "myRun",
    capability: "routes.read",
    count: "exceptions",
    blurb: "Who is delivering what today, in the order they drive.",
    children: [
      {
        label: "My Runs", href: "/my-runs", capability: "routes.read",
        blurb: "The jobs assigned to a round for a day: start the day, then deliver at each door.",
      },
      {
        label: "At the depot", href: "/run", capability: "run.execute",
        blurb: "Record a collection or delivery where you are standing. Works without signal.",
      },
      {
        label: "Run order", href: "/runs", capability: "routes.read",
        blurb: "What each board is delivering on a day, and the order it drives in.",
      },
      {
        // The standing weekly collection, for one day. Gated on `routes.write`
        // rather than `routes.read`, because the screen's whole purpose is the
        // button: a board reading its own day cannot put work on a round, so
        // offering it the tab would be offering a screen it can only look at.
        // The area still opens on Run order for them, which is `navigationFor`
        // resolving an area to the first screen the role can actually open.
        label: "Due for collection", href: "/runs/collections", capability: "routes.write",
        blurb: "Customers collected on this weekday, and whether they are on a round yet.",
      },
      // The four tabs that were the "Driver visits" rail row until Phase 2 of
      // Darshan's review (brief 2.1). A visit is the internal stop record a
      // laundry job is delivered through, and since 0056 it finishes itself when
      // the job does — so it stopped being a separate place anybody has to go.
      // The screens survive as tabs here, under the area they are about, so a
      // problem stop, the collections list and its Take in press are still one
      // click away.
      {
        label: "Driver visits", href: "/jobs", capability: "routes.read",
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
        label: "Delivery records", href: "/operations/deliveries", capability: "operations.read",
        blurb: "Clean linen handed over, with the signature taken at the door.",
      },
    ],
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
    // "Billing" since brief 3.1, "Money" before that and "Invoices" before
    // the payable side landed. The area covers money in *and* money out; the
    // period screen that used to be its "Billing" tab is "By period" now, so
    // the area and one of its tabs do not share a name.
    //
    // An operational role reaches none of it. That is enforced twice: no
    // operational role holds `invoices.*`, `billing.*` or `purchases.*`, and
    // the RLS policies on every billing table say the same thing independently
    // through `can_read_billing()` (0017).
    label: "Billing",
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
        label: "By period", href: "/billing", capability: "billing.read",
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
      {
        // Beside Accounts, and deliberately **last**: it is configuration for
        // the chart rather than a screen anybody opens Money to reach. Placing
        // it before Bills made it finance's landing screen for the whole area,
        // because `navigationFor` resolves a row to the first child that role
        // can open — caught by `nav.test.ts` rather than by a person.
        //
        // Under Money and not Settings for the reason the laundry price list
        // is: it decides what an invoice says. Gated on `purchases.read`, like
        // the chart of accounts every value in it points at.
        label: "Charge accounts", href: "/invoices/charge-accounts",
        capability: "purchases.read",
        blurb: "Where a fuel levy, a delivery or a minimum lands in your books.",
      },
    ],
  },
  {
    // Drivers and Vehicles were children of the old Runs area and are
    // emphatically not run management, so they keep their place under their own
    // heading. Boards leads it, because a board is what work is assigned to.
    placement: "profile",
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
    placement: "profile",
    label: "Linen",
    href: "/inventory",
    icon: "linen",
    capability: "inventory.read",
    blurb: "Where your stock is right now, and what the plant is working on.",
    children: [
      {
        label: "Stock", href: "/inventory", capability: "inventory.read",
        blurb: "How much of each item is where, and every movement behind it.",
      },
      {
        label: "In the plant", href: "/warehouse", capability: "warehouse.read",
        count: "batches", feature: "plant",
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
    placement: "profile",
    label: "Reports",
    href: "/reports",
    icon: "reports",
    capability: "reports.read",
    blurb: "How the business did over a period you choose.",
  },
  {
    placement: "profile",
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
        // Write, not read: a form and nothing else, and the Owner's alone.
        label: "Invoicing", href: "/admin/invoicing", capability: "admin.write",
        blurb: "Your ABN, address and bank details on every invoice.",
      },
      {
        // Write, not read: a form and nothing else, and the Owner's alone.
        label: "How you work", href: "/admin/operations", capability: "admin.write",
        blurb: "When laundry is promised back, and whether the plant screens are shown.",
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
    placement: "profile",
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
    placement: "profile",
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
export function navigationFor(
  role: Role,
  /** Tenant switches. Omitted means every feature-gated screen is hidden. */
  options: { plantStages?: boolean } = {},
): NavItem[] {
  const shown = (entry: NavItem) => entry.feature !== "plant" || options.plantStages === true;
  return NAVIGATION
    .map((item) => ({ ...item, children: item.children?.filter(shown) }))
    .filter((item) => shown(item) && reachable(role, item))
    .map((item) => ({
      ...item,
      ...resolve(role, item),
      children: item.children?.filter((child) => allowed(role, child)),
    }));
}

/* ------------------------------------------------- rail and profile menu --- */

/**
 * Split a role's areas into the rail and the account menu (brief 3.1).
 *
 * The rail is the five areas of a working day; everything set up once and
 * visited occasionally sits behind the account menu. This replaced the three
 * collapsible rail groups of 2026-08-24 — with five rows there is nothing left
 * to collapse, and a drawer that might be shut is one more thing to look in.
 *
 * Takes the output of `navigationFor()` rather than replacing it: `sectionFor`,
 * the tab strip and the help page still see one flat list. An area with no
 * placement is drawn on the rail, so a row added tomorrow shows up rather than
 * silently disappearing — the failure mode that matters.
 */
export function railNavigation(items: NavItem[]): { main: NavItem[]; profile: NavItem[] } {
  return {
    main: items.filter((item) => item.placement !== "profile"),
    profile: items.filter((item) => item.placement === "profile"),
  };
}

/**
 * The tab inside an area that the current path belongs to. Longest match
 * wins, so on `/orders/board` the Board tab is lit and All jobs (`/orders`) is
 * not — `isActive` alone would light both, since one is a prefix of the other.
 */
export function activeTab(pathname: string, tabs: NavItem[]): NavItem | undefined {
  let best: NavItem | undefined;
  for (const tab of tabs) {
    if (isActive(pathname, tab.href) && (!best || tab.href.length > best.href.length)) best = tab;
  }
  return best;
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
