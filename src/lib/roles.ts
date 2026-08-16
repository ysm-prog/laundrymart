// Role model from spec §3. Kept in one place so the nav, the page guards and
// the server actions all agree on who can do what.

/**
 * The roles a **membership** may hold. This list is the app's copy of the check
 * constraint on `memberships.role` (0001), and `roles.test.ts` pins the two
 * together — a role added here and not there is refused by the database at
 * insert time, which is a bad way to find out.
 *
 * `platform_admin` is deliberately absent: it is not a membership at all (0019).
 */
export const MEMBERSHIP_ROLES = [
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

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * Every role the app knows, membership or not.
 *
 * `platform_admin` sits above `super_admin` and is a different kind of thing:
 * a `super_admin` is the top of one laundry, a platform admin runs the
 * deployment the laundries sit on. It is stored as a row in `platform_admins`
 * with no tenant, resolved by `requireSession()`, and it is the only role here
 * that can never appear on a membership — which is why the People picker reads
 * `MEMBERSHIP_ROLES` and this list exists separately.
 */
export const ROLES = ["platform_admin", ...MEMBERSHIP_ROLES] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  platform_admin: "Platform Admin",
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
  "invoices.read",
  "invoices.write",
  // The payable side: suppliers, their bills, purchase orders and the chart of
  // accounts. Split from `invoices.*` rather than folded into it because the
  // two answer to different people — a dispatcher holds `invoices.read` so they
  // can see whether a customer is on stop, which is no reason to show them what
  // the business pays its suppliers.
  //
  // **The line is "whoever writes money records, except the dispatcher."** Most
  // holders arrive here by deriving from TENANT_ALL rather than by being named,
  // which is how a capability added to this file quietly reaches six roles — so
  // the rule is stated here and pinned in `roles.test.ts` against
  // `invoices.*`, and a change to either set now fails a test instead of
  // silently handing somebody the chart of accounts.
  "purchases.read",
  "purchases.write",
  "reports.read",
  "admin.read",
  "admin.write",
  // Running the deployment rather than a laundry: creating and suspending
  // laundries, the settings that apply across all of them, and reading what is
  // released. `admin.*` is the top of one tenant — the owner's own settings and
  // people — and stops there; these two are the level above it and are held by
  // `platform_admin` alone. Kept out of every list derived from ALL below, so a
  // capability added to this block cannot leak into `super_admin` by default.
  "platform.read",
  "platform.write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL: Capability[] = [...CAPABILITIES];

/**
 * Everything a role bounded by one laundry may hold — that is, all of it except
 * the platform block. Every tenant role below is built from this rather than
 * from ALL, so the answer to "who can administer the deployment?" stays one
 * name however many capabilities are added later.
 */
const TENANT_ALL: Capability[] = ALL.filter((c) => !c.startsWith("platform."));
const READ_ONLY: Capability[] = TENANT_ALL.filter((c) => c.endsWith(".read"));

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  // The deployment: every laundry, plus the platform block nobody else holds.
  platform_admin: ALL,
  // Full access to their own laundry, and nothing about the deployment.
  super_admin: TENANT_ALL,
  // Everything except system settings.
  operations_manager: TENANT_ALL.filter((c) => c !== "admin.write"),
  // Customers, routes, jobs, drivers, vehicles, invoices.
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
    "invoices.read", "invoices.write",
    "reports.read",
  ],
  // Own run only — RLS confines every routes row to their own `drivers.id`, so
  // `routes.status` here means "my run", not "any run".
  driver: ["run.execute", "routes.read", "routes.status", "operations.read", "operations.write"],
  // Invoices, payments, bills, reports. The only role that needs the payable
  // side named explicitly — every other holder of it derives from ALL or
  // READ_ONLY and picks it up on its own.
  finance: [
    "customers.read",
    "agreements.read",
    "items.read",
    // Read-only on jobs: "what did we actually take in for them?" is a billing
    // question, but finance never works the counter or the floor.
    "orders.read",
    "invoices.read", "invoices.write",
    "purchases.read", "purchases.write",
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
  sales: ["customers.read", "customers.write", "agreements.read", "agreements.write", "items.read", "reports.read"],
  branch_manager: TENANT_ALL.filter((c) => !c.startsWith("admin.")),
  regional_manager: TENANT_ALL.filter((c) => c !== "admin.write"),
  // Read-only access to compliance and history.
  auditor: READ_ONLY,
};

/**
 * The three answers that fit a small laundry, in the order an owner would think
 * of them (roadmap D1). Eleven job titles is a test a first-timer did not study
 * for — and several of the eleven differ by one capability, so choosing badly
 * between them is easy and the consequence is invisible.
 *
 * **A preset is a plain-English name for a role that already exists**, not a
 * twelfth thing to keep in step. "Owner" is stored, audited, checked by
 * `has_role()` and enforced by RLS as `super_admin`; nothing in the database,
 * the policies or the capability model knows the word. That is why each entry
 * carries its `role` rather than its own capability list: a preset that owned a
 * set of capabilities would be a second answer to "what can this person do",
 * and the two would drift.
 *
 * The label pairs both words — "Owner (Super Admin)" — because the members list
 * and the activity log show the stored role. A picker that said only "Owner"
 * would leave an administrator unable to match their choice to the row it made.
 *
 * The other eight roles stay exactly as they were, one group further down the
 * picker, for the multi-depot operator they were designed for.
 */
export const ROLE_PRESETS = [
  { key: "owner", role: "super_admin", label: "Owner" },
  { key: "office", role: "operations_manager", label: "Office" },
  { key: "driver", role: "driver", label: "Driver" },
] as const satisfies readonly { key: string; role: Role; label: string }[];

export type RolePreset = (typeof ROLE_PRESETS)[number];

/** The roles the three presets cover, in preset order. */
export const PRESET_ROLES: readonly Role[] = ROLE_PRESETS.map((preset) => preset.role);

/** The preset a stored role answers to, if any. Used to label a member's row. */
export function presetForRole(role: Role): RolePreset | undefined {
  return ROLE_PRESETS.find((preset) => preset.role === role);
}

/**
 * Every role holding a capability. The people screen needs this to refuse the
 * change that would leave a tenant with nobody able to manage its logins —
 * a lockout only reachable now that access can be removed as well as granted.
 */
export function rolesWith(capability: Capability): Role[] {
  return ROLES.filter((role) => can(role, capability));
}

/**
 * The same question, restricted to roles a membership can actually hold.
 *
 * This is what the last-administrator guard needs: it counts `memberships`
 * rows, and `platform_admin` is never one of them (0019), so including it in
 * that filter would be a value the check constraint refuses — harmless in an
 * `IN` list, but it would quietly imply a platform admin could stand in as a
 * laundry's last administrator, and they cannot. Their access is real but it
 * comes from somewhere else, and a laundry with no administrator of its own is
 * still stranded.
 */
export function membershipRolesWith(capability: Capability): MembershipRole[] {
  return MEMBERSHIP_ROLES.filter((role) => can(role, capability));
}

/** What each role can do, said the way an owner would say it. */
export const ROLE_SUMMARY: Record<Role, string> = {
  platform_admin: "Every laundry on this system, and the system itself",
  super_admin: "Everything, including settings and who can sign in",
  operations_manager: "Everything day to day, but not the settings",
  dispatcher: "Customers, runs, stops, drivers, trucks and invoices",
  driver: "Their own run, on their phone, and nothing else",
  finance: "Invoices, payments, supplier bills and reports",
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
