import { can, type Capability, type Role } from "@/lib/roles";

/**
 * Navigation map from spec §13, filtered per role at render time.
 *
 * Grouped into sections to match the design pack's sidebar: a mono uppercase
 * heading over a flat list, rather than the expand-on-active tree this used to
 * be. Nothing is nested now — every destination is one click, which is the
 * point of the pack's layout language. All hrefs are unchanged.
 */

/** Counts the sidebar can surface. Resolved once per request in the layout. */
export type NavCountKey = "routesToday" | "exceptions" | "batches" | "unpaidInvoices";

export type NavItem = {
  label: string;
  href: string;
  capability: Capability;
  count?: NavCountKey;
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

export const NAVIGATION: NavSection[] = [
  {
    label: "Today",
    items: [
      { label: "Dashboard", href: "/dashboard", capability: "reports.read" },
      { label: "Today's runs", href: "/routes/daily", capability: "routes.read", count: "routesToday" },
      // Planning is a write action, so the entry only appears for roles that can
      // actually commit a plan rather than dangling a board they cannot apply.
      { label: "Plan the day", href: "/routes/planner", capability: "routes.write" },
      { label: "Stops", href: "/jobs", capability: "routes.read" },
      { label: "My run", href: "/run", capability: "run.execute" },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Pickups", href: "/operations/pickups", capability: "operations.read" },
      { label: "Deliveries", href: "/operations/deliveries", capability: "operations.read" },
      { label: "Problems", href: "/operations/exceptions", capability: "operations.read", count: "exceptions" },
    ],
  },
  {
    label: "Plant",
    items: [
      { label: "Warehouse", href: "/warehouse", capability: "warehouse.read", count: "batches" },
      { label: "Inventory", href: "/inventory", capability: "inventory.read" },
    ],
  },
  {
    label: "Accounts",
    items: [
      { label: "Customers", href: "/customers", capability: "customers.read" },
      { label: "Contracts", href: "/agreements", capability: "agreements.read" },
      { label: "Items", href: "/items", capability: "items.read" },
      { label: "Invoices", href: "/invoices", capability: "invoices.read", count: "unpaidInvoices" },
      { label: "Reports", href: "/reports", capability: "reports.read" },
    ],
  },
  {
    label: "Fleet",
    items: [
      { label: "Drivers", href: "/drivers", capability: "fleet.read" },
      { label: "Vehicles", href: "/vehicles", capability: "fleet.read" },
      { label: "Weekly runs", href: "/routes/templates", capability: "routes.read" },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Sites", href: "/admin/depots", capability: "admin.read" },
      { label: "People", href: "/admin/users", capability: "admin.read" },
      // Gated on write, not read: the page is a form and nothing else, so a
      // read-only role would get a screen it cannot submit.
      { label: "Notifications", href: "/admin/notifications", capability: "admin.write" },
      { label: "Public holidays", href: "/admin/holidays", capability: "admin.read" },
      { label: "Audit log", href: "/admin/audit", capability: "admin.read" },
    ],
  },
];

/** Sections the role can reach at all are kept; empty ones disappear entirely. */
export function navigationFor(role: Role): NavSection[] {
  return NAVIGATION
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => can(role, item.capability)),
    }))
    .filter((section) => section.items.length > 0);
}

export function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
