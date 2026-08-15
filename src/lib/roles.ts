// Role model. Financial visibility is deliberately separate from operational job work.
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

export const CAPABILITIES = [
  "customers.read", "customers.write",
  "agreements.read", "agreements.write",
  "items.read", "items.write",
  "fleet.read", "fleet.write",
  "routes.read", "routes.write", "routes.status",
  "operations.read", "operations.write",
  "run.execute",
  "orders.read", "orders.write", "orders.status", "orders.manage",
  "inventory.read", "inventory.write",
  "warehouse.read", "warehouse.write",
  "invoices.read", "invoices.write",
  "invoices.approve", "invoices.send", "invoices.bulk",
  "pricing.read", "pricing.write",
  "billing.read", "billing.write",
  "reports.read",
  "admin.read", "admin.write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL: Capability[] = [...CAPABILITIES];
const READ_ONLY: Capability[] = CAPABILITIES.filter((c) => c.endsWith(".read"));

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  super_admin: ALL,
  operations_manager: ALL.filter((c) => c !== "admin.write"),
  // Dispatcher remains operational. They can see and assign work but have no
  // financial read/write capability in the new business split.
  dispatcher: [
    "customers.read", "customers.write", "agreements.read", "items.read",
    "fleet.read", "fleet.write", "routes.read", "routes.write", "routes.status",
    "operations.read", "operations.write", "orders.read", "orders.write", "orders.status",
    "inventory.read", "warehouse.read",
  ],
  // Driver is deliberately unable to read pricing/invoices or create financial data.
  driver: ["run.execute", "routes.read", "routes.status", "operations.read", "operations.write", "orders.read", "orders.write", "orders.status"],
  // Finance is the non-operational financial role.
  finance: [
    "customers.read", "agreements.read", "items.read", "orders.read",
    "invoices.read", "invoices.write", "invoices.approve", "invoices.send", "invoices.bulk",
    "pricing.read", "pricing.write", "billing.read", "billing.write", "reports.read",
  ],
  // Warehouse/supervisor-style operations never receive financial capabilities.
  warehouse_operator: [
    "inventory.read", "inventory.write", "warehouse.read", "warehouse.write",
    "items.read", "operations.read", "orders.read", "orders.status",
  ],
  customer_service: [
    "customers.read", "customers.write", "agreements.read", "operations.read",
    "routes.read", "routes.status", "orders.read", "orders.write", "orders.status",
  ],
  sales: ["customers.read", "customers.write", "agreements.read", "agreements.write", "items.read", "reports.read"],
  // Branch/regional managers are owner-like financial users for compatibility
  // with the existing multi-depot role model.
  branch_manager: ALL.filter((c) => !c.startsWith("admin.")),
  regional_manager: ALL.filter((c) => c !== "admin.write"),
  auditor: READ_ONLY,
};

export const COMMON_ROLES = ["super_admin", "operations_manager", "dispatcher", "driver"] as const;

export const ROLE_SUMMARY: Record<Role, string> = {
  super_admin: "Everything, including settings and who can sign in",
  operations_manager: "Everything day to day, including billing and pricing, but not settings",
  dispatcher: "Operational jobs, runs, drivers and customers — no financial data",
  driver: "Their assigned work, on their phone, with no financial data",
  finance: "Pricing, invoices, billing and reports",
  warehouse_operator: "The plant floor and stock",
  customer_service: "Customers and operational jobs",
  sales: "Customers and their contracts",
  branch_manager: "Everything at one site",
  regional_manager: "Everything day to day across sites",
  auditor: "Can look at read-only information, including permitted financial data",
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
