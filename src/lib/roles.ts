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
  // Advancing a run through its workflow states. Split from `routes.write`
  // (which plans and assigns) because moving a run that is already out on the
  // road is a floor decision, not a planning one — see ROLE_CAPABILITIES.
  "routes.status",
  "operations.read",
  "operations.write",
  "run.execute",
  // The counter's laundry jobs (`/orders`, labelled "Jobs"), split the same way
  // routes are: `write` creates and edits, `status` walks a job through the
  // workflow — the plant floor advances jobs it does not plan — and `manage` is
  // the supervisor's set: cancel a job, backdate a receipt, reopen the edit form
  // on one that is already completed.
  "orders.read",
  "orders.write",
  "orders.status",
  "orders.manage",
  "inventory.read",
  "inventory.write",
  "warehouse.read",
  "warehouse.write",
  // ---------------------------------------------------------------- money --
  // The financial capabilities are split finer than everything above them,
  // because the brief's rule is not "who can open the invoices screen" but
  // "who may see a price at all". Operational roles — driver, warehouse
  // operator, customer service and **dispatcher** — hold none of these, and
  // that exclusion is enforced by RLS in migration 0017 as well as here: the
  // read policies on `invoices`, `invoice_lines`, `payments`, the credit
  // notes, `service_agreement_lines` and `job_charge_snapshots` all go through
  // `can_read_pricing()` / `can_read_billing()`, so a session that gets past
  // the UI still reads nothing.
  //
  // What a customer is charged. Sales negotiate it; nobody on the road or the
  // floor sees it.
  "pricing.read",
  "pricing.write",
  // A customer's billing settings and a job's own money: the rate card in use,
  // the billing method, the Xero reference, and the charge snapshot.
  "billing.read",
  "billing.write",
  "invoices.read",
  "invoices.write",
  // Approving a job's charges is what freezes them, so it is deliberately not
  // `invoices.write` — raising a draft and signing off the price a customer
  // will be held to are different decisions.
  "invoices.approve",
  // Generating an invoice never sends it. Sending is the act the customer sees,
  // so it carries its own capability.
  "invoices.send",
  // Acting on a selection rather than a record. Same operations, but a mistake
  // is multiplied by the size of the selection.
  "invoices.bulk",
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
  // Customers, routes, jobs, drivers, vehicles — and **no money**.
  //
  // Dispatch used to hold `invoices.read`/`invoices.write`, which is the one
  // role whose capabilities this change takes away. The brief is explicit that
  // a dispatcher sees jobs, runs and a customer's operational information and
  // not pricing, job monetary values, invoice amounts or Xero references. They
  // keep every operational capability they had; what is gone is the ledger.
  dispatcher: [
    "customers.read", "customers.write",
    "agreements.read",
    "items.read",
    "fleet.read", "fleet.write",
    "routes.read", "routes.write", "routes.status",
    "operations.read", "operations.write",
    "orders.read", "orders.write", "orders.status",
    "inventory.read",
    "warehouse.read",
    "reports.read",
  ],
  // Own run only — RLS confines every routes row to their own `drivers.id`, so
  // `routes.status` here means "my run", not "any run".
  driver: ["run.execute", "routes.read", "routes.status", "operations.read", "operations.write"],
  // Invoices, payments, reports.
  finance: [
    "customers.read",
    "agreements.read",
    "items.read",
    // Read-only on jobs: "what did we actually take in for them?" is a billing
    // question, but finance never works the counter or the floor.
    "orders.read",
    // The whole money surface, including the two acts that are split out of
    // `invoices.write`: signing off a job's price, and putting a document in
    // front of a customer.
    "pricing.read",
    "billing.read", "billing.write",
    "invoices.read", "invoices.write",
    "invoices.approve", "invoices.send", "invoices.bulk",
    "reports.read",
  ],
  warehouse_operator: [
    "inventory.read", "inventory.write",
    "warehouse.read", "warehouse.write",
    "items.read", "operations.read",
    // The floor is what actually moves a job from new to ready, so it holds
    // `orders.status` without `orders.write` — it advances work, it does not
    // take orders or change what was agreed.
    "orders.read", "orders.status",
  ],
  customer_service: [
    "customers.read", "customers.write", "agreements.read", "operations.read",
    "routes.read", "routes.status",
    // The counter: takes the laundry in and hands it back.
    "orders.read", "orders.write", "orders.status",
  ],
  // Sales negotiate the rate card, so they are the one non-finance role that
  // sees a price — and `pricing.*` exists precisely so that can be granted
  // without handing them the ledger. `billing.read` lets them see which rate
  // card a customer is on; they do not change how a customer is billed.
  sales: [
    "customers.read", "customers.write",
    "agreements.read", "agreements.write",
    "items.read", "reports.read",
    "pricing.read", "pricing.write",
    "billing.read",
  ],
  branch_manager: ALL.filter((c) => !c.startsWith("admin.")),
  regional_manager: ALL.filter((c) => c !== "admin.write"),
  // Read-only access to compliance and history.
  auditor: READ_ONLY,
};

/**
 * The four answers that fit a small laundry, in the order an owner would think
 * of them. Eleven job titles is a test a first-timer did not study for — and
 * several of the eleven differ by one capability, so choosing badly between
 * them is easy and the consequence is invisible.
 *
 * These are presets over the existing roles, not a new model: nothing in the
 * database, the RLS policies or the guards changes. The remaining seven roles
 * stay available for the multi-depot operator they were designed for.
 */
export const COMMON_ROLES = ["super_admin", "operations_manager", "dispatcher", "driver"] as const;

/** What each role can do, said the way an owner would say it. */
export const ROLE_SUMMARY: Record<Role, string> = {
  super_admin: "Everything, including settings and who can sign in",
  operations_manager: "Everything day to day, but not the settings",
  dispatcher: "Customers, runs, stops, drivers and trucks — no prices or invoices",
  driver: "Their own run, on their phone, and nothing else",
  finance: "Invoices, payments and reports",
  warehouse_operator: "The plant floor and stock",
  customer_service: "Customers and the day's stops",
  sales: "Customers and their contracts",
  branch_manager: "Everything at one site",
  regional_manager: "Everything day to day across sites",
  auditor: "Can look at everything, can change nothing",
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
