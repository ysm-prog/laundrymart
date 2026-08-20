/**
 * The test login for each role — the data half, with no I/O in it.
 *
 * One profile per entry of `ROLES` in `src/lib/roles.ts`, which is what
 * `src/lib/__tests__/role-profiles.test.ts` pins: a twelfth role added to the
 * app fails a test here rather than quietly having no way to be tested. That is
 * the whole reason this list is a module and not an array inside the runner.
 *
 * Plain JavaScript on purpose. The runner is `node scripts/seed-role-profiles.mjs`
 * with no build step in front of it, so the profiles have to be importable by
 * Node as they are; the vitest suite imports this same file, so there is one
 * copy of the list rather than a TypeScript copy and a runtime copy.
 */

/** Domain for the generated addresses. `example.com` can never receive mail. */
export const DEFAULT_EMAIL_DOMAIN = "roles.example.com";

/** Shared password. Test logins, on a test tenant — printed on every run. */
export const DEFAULT_PASSWORD = "RoleTest!2026";

/** The demo laundry from `supabase/seed.sql`, resolved by name. */
export const DEFAULT_TENANT = "Harbour Commercial Laundry";

/**
 * `note` is what the profile is *for* — the screen or the refusal worth
 * checking once signed in as them. It is written into `user_metadata`, so the
 * reason a login exists travels with the login.
 */
export const ROLE_PROFILES = [
  {
    role: "platform_admin",
    name: "Test Platform Admin",
    note: "Runs the deployment: /platform, the laundry switcher, the release ledger.",
    // Not a membership (0019) — the row goes in `platform_admins`, and it
    // reaches every laundry on the project, including the real one. Hence
    // --platform-admin rather than being provisioned with the rest.
    platform: true,
  },
  {
    role: "super_admin",
    name: "Test Owner",
    note: "The owner. Everything in one laundry, including Settings and the job→invoice flow.",
    // Every word this app puts in front of a person for `super_admin` is
    // "Owner" — ROLE_PRESETS labels it that, the People picker offers it that
    // way, and the note above says it. Deriving the address from the *role
    // identifier* made the one string an operator has to type the only place
    // that said "super-admin", and an owner handed a list of test logins typed
    // `owner@` and was told their details were invalid. Say the same word here.
    email: "owner",
    formerly: "super-admin",
  },
  {
    role: "operations_manager",
    name: "Test Office Manager",
    note: "The office. Everything except Settings › write; holds the job→invoice flow.",
  },
  {
    role: "dispatcher",
    name: "Test Dispatcher",
    note: "Customers, runs, stops, fleet. Must be refused Jobs and Money.",
  },
  {
    role: "driver",
    name: "Test Driver",
    note: "My Runs and /run only, narrowed by RLS to their own assigned jobs.",
    // A `driver` membership with no `drivers` row makes `current_driver_id()`
    // null, and every driver-scoped policy then matches nothing — the login
    // works and the screens are empty, which reads as a bug in the screens.
    driver: true,
  },
  {
    role: "finance",
    name: "Test Finance",
    note: "The payable side: bills, suppliers, accounts. Must be refused customer invoicing.",
  },
  {
    role: "warehouse_operator",
    name: "Test Warehouse Operator",
    note: "Plant floor: batches, stock, linen types. Must be refused Jobs status changes.",
  },
  {
    role: "customer_service",
    name: "Test Counter Staff",
    note: "Customers and run status. Must be refused creating a job since 0025.",
  },
  {
    role: "sales",
    name: "Test Sales",
    note: "Customers and contracts.",
  },
  {
    role: "branch_manager",
    name: "Test Branch Manager",
    note: "Depot-level oversight; no job→invoice flow.",
  },
  {
    role: "regional_manager",
    name: "Test Regional Manager",
    note: "Cross-depot oversight; no job→invoice flow.",
  },
  {
    role: "auditor",
    name: "Test Auditor",
    note: "Read-only across the laundry; every write control should be absent.",
  },
];

/**
 * The address to sign in as. `operations_manager` →
 * `operations-manager@roles.example.com`; a profile carrying `email` says its
 * own local part instead, for a role the app names differently from its
 * identifier (`super_admin` is "Owner" everywhere a person can read it).
 */
export function profileEmail(profile, domain = DEFAULT_EMAIL_DOMAIN) {
  return `${profile.email ?? profile.role.replaceAll("_", "-")}@${domain}`;
}

/**
 * The address this profile used to be provisioned at, if it has moved.
 *
 * Renaming a profile without this would leave the old login sitting in the
 * laundry holding the same membership — two Owner logins, one of them at an
 * address nothing tells you about, and `--remove` cleaning up neither. The
 * runner adopts it instead, so a rerun renames rather than duplicates.
 */
export function formerProfileEmail(profile, domain = DEFAULT_EMAIL_DOMAIN) {
  return profile.formerly ? `${profile.formerly}@${domain}` : null;
}

/** The profiles to provision: memberships always, the platform row on request. */
export function selectedProfiles({ includePlatformAdmin = false } = {}) {
  return ROLE_PROFILES.filter((p) => includePlatformAdmin || !p.platform);
}
