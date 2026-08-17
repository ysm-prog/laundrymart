# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

## Latest: Xero — invoices (`0026`) and payments (`0027`)
Billing design as decided: rates stay where they are (contract lines + `laundry_prices`), the
Owner raises one invoice a month, and both the invoice and its payments reach Xero.

**One Xero org per laundry** — `xero_connections` keyed on `tenant_id`. **The tokens are
credentials**: RLS denies everything outright, grants revoked, and screens read
`xero_connection_status()` (definer, never returns a token).

**Neither push ever blocks the money.** Issue/record succeeds first; a refusal is written to
`xero_push_error` with a Retry. A laundry that has not connected, or has not chosen a bank
account, is **skipped, not failed** — red errors nobody can act on are how an integration gets
ignored.

**A payment carries an Idempotency-Key (its own id).** Stricter than the invoice path on
purpose: a duplicated invoice is visible, a duplicated payment quietly makes a customer look
paid up.

**Payments need a bank account and only the laundry knows which.** The settings screen lists
their real Xero bank accounts; `payment_account_code` null = skip.

**NOTHING here has touched Xero.** No credentials in this container and the session's Xero
tools are read-only. **0026 and 0027 are not applied to `laundrymart-syd`.** First live run:
apply both, set XERO_CLIENT_ID/SECRET, register `<origin>/api/xero/callback`, connect, pick the
account, then issue one invoice and take one payment.

**Trap worth remembering:** a pgTAP run reporting `0 assertions, 0 failures` is Postgres being
down, not a pass. Check the count.


## Latest: a test login per role (`npm run seed:roles`) — tooling, no migration
`scripts/role-profiles.mjs` (the list) + `scripts/seed-role-profiles.mjs` (the runner). One
login per role in the demo laundry, `<role>@roles.example.com`, shared password printed each
run. CLAUDE.md §3a has the reasoning.

**The eleven profiles ARE live on `laundrymart-syd`**, in the demo laundry only. Verified:
`is_member(Adelaide)` false for all eleven, `current_driver_id()` resolves for the driver, and
0025 proved through the API — warehouse operator UPDATE on `laundry_orders` = 0 rows, office
manager = 1 row.

**Provisioned by SQL, not by the script** — no service-role key in that container, so
`auth.users` + `auth.identities` were written in GoTrue's shape and the bcrypt hash verified.
**The script's own Auth round trip is therefore still unproven**: run
`npm run seed:roles -- --dry-run` from a machine with the key — it should say "reset password"
eleven times and create nothing.

**Nor has a sign-in been exercised.** The password grant was attempted; this container's network
policy answers 403 to `CONNECT …supabase.co` (same wall the Resend path hit). First thing to do
on the deployed app: sign in as `driver@roles.example.com` / `RoleTest!2026`.

**`platform_admin` needs `--platform-admin`.** It is not a membership and crosses into
`Adelaide Towel Service`, which defeats testing on the demo tenant.

**The driver profile creates a `drivers` row.** Without one `current_driver_id()` is null and
the driver's screens are empty — a login that works and shows nothing.

**`role-profiles.test.ts` imports the script's own module**, so the list has no second copy and
a role added to `roles.ts` without a profile fails a test.

## Previously: job→invoice is the Owner's and the Office manager's (`0025`)
`orders.*` + `invoices.*` → `super_admin` and `operations_manager` only (owner's decision).

**Two layers, on purpose.** `roles.ts` decides who is *shown* the flow; `0025` adds
**restrictive** write policies so the database decides who may *change* it. Restrictive, not a
rewrite, because of the §11 `invoices` divergence — it ANDs with whatever policy is there.

**SELECT is deliberately NOT restricted.** A driver must read the job they are delivering.
Locking reads would blank My Runs. Ask before changing that.

**`JOB_TO_INVOICE` is subtracted from every other role** rather than omitted per role — six
roles derive from `TENANT_ALL`, so a new `orders.*` capability would otherwise reopen the flow
to all of them silently.

**`purchases.*` deliberately did NOT follow.** Finance keeps supplier bills and the chart of
accounts; it lost only customer invoicing. The old "invoices minus dispatcher" pin is gone and
the holders are pinned literally.

**0025 IS applied to `laundrymart-syd`** (2026-08-16), rehearsed and verified: a rehearsal
warehouse operator's UPDATE touched 0 rows, both real logins still write (they are
`platform_admin`, which `has_role()` admits), 27 policies over 9 tables, no row changed.

**The driver carve-out is load-bearing** — `completeLaundryOrder` writes `laundry_orders` from
My Runs and `/run`. Without it a driver's delivery completion is refused *silently* (UPDATE 0,
no error) and the job sits at `out_for_delivery`. A local probe caught it before it shipped.

## Decided: `claude/phase-6-build-0yybvq` is dropped, not pending
Owner's decision 2026-08-16, all three parts refused on their own merits. **Do not merge it.**
Simple mode (D2) was built for a 22-row rail and 0025 shrank most roles further; its own
`inviteMember` uses `generateLink` and therefore *sends no email at all* (the shipped one uses
`inviteUserByEmail`, which is what makes Supabase send it); the branded invite email needs
Resend, which has never been proven against the provider. CLAUDE.md §19 has the full reasoning.
Branch left on the remote, not deleted.

## Also live: deliveries were impossible — nothing ever loads the van
Found on the deployed app. `only 0 of that item are in transit, so 12 cannot be moved out`.

**`confirmLoad` moves no stock.** `unload.ts` does `in_transit → at_depot`; nothing does the
reverse. So `in_transit` is written only by *pickups*, and every clean-linen delivery drew from
an always-empty pool. Verified live: not one `in_transit` row on the whole deployment.

**Fix: a delivery sources from the van if it has it, else the run's depot**
(`lib/routes/delivery-stock.ts` decides, `deliver-stock.ts` performs). A short van falls back
**whole**, never split — one delivery line, one ledger row. Both the online action and
`/api/sync` go through the one helper; they used to carry separate copies of the move.

**If you build a load manifest**, that is where the depot→van hop belongs, and this fallback
should then only cover the unloaded case. It is not built because the load step captures no
quantities — counts are taken at the door.

## Also live: the app wears the YSM Hub design language (no migration)
Presentation only. **No schema, action, RLS policy, capability, query, route or business rule
moved**, and the 332 unit tests pass untouched. CLAUDE.md §10b and the 2026-08-16 entry have the
detail; what to carry forward:

**The source of truth is `ysm-prog/ysm-hub`, `src/index.css`** — attached to that session via
`add_repo` and cloned to `/workspace/ysm-hub`. If you need to re-check a value, read that file
rather than this app's tokens. Their design is "paper and ink with accent": warm paper
`#f4f1ea` with an 18px dot grid, ink `#121a19`, teal `#01696f`, Instrument Sans + Instrument
Serif italic + JetBrains Mono.

**The whole re-skin is in `globals.css`'s token layer** because `src/` carries zero literal
Tailwind palette classes and zero hard-coded hex outside the email templates. Keep it that way:
the moment a screen hard-codes a colour, the next re-skin stops being a one-file change.

**Palette values are pinned to one decimal place on purpose.** Integer HSL percentages drift
1–2 per channel — the first pass rendered `#f4f2eb` instead of `#f4f1ea`. If you add a token,
carry the decimal and verify by reading the computed colour out of the browser.

**Two places this app knowingly departs from YSM, both documented in §10b — do not "fix" them
back:**
1. **Mono labels.** YSM spends mono on eyebrows, table headers and badges. Adopting that would
   reverse the 2026-08-13 sweep of 74 `font-mono` and every uppercase tracked label across 28
   files, done because counter staff and drivers read the result as a developer console. Only
   `BrandMark` uses mono.
2. **Comfort metrics.** 15px body and 44px controls, against YSM's 14px/36px — this is a counter
   tablet and a driver's phone, and YSM itself lifts its scale under `@media (pointer: coarse)`.

**The dark theme is derived, not copied.** YSM never contrast-checked its own dark accent
(`#00898f` = 4.4:1 on page, 4.0:1 on card) and leaves its semantic four at light values that are
unreadable on `#141412`. Every dark colour here keeps YSM's hue exactly and moves only lightness
until it clears AA on page, on card, and as a fill under `--on-status`.

**`/design-preview` cannot show the active rail row** — its pathname matches no nav area, so no
row is ever active there. The active state is an ink pill with paper text (inverted on dark) and
must be verified by probing the `--sidebar-*` tokens, not by screenshot.

**Verification.** `verify` green; asserted light and dark at eight widths with no console errors.
The pre-existing dispatch-planner overflow was measured against a stash-and-rebuild baseline
rather than assumed: **16px at 320/1024 before, 7px after**, same 135/33 overflowing elements and
the same 16px smallest tap target. **Never opened against a live project** — no Supabase
credentials in this container, so the authenticated screens have not been seen with real rows.

**Two traps that cost time in this session, both environmental:**
- Copying `.env.example` verbatim does **not** boot: `SENTRY_DSN=`, `RESEND_API_KEY=` and
  `CRON_SECRET=` are present-but-empty, which Zod rejects rather than treating as absent, and the
  anon-key placeholder is under the 20-char minimum. Omit the optionals entirely.
- `pkill -f "next start"` does **not** match the running process, which is named `next-server`.
  A survivor kept serving a stale build and returned CSS as `text/plain`, which renders the
  gallery completely unstyled and silently invalidates every measurement taken against it.

## Also live: a role above the laundry — platform admins (`0019_platform_admin`)
`platform_admin` is the twelfth role and the only one that is **not a membership**. CLAUDE.md
§3/§7 and the 2026-08-16 entry have the detail; what to carry forward:

**The widening is two functions, not fifty policies.** `is_member()` and `has_role()` each
gained `or public.is_platform_admin()`; `is_driver_only()` gained `and not`. Every privileged
surface funnels through those, so this reaches everything at once — including the `invoices`
policies this repo and the live project still disagree about (§11), which is exactly why they
were not rewritten. **If you add a policy, it inherits this for free. Do not restate it.**

**`platform_admins` has no `tenant_id`** — the only table in the schema that does not — and
`apply_tenant_policy` must never be used on it. Its policy is `is_platform_admin()` both ways,
so nobody else can see the list exists. `platform_settings` is a single row keyed
`id boolean primary key default true check (id)`.

**`ROLES` (12) vs `MEMBERSHIP_ROLES` (11).** The check constraint on `memberships.role` refuses
`platform_admin`. The People picker and the Zod enums in `inviteMember`/`updateMembership` must
use `MEMBERSHIP_ROLES`, and the last-admin guard must use `membershipRolesWith`, not
`rolesWith`. Tenant roles are built from `TENANT_ALL`, never `ALL`, so `platform.*` cannot leak
into `super_admin`.

**0019 IS APPLIED to `laundrymart-syd`** (2026-08-16) and merged to `Prod`. Rehearsed and
verified per §11 — the decisive probe was a rehearsal laundry invisible to an ordinary member
and visible to a platform admin, then rolled back.

**Bootstrapped: `darshan@` and `jay@ctnorwood.com.au` are the two platform admins** (2026-08-16).
Two on purpose — the delete guard refuses the last row. Verified as each: both laundries visible,
the ledger readable, and a non-admin still sees nothing.

**Both logins now resolve as `platform_admin`, not `super_admin`.** `requireSession()` checks
`platform_admins` first, so their memberships no longer drive their role. They default to
`Adelaide Towel Service` (first by name) and switch from the account menu. Memberships untouched;
delete the platform row to put either back to `super_admin`.

**Release is read-only on purpose.** `platform_migrations()` reads the ledger; there is no
function that applies one. The brief asked for schema updates from the app and this deliberately
stops short — CI and the Supabase console own DDL. Don't "finish" it without asking.

**Session resolution changed for everyone**, not just platform admins: `requireSession()` now
reads an `active_tenant` cookie and orders the membership query. The old `.limit(1)` with no
ordering (the §11 bug) is gone.

## Previously: monthly invoices bill the counter's laundry (`0018_laundry_pricing`)
The Jobs module carried no money since 0014, so a drop-off customer was never billed. Now the
monthly run makes one draft invoice per customer carrying **every item of every job completed
in the period, at that customer's price**, beside the contract charges it already produced.
CLAUDE.md §4/§7 and the 2026-08-16 entry have the detail; what to carry forward:

**Numbered 0018, not 0017** — `Prod` took 0017 for `archive_records` while this was in
flight, and that one is already applied live. `laundry_prices` is deliberately **not** in
`archivable_tables()`: a price list is configuration, not a customer's paperwork.

**Prices live in `laundry_prices`, one row per kind of laundry per scope.** `customer_id is
null` is the tenant default and a customer row overrides it — **there is no third fallback**.
The unique index is `(tenant_id, customer_id, item_type) nulls not distinct`, because under the
default NULL rule the *default* list is exactly the row that could be duplicated. Writes are
role-gated like 0006 and `apply_tenant_policy` is deliberately **not** used: its permissive
`for all` policy would OR with the role gate and let any member re-price the work.

**Unpriced is a reported outcome, never a zero.** `buildLaundryCharges` returns lines *and*
unpriced items with the reason and job number; the run reports them in a sticky toast linking
to `/invoices/prices`. The form parser (`prices/price-form.ts`, outside `"use server"`, tested)
holds the matching rule: **blank clears the row, it does not store zero.** If you touch either,
keep that distinction — a zero bills silently, a missing price is visible.

**A job is billed once, marked by `invoice_lines.laundry_order_id`.** The run skips any job
already on a non-void invoice. Voiding an invoice makes its work billable again, on purpose.

**Contracts are no longer a precondition of `generateInvoices`.** It used to refuse the whole
period when no contract covered it, which would now hold back every counter-only customer. The
customer set is contract customers ∪ customers with unbilled completed jobs.

**Period edges are composed in `BUSINESS_TIMEZONE`** (`toInstant(start)` … `toInstant(end+1)`),
because `completed_at` is a timestamptz and a 9pm finish on the 31st belongs to that month.

**0018 is applied to `laundrymart-syd` (2026-08-16)** and verified by rolled-back probe: RLS on,
both policies present, unique index `nulls not distinct`, trigger attached, and an `anon` read of
an inserted price returning 0 rows. No new security advisor.

**Watch this — there are two pricing designs in the live database.** The unmerged branch
`claude/customer-pricing-invoicing-sad9af` applied `0017_customer_pricing_billing` on 2026-08-15:
rate cards via `customers.rate_card_agreement_id` plus frozen `job_charge_snapshots`. It landed on
**exactly** the same `invoice_lines.laundry_order_id` (same FK, same partial index), which is why
0018 adds that column `if not exists` — without the guard it fails 42701 on the hosted database.
Its tables are **empty** and its code is unmerged, so only this design has screens behind it. That
branch needs a decision before anyone relies on either.

**Verification.** 325 unit tests, 131 pgTAP assertions, `verify` green, all migrations + pgTAP
+ seed applied to a fresh Postgres 16 in-container, price table asserted at eight widths in
`/design-preview` light and dark. **No live project** — no invoice has been generated with real
jobs on it. First thing on a live project: apply 0018, set the usual prices at
Invoices › Laundry prices, run one month, read the draft.

## Also live: hide the real records, reversibly (`0017_archive_records`)
**Applied to `laundrymart-syd`, and the real records ARE archived (2026-08-16).** 1,154 rows
hidden — 508 customers, 646 invoices. A signed-in user now sees only the demo tenant's 4
customers and 1 invoice. Nothing deleted; every row still on disk with its `archived_at` stamp.
Undo with `select public.set_records_archived('20000000-0000-4000-8000-000000000001', false);`
called as a super_admin of that tenant. CLAUDE.md §3, §11 and the 2026-08-16 changelog.

**Merged into `Prod`** (`f52116a`, PR #18, CI green), so `/admin/data` — Settings → Your
records — is deployed and the undo is a button. The SQL call above is the fallback.

**`Dev` is stale**: 15 commits behind `Prod` at the time of this merge, which is why this went
straight to `Prod` like the three features before it. Worth a catch-up merge before anyone
treats `Dev` as a staging branch again.

**The live project has two tenants and only one of them is real.** `Adelaide Towel Service`
(`20000000-0000-4000-8000-000000000001`) holds 508 customers and 646 invoices and **no jobs**;
`Harbour Commercial Laundry` is the demo seed. The real tenant also holds 1,515 supplier bills,
192 suppliers, 268 GL accounts and 636 import-activation rows from branches not merged here —
**those have no screens in this build, so they are already invisible and 0017 does not touch
them.** Both logins (`darshan@`, `jay@ctnorwood.com.au`) are super_admin of *both* tenants.

**Watch this:** `requireSession()` picks the membership with `.limit(1)` and **no ordering**,
so which of the two tenants a user lands in is effectively arbitrary. Pre-existing, unrelated
to this branch, and worth fixing before anyone relies on the demo/real split.

**The hiding is in the RLS policy, not in the queries** — `archived_at is null` appended to
every policy on nineteen tables. `with check` carries it too, which is *why* archive/restore is
`set_records_archived(t, archive)`, SECURITY DEFINER with the membership+role check inside:
once a row is archived nobody signed in can see it, so nobody signed in can clear the flag.
Call it on the **RLS-bound** client (needs a real `auth.uid()`), never the admin one.

**The rewrite is generic on purpose.** `apply_archive_policy()` reads each policy's expression
out of `pg_get_expr` and wraps it, because this repo's `invoices` policies and the live
project's are different shapes (§11) and restating either would have dropped the other's
tenancy predicate. If you add a table to `archivable_tables()`, that is the only place to add
it — the DDL loop, the stamper and the counts all read it, and `archive.test.ts` pins the
screen's labels to it from both directions.

**The service-role client is the one reader policies do not apply to.** `/api/notifications/
sweep` filters `archived_at` by hand for that reason. Any new admin-client read of customers,
jobs or invoices needs the same filter.
## Previously: roadmap Phase D — an owner can add their own people (no migration)
Invite by email, remove access, three role presets. CLAUDE.md §10c and the 2026-08-15
changelog entry have the detail; the parts worth carrying forward:

**The invite lands on `/auth/invite`, never `/auth/callback`.** Supabase returns an accepted
invitation with the session in the URL **fragment** (never sent to the server), and
`inviteUserByEmail` cannot use PKCE because the inviting browser is not the accepting one — no
code verifier is waiting. Pointing it at `/auth/callback` compiles, builds and dead-ends every
invitee on "link was invalid or expired". `/auth/invite` is therefore **the only
client-rendered screen in the app** and `src/lib/supabase/client.ts` the **only browser Supabase
client** — and that one reads `process.env.NEXT_PUBLIC_*` directly, deliberately unlike the
three server clients, because `lib/env` validates the service-role key and must not be bundled
for the browser.

**Removing access opened a lockout that granting never could.** Two administrators could each
demote or remove the other. `updateMembership` and `removeMember` both refuse the last
`admin.write` holder, counted against `rolesWith("admin.write")` — derived, never hand-listed.
A failed count reads as "not stranded", so a transient error refuses nothing.

**Role presets are presentation.** `ROLE_PRESETS` carries a `role`, never a capability list;
the database, `has_role()` and every policy know only the eleven roles. Replaced `COMMON_ROLES`.

**D2 (simple mode) was deliberately not built** — its premise was a 22-row rail, which the
2026-08-05 audit and the 2026-08-14 workflow change already removed. The `ui_mode` slot in
`tenants.settings` stays reserved. D3 and D4 shipped 2026-08-05, so Phase D is otherwise done
and the roadmap's remaining work is Phase E (customer portal, public tracking, Xero, bag scan).

**Untested end to end.** No Supabase credentials here, so the mail → redirect → fragment →
password round trip has never run. **First thing on a live project: add `<origin>/auth/invite`
to the allowed redirect URLs, then invite one real address and follow the link.**

**The workflow simplification is done, applied to `laundrymart-syd` and merged into `Prod`.**
CLAUDE.md §18 has the full entry; the short version:

```
Office:  Job → Driver → Delivery Date → Assigned
Driver:  My Runs → date → Confirm Load → Start Route → Open Job → Mark Delivered
```

**`0016_job_assignment` is the only migration.** Seventh status `assigned`;
`assigned_driver_id` + `assigned_delivery_date` (+ `assigned_at`, `assigned_by`,
`load_confirmed_at`, `load_confirmed_by`) on `laundry_orders`; four check constraints; two
indexes; both guard functions rewritten; the driver RLS clause widened. **Nothing dropped** —
`vehicle_inspections`, `daily_routes` and `jobs` are all intact.

**Two records of the assignment, on purpose, and the guard is what makes that safe.**
`assigned_driver_id`/`assigned_delivery_date` are the user-facing truth (what My Runs queries);
`stop_id → jobs.route_id → daily_routes` is the operational placement the depot load, the run
sheet and the inventory unload sweep still need. `guard_laundry_order_assignment` refuses every
disagreement, including **a job on a crewed run that names no driver** — on somebody's route
sheet, on nobody's My Runs. If you touch either side, that trigger is the thing to re-read.

**Watch this one:** `laundry_orders` now has **two FKs to `drivers`** (`pickup_driver_id`,
`assigned_driver_id`). Every `drivers(...)` embed on that table must be disambiguated by
constraint name or PostgREST rejects it with PGRST201 at request time — compile-clean and dead
in production, the same class as the 2026-08-05 ambiguous-embed outage. `/orders/:id` and
`/orders` are both explicit now; a new one will not be unless you make it.

**Runs only ever move forward, and the app is what enforces it.**
`guard_route_transition` refuses a start without a load and a close without an unload, but it
does **not** refuse a backwards move, and it does not protect `started_at` when the caller
passes a value. So `stampDepotLoad` filters to runs still at the depot with a null
`load_confirmed_at`, and `stampRouteStarted` filters to runs with a null `started_at` and a
confirmed load. Without those, the ordinary late-work flow (assign after the van has gone →
driver confirms again → starts again) walked a moving run back to `load_confirmed` and rewrote
the recorded departure time. If you add another day-level action, filter it the same way.

**Load confirmation is per job, not just per run.** Start Route dispatches only load-confirmed
jobs, so work assigned after the driver loaded the van stays `assigned` rather than being swept
out. `confirmRunJobsLoaded` (depot screen) and `confirmDayLoad` (My Runs) both write it, so the
two screens cannot disagree about what is on the van.

**Runs are invisible, not deleted.** `/routes/daily`, `/routes/planner`, `/routes/templates`
still work and still hold history, but no rail row and no screen links to them; `nav.test.ts`
asserts no navigation href starts with `/routes/` for any role. Drivers and Vehicles are under
a new **Fleet** area. If a future feature needs run planning back, it is all still there.

**Inspection is out of the workflow, data intact.** `submitInspection`,
`inspection-checklist.tsx` and `checklist.ts` deleted; the table, the column, the two route
statuses and the `inspection_failed` notification kind all stay for history.

**0016 is live** (ledger `20260814084223`). Its **statement order is load-bearing** because it
carries a backfill: transition guard replaced *before* the backfill, constraints and the
assignment guard *after*. The three pre-existing jobs were backfilled from the run chain and
verified; five guard probes were refused in one rolled-back block; no new security advisor.

**Verification state.** 286 unit tests, 118 pgTAP assertions, typecheck/lint/build green,
migrations + pgTAP + seed all applied to a fresh Postgres 16 in-container. My Runs screenshotted
light and dark at ten widths, no overflow, no sub-36px targets. **Not opened against a live
Supabase project** — this container has no credentials. The pre-existing sub-36px targets and
320px/1024px overflow in `/design-preview` come from the **dispatch planner** fixture, which
this branch does not touch.

**Still true from before:** `@typescript-eslint/no-unused-vars` is an error and it earned its
place again here — it caught six dead imports the moment the inspection stage came out.
Compose-locally-commit-once payload schemas stay outside `"use server"` files with tests
against what the producer really emits.
