// Role model from spec §3. Kept in one place so the nav, the page guards and
// the server actions all agree on who can do what.

export const ROLES = [
  "super_admin",
  "operations_manager",
  "dispatcher",
  "driver",
  "finance",
  "warehouse_operator",
  "customer_service",
  "sales",
  "branch_manager",
  "regional_manager",
  "auditor",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  operations_manager: "Operations Manager",
  dispatcher: "Dispatcher",
  driver: "Driver",
  finance: "Finance",
  warehouse_operator: "Warehouse Operator",
  customer_service: "Customer Service",
  sales: "Sales",
  branch_manager: "Branch Manager",
  regional_manager: "Regional Manager",
  auditor: "Auditor",
};

// Capabilities are coarse on purpose — one per navigable area plus a write flag.
// RLS remains the real boundary; this drives UI and rejects obvious misuse early.
export const CAPABILITIES = [
  "customers.read",
  "customers.write",
  "agreements.read",
  "agreements.write",
  "items.read",
  "items.write",
  "fleet.read",
  "fleet.write",
  "routes.read",
  "routes.write",
  "operations.read",
  "operations.write",
  "run.execute",
  "inventory.read",
  "inventory.write",
  "warehouse.read",
  "warehouse.write",
  "invoices.read",
  "invoices.write",
  "reports.read",
  "admin.read",
  "admin.write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL: Capability[] = [...CAPABILITIES];
const READ_ONLY: Capability[] = CAPABILITIES.filter((c) => c.endsWith(".read"));

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  // Full access.
  super_admin: ALL,
  // Everything except system settings.
  operations_manager: ALL.filter((c) => c !== "admin.write"),
  // Customers, routes, jobs, drivers, vehicles, invoices.
  dispatcher: [
    "customers.read", "customers.write",
    "agreements.read",
    "items.read",
    "fleet.read", "fleet.write",
    "routes.read", "routes.write",
    "operations.read", "operations.write",
    "inventory.read",
    "warehouse.read",
    "invoices.read", "invoices.write",
    "reports.read",
  ],
  // Own run only.
  driver: ["run.execute", "routes.read", "operations.read", "operations.write"],
  // Invoices, payments, reports.
  finance: [
    "customers.read",
    "agreements.read",
    "items.read",
    "invoices.read", "invoices.write",
    "reports.read",
  ],
  warehouse_operator: [
    "inventory.read", "inventory.write",
    "warehouse.read", "warehouse.write",
    "items.read", "operations.read",
  ],
  customer_service: ["customers.read", "customers.write", "agreements.read", "operations.read", "routes.read"],
  sales: ["customers.read", "customers.write", "agreements.read", "agreements.write", "items.read", "reports.read"],
  branch_manager: ALL.filter((c) => !c.startsWith("admin.")),
  regional_manager: ALL.filter((c) => c !== "admin.write"),
  // Read-only access to compliance and history.
  auditor: READ_ONLY,
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
