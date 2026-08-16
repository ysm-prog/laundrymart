#!/usr/bin/env node
/**
 * Provision one test login per role, so every role can actually be signed in as.
 *
 *   node --env-file=.env.local scripts/seed-role-profiles.mjs
 *   node --env-file=.env.local scripts/seed-role-profiles.mjs --dry-run
 *   node --env-file=.env.local scripts/seed-role-profiles.mjs --tenant "Harbour Commercial Laundry"
 *   node --env-file=.env.local scripts/seed-role-profiles.mjs --remove --yes
 *
 * Idempotent: run it as often as you like. An address that already exists is
 * reused and its password reset to the one printed at the end, so a rerun is
 * also how you recover a test login nobody wrote down.
 *
 * Two deliberate refusals:
 *
 *  - **`platform_admin` is skipped unless you pass `--platform-admin`.** It is
 *    not a membership (0019): the row goes in `platform_admins` and reaches
 *    *every* laundry on the project, so on a deployment that also holds a real
 *    tenant it is not a demo-tenant test login at all.
 *  - **`--remove` deletes a login only when nothing else points at it.** A test
 *    address that has since been given a membership somewhere else keeps its
 *    login and loses only what this script gave it.
 *
 * Needs `SUPABASE_SERVICE_ROLE_KEY`: creating logins is an Auth admin call, and
 * the membership insert has to write a `tenant_id` no session is bound to. That
 * key bypasses RLS, so every statement below filters `tenant_id` by hand.
 */

import { createClient } from "@supabase/supabase-js";
import {
  DEFAULT_EMAIL_DOMAIN, DEFAULT_PASSWORD, DEFAULT_TENANT,
  profileEmail, selectedProfiles,
} from "./role-profiles.mjs";

// ------------------------------------------------------------------ args ---

function parseArgs(argv) {
  const opts = {
    tenant: process.env.ROLE_PROFILE_TENANT ?? DEFAULT_TENANT,
    domain: process.env.ROLE_PROFILE_EMAIL_DOMAIN ?? DEFAULT_EMAIL_DOMAIN,
    password: process.env.ROLE_PROFILE_PASSWORD ?? DEFAULT_PASSWORD,
    includePlatformAdmin: false,
    dryRun: false,
    remove: false,
    yes: false,
  };
  const takesValue = { "--tenant": "tenant", "--domain": "domain", "--password": "password" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg in takesValue) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) fatal(`${arg} needs a value.`);
      opts[takesValue[arg]] = value;
      i += 1;
    } else if (arg === "--platform-admin") opts.includePlatformAdmin = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--remove") opts.remove = true;
    else if (arg === "--yes") opts.yes = true;
    else if (arg === "--help" || arg === "-h") usage(0);
    else fatal(`Unknown argument: ${arg}`);
  }
  if (opts.password.length < 6) fatal("Supabase requires a password of at least 6 characters.");
  return opts;
}

function usage(code) {
  console.log(`
Provision a test login for every role.

  --tenant <name|uuid>   Laundry the memberships go in (default: ${DEFAULT_TENANT})
  --domain <domain>      Email domain for the logins  (default: ${DEFAULT_EMAIL_DOMAIN})
  --password <password>  Shared password             (default: ${DEFAULT_PASSWORD})
  --platform-admin       Also provision platform_admin — reaches EVERY laundry
  --dry-run              Say what would change and write nothing
  --remove               Take the profiles back off (needs --yes)
  --yes                  Confirm --remove

Environment: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
Run with \`node --env-file=.env.local scripts/seed-role-profiles.mjs\`.
`);
  process.exit(code);
}

function fatal(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// ----------------------------------------------------------------- setup ---

const opts = parseArgs(process.argv.slice(2));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  fatal(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.\n" +
    "  Copy .env.example to .env.local, fill them in, then run:\n" +
    "  node --env-file=.env.local scripts/seed-role-profiles.mjs",
  );
}
if (opts.remove && !opts.yes && !opts.dryRun) {
  fatal("--remove deletes memberships and logins. Re-run with --yes (or --dry-run first).");
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const profiles = selectedProfiles({ includePlatformAdmin: opts.includePlatformAdmin });

/** Throw on a Supabase error rather than carrying an empty result forward. */
function must(step, { data, error }) {
  if (error) fatal(`${step}: ${error.message}`);
  return data;
}

// ------------------------------------------------------------- the tenant ---

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveTenant(nameOrId) {
  const query = admin.from("tenants").select("id, name");
  const rows = must(
    "Reading tenants",
    await (UUID.test(nameOrId) ? query.eq("id", nameOrId) : query.eq("name", nameOrId)),
  );
  if (rows.length === 0) {
    const all = must("Listing tenants", await admin.from("tenants").select("name").order("name"));
    fatal(
      `No laundry called "${nameOrId}" on this project.\n  Found: ` +
      (all.map((t) => t.name).join(", ") || "none at all — seed one first."),
    );
  }
  if (rows.length > 1) fatal(`"${nameOrId}" matches ${rows.length} laundries. Pass the uuid instead.`);
  return rows[0];
}

// -------------------------------------------------------------- the logins ---

/** Auth has no read-by-email, so the page is walked once and indexed. */
async function loadUsersByEmail() {
  const byEmail = new Map();
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) fatal(`Listing logins: ${error.message}`);
    for (const user of data.users) if (user.email) byEmail.set(user.email.toLowerCase(), user);
    if (data.users.length < 1000) return byEmail;
  }
  fatal("More than 50,000 logins on this project; refusing to guess. Provision by hand.");
}

async function ensureUser(existing, profile, email) {
  const metadata = {
    full_name: profile.name,
    role_profile: profile.role,
    role_profile_note: profile.note,
  };
  if (existing) {
    if (opts.dryRun) return { user: existing, action: "reset password" };
    const data = must(
      `Updating ${email}`,
      await admin.auth.admin.updateUserById(existing.id, {
        password: opts.password, email_confirm: true, user_metadata: metadata,
      }),
    );
    return { user: data.user, action: "reset password" };
  }
  if (opts.dryRun) return { user: null, action: "create login" };
  const data = must(
    `Creating ${email}`,
    await admin.auth.admin.createUser({
      email, password: opts.password, email_confirm: true, user_metadata: metadata,
    }),
  );
  return { user: data.user, action: "created login" };
}

// --------------------------------------------------------- what they are ---

async function ensureMembership(userId, tenantId, role) {
  const existing = must(
    "Reading memberships",
    await admin.from("memberships").select("role")
      .eq("user_id", userId).eq("tenant_id", tenantId).maybeSingle(),
  );
  if (existing?.role === role) return "member already";
  if (opts.dryRun) return existing ? `re-role from ${existing.role}` : "add membership";
  must(
    "Writing membership",
    await admin.from("memberships")
      .upsert({ user_id: userId, tenant_id: tenantId, role }, { onConflict: "user_id,tenant_id" }),
  );
  return existing ? `re-roled from ${existing.role}` : "membership added";
}

/**
 * The driver profile needs a `drivers` row pointed at its login, or
 * `current_driver_id()` is null and every driver-scoped policy matches nothing.
 */
async function ensureDriverRecord(userId, tenantId, profile, email) {
  const existing = must(
    "Reading drivers",
    await admin.from("drivers").select("id, status")
      .eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle(),
  );
  if (existing) {
    if (existing.status === "active") return "driver record linked";
    if (opts.dryRun) return "reactivate driver record";
    must(
      "Reactivating driver",
      await admin.from("drivers").update({ status: "active" })
        .eq("id", existing.id).eq("tenant_id", tenantId),
    );
    return "driver record reactivated";
  }
  if (opts.dryRun) return "create driver record";
  const depot = must(
    "Reading depots",
    await admin.from("depots").select("id")
      .eq("tenant_id", tenantId).eq("status", "active").order("code").limit(1).maybeSingle(),
  );
  must(
    "Creating driver",
    await admin.from("drivers").insert({
      tenant_id: tenantId, user_id: userId, depot_id: depot?.id ?? null,
      full_name: profile.name, email, status: "active",
    }),
  );
  return depot ? "driver record created" : "driver record created (no depot on this laundry)";
}

async function ensurePlatformAdmin(userId, profile) {
  const existing = must(
    "Reading platform admins",
    await admin.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle(),
  );
  if (existing) return "platform admin already";
  if (opts.dryRun) return "grant platform admin";
  must(
    "Granting platform admin",
    await admin.from("platform_admins").insert({ user_id: userId, note: profile.note }),
  );
  return "platform admin granted";
}

// ------------------------------------------------------------- taking back ---

async function removeProfile(user, tenantId, profile, email) {
  const steps = [];
  if (!user) return ["no login to remove"];

  must(
    "Removing membership",
    await admin.from("memberships").delete().eq("user_id", user.id).eq("tenant_id", tenantId),
  );
  steps.push("membership removed");

  if (profile.driver) {
    // Unlinked rather than deleted: runs, stops and inspections point at a
    // driver row, and the history of who did the work outlives the test login.
    must(
      "Unlinking driver",
      await admin.from("drivers").update({ user_id: null, status: "inactive" })
        .eq("tenant_id", tenantId).eq("user_id", user.id),
    );
    steps.push("driver record unlinked");
  }

  const { error: platformError } = await admin
    .from("platform_admins").delete().eq("user_id", user.id);
  if (platformError) steps.push(`platform admin NOT removed (${platformError.message})`);
  else steps.push("platform admin removed if held");

  // Only delete the login when this script's grants were the whole of it.
  const others = must(
    "Counting remaining memberships",
    await admin.from("memberships").select("tenant_id").eq("user_id", user.id),
  );
  const stillPlatform = must(
    "Re-reading platform admins",
    await admin.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle(),
  );
  if (others.length > 0 || stillPlatform) {
    steps.push(`login kept — ${email} still holds access elsewhere`);
    return steps;
  }
  const { error } = await admin.auth.admin.deleteUser(user.id);
  steps.push(error ? `login NOT deleted (${error.message})` : "login deleted");
  return steps;
}

// -------------------------------------------------------------------- run ---

const tenant = await resolveTenant(opts.tenant);
const usersByEmail = await loadUsersByEmail();

console.log(`
  Project   ${new URL(url).host}
  Laundry   ${tenant.name}  (${tenant.id})
  Profiles  ${profiles.length}${opts.includePlatformAdmin ? " (including platform_admin)" : ""}
  Mode      ${opts.remove ? "REMOVE" : "provision"}${opts.dryRun ? " — DRY RUN, nothing is written" : ""}
`);

const rows = [];
for (const profile of profiles) {
  const email = profileEmail(profile, opts.domain);
  const existing = usersByEmail.get(email.toLowerCase()) ?? null;

  if (opts.remove) {
    const steps = opts.dryRun
      ? [existing ? "would remove membership and login" : "no login to remove"]
      : await removeProfile(existing, tenant.id, profile, email);
    console.log(`  ${email.padEnd(38)} ${steps.join("; ")}`);
    continue;
  }

  const { user, action } = await ensureUser(existing, profile, email);
  const steps = [action];
  const userId = user?.id ?? null;

  if (userId) {
    if (profile.platform) steps.push(await ensurePlatformAdmin(userId, profile));
    else steps.push(await ensureMembership(userId, tenant.id, profile.role));
    if (profile.driver) steps.push(await ensureDriverRecord(userId, tenant.id, profile, email));
  } else {
    // Dry run against an address that does not exist yet — nothing to point at.
    if (profile.platform) steps.push("grant platform admin");
    else steps.push("add membership");
    if (profile.driver) steps.push("create driver record");
  }

  rows.push({ role: profile.role, email, note: profile.note });
  console.log(`  ${email.padEnd(38)} ${steps.join("; ")}`);
}

if (!opts.remove) {
  const width = Math.max(...rows.map((r) => r.email.length));
  console.log(`\n  Sign in at /login with password: ${opts.password}\n`);
  for (const row of rows) console.log(`  ${row.email.padEnd(width)}  ${row.note}`);
  if (!opts.includePlatformAdmin) {
    console.log(
      "\n  platform_admin was skipped: it is not a membership and reaches every laundry" +
      "\n  on this project. Pass --platform-admin if that is what you want.",
    );
  }
}
console.log(opts.dryRun ? "\n  Dry run — nothing was written.\n" : "\n  Done.\n");
