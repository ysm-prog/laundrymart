import { can, type Capability, type Role } from "@/lib/roles";

export type NavCountKey = "exceptions" | "batches" | "unpaidInvoices" | "overdueJobs" | "awaitingInvoices";
export type NavIcon = "today" | "myRun" | "runs" | "stops" | "jobs" | "customers" | "invoices" | "linen" | "reports" | "settings" | "help";
export type NavItem = { label: string; href: string; capability?: Capability; count?: NavCountKey; icon?: NavIcon; blurb?: string; children?: NavItem[] };

export const NAVIGATION: NavItem[] = [
  { label: "Today", href: "/dashboard", icon: "today", blurb: "What needs a decision right now." },
  {
    label: "My Runs", href: "/my-runs", icon: "myRun", capability: "routes.read",
    blurb: "The deliveries assigned to you, for any day you choose.",
    children: [
      { label: "My Runs", href: "/my-runs", capability: "routes.read", blurb: "The jobs assigned to you for a day: confirm the load, start the route, deliver." },
      { label: "At the depot", href: "/run", capability: "run.execute", blurb: "Record a collection or delivery where you are standing. Works without signal." },
    ],
  },
  {
    label: "Fleet", href: "/drivers", icon: "runs", capability: "fleet.read", blurb: "The people who drive, and what they drive.",
    children: [
      { label: "Drivers", href: "/drivers", capability: "fleet.read", blurb: "The people who drive, and the login each one uses." },
      { label: "Vehicles", href: "/vehicles", capability: "fleet.read", blurb: "Your trucks and trailers, and which are off the road." },
    ],
  },
  {
    label: "Stops", href: "/jobs", icon: "stops", capability: "routes.read", count: "exceptions", blurb: "Every visit to a customer: what was collected, what was dropped off.",
    children: [
      { label: "All stops", href: "/jobs", capability: "routes.read", blurb: "Every stop, filtered by day, run or customer." },
      { label: "Problems", href: "/operations/exceptions", capability: "operations.read", count: "exceptions", blurb: "Stops a driver could not finish. Clearing one puts it back in the queue." },
      { label: "Collections", href: "/operations/pickups", capability: "operations.read", blurb: "Linen picked up, with anything damaged or short." },
      { label: "Deliveries", href: "/operations/deliveries", capability: "operations.read", blurb: "Clean linen handed over, with the signature taken at the door." },
    ],
  },
  { label: "Jobs", href: "/orders", icon: "jobs", capability: "orders.read", count: "overdueJobs", blurb: "Laundry taken in at the counter, from drop-off to delivery or collection." },
  {
    label: "Customers", href: "/customers", icon: "customers", capability: "customers.read", blurb: "Who you collect from, and what you have agreed to do for them.",
    children: [
      { label: "Customers", href: "/customers", capability: "customers.read", blurb: "Businesses you serve, their sites and their contacts." },
      { label: "Contracts", href: "/agreements", capability: "agreements.read", blurb: "Which days you serve a customer, and what you charge them." },
    ],
  },
  {
    label: "Invoices", href: "/invoices", icon: "invoices", capability: "invoices.read", count: "unpaidInvoices", blurb: "Bill the work, chase what is unpaid, record what comes in.",
    children: [
      { label: "Invoice Register", href: "/invoices", capability: "invoices.read", blurb: "Generated invoices, payments and receivables." },
      { label: "Awaiting Invoice", href: "/awaiting-invoice", capability: "invoices.read", count: "awaitingInvoices", blurb: "Completed jobs waiting for financial review and invoice generation." },
    ],
  },
  {
    label: "Linen", href: "/inventory", icon: "linen", capability: "inventory.read", count: "batches", blurb: "Where your stock is right now, and what the plant is working on.",
    children: [
      { label: "Stock", href: "/inventory", capability: "inventory.read", blurb: "How much of each item is where, and every movement behind it." },
      { label: "In the plant", href: "/warehouse", capability: "warehouse.read", count: "batches", blurb: "Loads moving through washing, drying, folding and packing." },
      { label: "Item types", href: "/items", capability: "items.read", blurb: "The linen you handle — sheets, towels, mats — and its default price." },
    ],
  },
  { label: "Reports", href: "/reports", icon: "reports", capability: "reports.read", blurb: "How the business did over a period you choose." },
  {
    label: "Settings", href: "/admin/depots", icon: "settings", capability: "admin.read", blurb: "Sites, people, holidays and activity history.",
    children: [
      { label: "Sites", href: "/admin/depots", capability: "admin.read" },
      { label: "People", href: "/admin/users", capability: "admin.read" },
      { label: "Public holidays", href: "/admin/holidays", capability: "admin.read" },
      { label: "Activity log", href: "/admin/audit", capability: "admin.read" },
    ],
  },
  { label: "Help", href: "/help", icon: "help", blurb: "The words used in the system, explained." },
];

function accessible(item: NavItem, role: Role): boolean {
  return !item.capability || can(role, item.capability);
}

function firstAccessible(item: NavItem, role: Role): NavItem | null {
  if (accessible(item, role)) return item;
  if (!item.children) return null;
  return item.children.find((child) => accessible(child, role)) ?? null;
}

export function navigationFor(role: Role): NavItem[] {
  return NAVIGATION.map((item) => {
    const first = firstAccessible(item, role);
    if (!first) return null;
    return { ...item, href: first.href, capability: first.capability };
  }).filter((item): item is NavItem => item !== null);
}

export function sectionFor(pathname: string): NavItem | null {
  let match: NavItem | null = null;
  function walk(item: NavItem) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) match = item;
    for (const child of item.children ?? []) walk(child);
  }
  for (const item of NAVIGATION) walk(item);
  return match;
}
