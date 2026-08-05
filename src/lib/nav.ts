import { can, type Capability, type Role } from "@/lib/roles";

export type NavItem = {
  label: string;
  href: string;
  capability: Capability;
  children?: NavItem[];
};

/** Navigation map from spec §13, filtered per role at render time. */
export const NAVIGATION: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", capability: "reports.read" },
  {
    label: "Customers", href: "/customers", capability: "customers.read",
    children: [
      { label: "All customers", href: "/customers", capability: "customers.read" },
      { label: "Service agreements", href: "/agreements", capability: "agreements.read" },
      { label: "Items", href: "/items", capability: "items.read" },
    ],
  },
  {
    label: "Fleet", href: "/drivers", capability: "fleet.read",
    children: [
      { label: "Drivers", href: "/drivers", capability: "fleet.read" },
      { label: "Vehicles", href: "/vehicles", capability: "fleet.read" },
    ],
  },
  {
    label: "Routes", href: "/routes/templates", capability: "routes.read",
    children: [
      { label: "Templates", href: "/routes/templates", capability: "routes.read" },
      { label: "Daily routes", href: "/routes/daily", capability: "routes.read" },
      { label: "Jobs", href: "/jobs", capability: "routes.read" },
    ],
  },
  {
    label: "Operations", href: "/operations/pickups", capability: "operations.read",
    children: [
      { label: "Pickups", href: "/operations/pickups", capability: "operations.read" },
      { label: "Deliveries", href: "/operations/deliveries", capability: "operations.read" },
      { label: "Exceptions", href: "/operations/exceptions", capability: "operations.read" },
    ],
  },
  { label: "My run", href: "/run", capability: "run.execute" },
  { label: "Inventory", href: "/inventory", capability: "inventory.read" },
  { label: "Invoices", href: "/invoices", capability: "invoices.read" },
  { label: "Reports", href: "/reports", capability: "reports.read" },
  {
    label: "Administration", href: "/admin", capability: "admin.read",
    children: [
      { label: "Depots", href: "/admin/depots", capability: "admin.read" },
      { label: "Users", href: "/admin/users", capability: "admin.read" },
      { label: "Public holidays", href: "/admin/holidays", capability: "admin.read" },
      { label: "Audit log", href: "/admin/audit", capability: "admin.read" },
    ],
  },
];

export function navigationFor(role: Role): NavItem[] {
  return NAVIGATION
    .filter((item) => can(role, item.capability))
    .map((item) => ({
      ...item,
      children: item.children?.filter((child) => can(role, child.capability)),
    }));
}

export function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
