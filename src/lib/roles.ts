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
  // The round, not the person (0031). A board holds a login, and whoever is
  // operating that round today signs in as it — which is the whole point: a
  // driver resigning, being off sick or covering somebody else's route must not
  // mean re-pointing every open job at a different employee. Next to `driver`
  // because they are the two operational logins and hold the same capabilities.
  "board",
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
  board: "Board",
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
  // The payable side: suppliers, their bills, purchase orders and the chart of
  // accounts. Split from `invoices.*` rather than folded into it because the
  // two answer to different people — a dispatcher holds `invoices.read` so they
  // can see whether a customer is on stop, which is no reason to show them what
  // the business pays its suppliers.
  //
  // **This block does NOT follow `invoices.*` any more.** It used to be exactly
  // "whoever writes money records, except the dispatcher", which was true while
  // both sides of the ledger answered to the same people. Since the job→invoice
  // flow was narrowed to the Owner and the Office manager, deriving from
  // `invoices.*` would have taken supplier bills and the chart of accounts off
  // the finance role as a side effect of a decision about customer billing.
  // So the holders are named explicitly on each role and pinned literally in
  // `roles.test.ts`.
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
 * Taking a job in, moving it through the plant, and billing it.
 *
 * **Held by the Owner and the Office manager, and by nobody else** (the owner's
 * decision, 2026-08-16). This is the business's main flow and the whole of it —
 * `orders.*` and `invoices.*` — answers to the same two people, so the block is
 * named once here and subtracted from every other role rather than being
 * omitted role by role, where the next capability added would quietly reopen it.
 *
 * Note what is deliberately *not* in this block: `purchases.*` keeps its own
 * holders (see below). Narrowing who bills the customer is not a statement
 * about who pays the suppliers, and letting the payable side ride along on this
 * change would have taken the chart of accounts off the finance role for a
 * reason nobody asked for.
 *
 * **`pricing.*` and `billing.*` joined the block when the rate-card model was
 * adopted** (2026-08-17). They arrived from a branch written *before* the
 * narrowing, which gave pricing to `sales` and the ledger to `finance` — the
 * design this app had until the owner said the flow answers to two people. What
 * a customer is charged, and which rate card charges them, is the first half of
 * job→invoice; leaving the two new blocks out of it would have reopened to six
 * roles exactly what 0025 closed, and by the very mechanism this comment exists
 * to warn about.
 */
const JOB_TO_INVOICE: Capability[] = ALL.filter(
  (c) => c.startsWith("orders.") || c.startsWith("invoices.")
      || c.startsWith("pricing.") || c.startsWith("billing."),
);

/** Everything a role may hold that is neither platform work nor the main flow. */
const outsideMainFlow = (caps: Capability[]): Capability[] =>
  caps.filter((c) => !JOB_TO_INVOICE.includes(c));

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
  // Customers, routes, stops, drivers and vehicles. No jobs, no invoices and no
  // prices: the main flow is the Owner's and the Office manager's alone.
  //
  // 0017's RLS says the same thing from underneath — the read policies on
  // `invoices`, `payments`, the credit notes, `service_agreement_lines` and
  // `job_charge_snapshots` all go through `can_read_billing()` /
  // `can_read_pricing()`, so a dispatcher's session reads nothing here even if
  // it gets past the nav.
  dispatcher: [
    "customers.read", "customers.write",
    "agreements.read",
    "items.read",
    "fleet.read", "fleet.write",
    "routes.read", "routes.write", "routes.status",
    "operations.read", "operations.write",
    "inventory.read",
    "warehouse.read",
    "reports.read",
  ],
  // Own run only — RLS confines every routes row to their own `drivers.id`, so
  // `routes.status` here means "my run", not "any run".
  driver: ["run.execute", "routes.read", "routes.status", "operations.read", "operations.write"],
  // The payable side and reports. Customer invoicing is **not** here: billing
  // the work is part of the main flow, which the Owner and the Office manager
  // keep. What finance still owns is what the business pays out — supplier
  // bills, purchase orders and the chart of accounts — which is why
  // `purchases.*` is named explicitly rather than derived.
  finance: [
    "customers.read",
    "agreements.read",
    "items.read",
    "purchases.read", "purchases.write",
    "reports.read",
  ],
  // The plant floor: stock, batches and the linen vocabulary. It used to hold
  // `orders.status` so the floor could walk a job from new to ready — that is
  // now the Owner's and the Office manager's, by the owner's decision. The
  // floor still runs every warehouse stage; what it no longer does is move the
  // customer's job along behind them.
  warehouse_operator: [
    "inventory.read", "inventory.write",
    "warehouse.read", "warehouse.write",
    "items.read", "operations.read",
  ],
  /*
   * The counter: customers, the day's visits, and taking laundry in.
   *
   * `orders.*` came back on 2026-08-24, reversing the 2026-08-16 decision that
   * had moved it to the Owner and the Office manager alone. That decision was
   * coherent — job→invoice is one flow and it answers to two people — but its
   * effect was that a laundry wanting counter staff to book jobs had to make
   * them **Office manager**, which is 31 screens including the whole ledger,
   * the plant and the activity log. The least-trained person in the building
   * was being handed the largest surface in the application to do the one job
   * this role is named for.
   *
   * `orders.manage` is deliberately **not** among them. Cancelling a job,
   * backdating a receipt and editing one already completed are the supervisor's
   * set (§3), and none of them is part of taking laundry in.
   *
   * The half that matters is not here: `0025` narrowed every *write* on the job
   * tables to two roles in RLS, so this list alone would let the counter open
   * the form, press Save and write **zero rows with no error**. `0034` widens
   * that restrictive layer to match, and `main_flow_scope.test.sql` asserts the
   * write actually lands rather than merely not raising.
   */
  customer_service: [
    "customers.read", "customers.write", "agreements.read", "operations.read",
    "routes.read", "routes.status",
    "orders.read", "orders.write", "orders.status",
  ],
  sales: ["customers.read", "customers.write", "agreements.read", "agreements.write", "items.read", "reports.read"],
  branch_manager: outsideMainFlow(TENANT_ALL.filter((c) => !c.startsWith("admin."))),
  regional_manager: outsideMainFlow(TENANT_ALL.filter((c) => c !== "admin.write")),
  // Read-only access to compliance and history.
  auditor: outsideMainFlow(READ_ONLY),
  // A round's own work, on the phone in the van. Identical to `driver` and that
  // is deliberate rather than lazy: the two are the same job done by the same
  // person, and the only difference is what the work is filed under. RLS is what
  // makes `routes.status` here mean "my round" rather than "any round" —
  // `is_board_only()` narrows every routes row to `current_board_id()`.
  //
  // What it deliberately does **not** hold: `routes.write`. Ordering the day is
  // the office's decision and the round follows it, which is the client's own
  // rule — a board sees the final sequence and cannot change it.
  board: ["run.execute", "routes.read", "routes.status", "operations.read", "operations.write"],
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
  // The operational login a small laundry actually creates. It leads the other
  // two operational roles because a round is what work is assigned to now; a
  // `driver` membership is still offered further down for a laundry that tracks
  // people rather than rounds.
  { key: "board", role: "board", label: "Board" },
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
  dispatcher: "Customers, stops, drivers and trucks — no jobs, invoices or prices",
  driver: "Their own run, on their phone, and nothing else",
  finance: "Supplier bills, what you owe, and reports",
  warehouse_operator: "The plant floor and stock — not the customer's job",
  customer_service: "Customers and the day's stops — not taking jobs in",
  sales: "Customers and their contracts",
  branch_manager: "Everything at one site except jobs and invoices",
  regional_manager: "Everything across sites except jobs and invoices",
  auditor: "Can look at everything except jobs and invoices, changes nothing",
  board: "One delivery round, on the phone in the van — its own jobs and nothing else",
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
