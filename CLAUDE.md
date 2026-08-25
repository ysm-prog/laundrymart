# Electro Services — Project State & Change Management
> Customer-facing name since 2026-08-13. The repository, package and storage keys
> stay `laundrymart`; renaming those would orphan queued offline data on drivers' phones.

## 0. Update protocol
This is the canonical shipped state. MEMORY.md holds the live session delta (auto-loaded).
After any change to `src/` or `supabase/`, in the SAME commit: update the affected section
below and add a Changelog entry (newest on top). The Stop hook warns on drift.

`.claude/` carries this project's own agents and skills plus a selected subset of the
enterprise framework (v1.5.0): eight specialist skills, a `principal-architect` agent, four
workflow commands and nine standards. `.claude/README.md` is the index and
`.claude/FRAMEWORK.md` says what was taken, what was skipped and what supersedes it.
**This file beats `.claude/standards/`** — where a standard disagrees with a rule below,
follow this file and say so explicitly rather than applying the standard silently.

## 1. Overview
Commercial Laundry Management System — customers, service agreements, depot-aware routing,
an offline driver run, inventory and billing. Next.js 16 (App Router) + Supabase
(Postgres/RLS/Auth) + Vercel, AU (Sydney).

The master spec names a .NET 9 Web API; this build follows the supplied skeleton instead
(Next.js + Supabase, Server Actions in place of REST). The domain model is unchanged.

## 2. Architecture
- RLS-bound client `createClient()` (safe) vs service-role `createAdminClient()` (bypasses
  RLS — always filter `tenant_id`).
- Auth via `getClaims()` (local JWT verify, no network); `requireSession()` is memoised per
  request. `requireCapability()` guards pages; `assertCapability()` guards actions.
- Functions pinned to `syd1` to co-locate with the Sydney DB (vercel.json).
- The session refresh + auth gate is `src/proxy.ts` (Next 16's rename of `middleware`).
- Server Actions only for writes. They derive `tenant_id` from the session; `fail()`/`done()`
  set a one-shot flash cookie and redirect clean (always `return fail(...)` — the `return` is
  what lets TS narrow). Both take an optional `{ href, label }` link — used when a failure is
  a missing prerequisite, so the toast carries the screen that fixes it; the reader re-checks
  the href is a plain same-site path because the cookie is not httpOnly. `(app)/template.tsx`
  reads the cookie — a template, not the layout, because templates re-render on every
  navigation including a same-path action redirect — and `FlashToast` shows it (success
  auto-dismisses, errors stick) then deletes it. The one
  URL-param survivor is the auth gate's `?error=forbidden`, set during render where a cookie
  cannot be. `/api/sync` stays the one API exception for the offline outbox.
  **A rejection redirects, so the browser's copy of the form is gone**: an action that refuses
  a post is responsible for handing back the answers that cost real work to give. The job form
  does this for the customer, via the `?customer=` parameter its quick-create already uses.
- **`optionalText`/`optionalUuid`/`optionalDate` accept `null` as well as `""`.** An empty HTML
  input posts `""`, but a field composed in the browser and posted as JSON — the
  compose-locally-commit-once hidden field used by the job form, the contract wizard and the
  planner — spells the same absence `null`, because `JSON.stringify` drops `undefined` keys.
  `z.string().optional()` refuses `null`, and one such field took down a whole array parse.
- **Every compose-locally-commit-once payload schema lives outside its `"use server"` file**,
  in `orders/order-items.ts`, `agreements/wizard-lines.ts` and `routes/planner/plan.ts`, each
  with tests written against the shape its producer really emits. This is not tidiness: a
  `"use server"` module can export nothing but server actions, so these contracts used to be
  unreachable from a unit test — and **two of the three shipped broken and stayed broken behind
  a green `verify`** (the job form's items, the planner's whole board). A new hidden JSON field
  goes in a plain module with a test, never in the action. Mind what such a module imports:
  `plan.ts` is in the client bundle, so it may not reach `lib/actions` (→ `next/headers`), and
  that failure shows up only at `next build`.
- **The assignment model is `Job → Board → Delivery Date`, and it lives on the job.**
  `laundry_orders.assigned_board_id` + `assigned_delivery_date` (0016, retargeted by 0031) are
  the user-facing truth and what My Runs queries. A **board** is a standing delivery round with
  its own login; a **driver** is a person, kept beside it because
  `daily_routes.operated_by_driver_id` is how the business still answers "who was holding that
  parcel?". `assigned_driver_id` survives on jobs assigned before 0031 and is no longer written. `stop_id → jobs.route_id → daily_routes` (0015) survives as
  the *operational placement* — the depot load, the run sheet and the inventory unload sweep are
  all built on it — and is resolved by the server action, never chosen by a person. No run code
  appears in any office or driver screen. Two copies of one fact is normally the bug 0015 was
  written to avoid, which is why the guard trigger refuses every way they could contradict.
- Pure domain logic lives in `src/lib/domain/` with no database access: the service calendar,
  pricing, recurring invoicing (`invoicing.ts` — one contract's charges, and the
  `consolidate()` rule for header fields two contracts disagree on), laundry-job billing
  (`laundry-billing.ts` — a customer's effective price list, and one invoice line per item of
  laundry), ABN validation, date
  helpers, the laundry-job workflow (`laundry-orders.ts`), the run-assignment rules
  (`run-assignment.ts`) and the timezone conversion (`timezone.ts`). Unit-tested; shared by
  preview, route generation, invoicing, the jobs module and My Runs so they cannot diverge.
- **Two timezones, on purpose.** `BUSINESS_TIMEZONE` is `Australia/Sydney` and is what
  composes a stored instant (`received_at`), an invoice period and a notification's
  `occurred_on` — every row written since 0001 carries that decision, so it does not move.
  `OPERATIONS_TIMEZONE` is `Australia/Adelaide` and is the *operational day*: My Runs' default
  date, its arrows, and the day boundary a `timestamptz` is filtered against when answering
  "what happened on the 14th". Both live in `timezone.ts` and both read their offset out of
  `Intl`, so neither hard-codes +9:30/+10:30/+10/+11. `getAdelaideDayRange()` is the one to
  reach for when filtering a timestamp column by an operational day.
- Invoice PDFs render server-side with `@react-pdf/renderer` (`src/lib/pdf/`), streamed from
  `/api/invoices/:id/pdf` and attached to the Resend email. `serverExternalPackages` keeps the
  renderer out of the client bundle.
- **A person is shown by name, and the directory is one read** (`src/lib/directory.ts` over
  `tenant_members()`, 0030). Every `assigned_to`, `created_by`, `actor_id` and `delivered_by`
  column holds an `auth.users` id; the screens used to resolve those through the GoTrue admin
  API one id at a time, which can only ever return an address and which **failed outright for
  any login written straight into `auth.users`** — on this deployment, all eleven role profiles,
  every one of which rendered as a short UUID. `memberDisplayName()` in `lib/domain/members.ts`
  is the pure rule: the name they were invited under, then their linked driver record, then
  their address, then a short id — and **never a name invented out of an email local part**,
  because a wrong name reads as a different person. **Platform admins are filtered out of every
  list people are picked from and are *not* filtered out of name resolution**: a job one of them
  created still has to say so. That split is `staffMembers()` versus `memberNames()`, both pure
  and both tested.
- Notifications (`src/lib/notifications/`) have two writers and one reader. Server actions call
  `notify()` at the moment they cause an event, on the caller's RLS-bound client; the swept,
  time-based checks live in `/api/notifications/sweep`, which has no session and therefore uses
  the service-role client and filters `tenant_id` from the row it is iterating. Both go through
  one idempotent upsert keyed on `(tenant_id, kind, subject_id, occurred_on)`, and `occurred_on`
  is the day the *event* belongs to — the invoice's due date, the run's date — not the day the
  sweep ran, so a cron that runs five times a day still notifies once. The bell is a server
  component reading a head-only count in the `(app)` layout beside the nav badges: no realtime,
  no polling. `tenants.settings` (one jsonb bag, Zod-validated in `settings.ts`) gates every
  channel; in-app defaults on, customer email defaults off.

## 3. Multi-tenancy and authorisation
Tenant key `tenant_id` → `tenants`. RLS helper `is_member(tenant_id)`, wrapped `(select …)`
so it evaluates once per query. `apply_tenant_policy(table)` attaches RLS + index + trigger,
so a new table cannot ship without a policy.

Resource-scoped beyond tenancy:
- `daily_routes` / `jobs`: when the caller's role is `driver`, rows are filtered to their own
  `drivers.id` via `current_driver_id()`; when it is `board`, to their own `boards.id` via
  `current_board_id()` (0031). The two narrowings are independent terms, so no driver's
  visibility moved when boards landed.
- `pickups` / `deliveries` / `*_lines` / `vehicle_inspections`: scoped through the parent's
  own RLS, so a driver never reaches another driver's paperwork.
- `laundry_orders` (+ its items and activity, through the parent): tenant-wide for office
  roles; for a **driver-only** member, narrowed by 0015/0016 to jobs **assigned to them** or
  sitting on a stop of one of their own runs, and for a **board-only** member narrowed the same
  way by 0031. **0025's restrictive write layer carries the board carve-out too** — without it a
  board completing its own delivery matches zero rows and raises nothing, and the job sits at
  `out_for_delivery` for ever. My Runs is the first screen to give a driver a reason to read the table, and
  a tenant-wide policy would have handed them every customer's laundry through PostgREST at
  the same moment. No non-driver role's predicate changed.
- `invoices` and friends (+ `job_charge_snapshots`, `invoice_source_jobs`): **readable only through
  `can_read_billing()`** and writable through `can_write_billing()` since 0017. They used to be
  readable by *any* member, which since My Runs meant a driver's session could read every invoice
  amount off PostgREST. `service_agreement_lines` is narrowed the same way to `can_read_pricing()`
  — the agreement header stays open to `agreements.read`, because when a customer is served is
  operational information; only the prices moved. 0025's restrictive write policies AND on top of
  all of this. See §20.
- `laundry_prices` is role-gated the same way, but **the read half only since `0033`** — and this
  file said otherwise for two days, which is the part worth reading. 0018 gated who may *change* a
  price and left the read policy at `is_member(tenant_id)`: the identical shape 0006 shipped on
  `invoices` and that 0017 had replaced one migration earlier. So every member — driver, counter,
  warehouse, and from 0031 a board — could read every price the laundry charges. It hid because the
  table was **empty on every deployment** until a price list was first entered (2026-08-20), and
  because `laundry_pricing.test.sql` positively asserted *"the counter can read the tenant's
  prices"*: **a proof that encodes the defect defends it.** 0033 narrows the read to
  `can_read_pricing()` and splits 0018's permissive `for all` write policy into explicit
  INSERT/UPDATE/DELETE — because **a `for all` policy's USING half grants SELECT too**, so
  narrowing the read policy alone would have left the list readable through the write one to
  `dispatcher`. The same trap §22 records for 0017, one table later.
  `apply_tenant_policy` is deliberately *not* used on this table, because its permissive `for all`
  policy would OR with the role gate and let any member re-price the work.
- **`0028` exists because two migrations are numbered 0017 and filename order is not the order
  they went on live.** `0017_customer_pricing_billing` replaces the policies on the five billing
  tables and on `service_agreement_lines`; `0017_archive_records` wraps whatever policies it
  finds. Live, pricing went first and archiving wrapped it — correct. On a *fresh* database
  `0017_archive_records.sql` sorts first (`_` < `c`), so the rewrite landed after the wrap and
  dropped `archived_at is null` from twelve permissive policies — an archived invoice became
  readable again. `0028` puts the clause back, idempotently and on permissive policies only.
- `storage.objects` in the `run-media` bucket: the object key starts with the tenant id, and
  the policies read it back through `media_tenant()` → `is_member()`. The path is the boundary,
  so it is always written from the session and never from the request.
- **Archived records are invisible to everyone** (0017). Nineteen tables — a customer and the
  paperwork hanging off one — carry `archived_at`, and every policy on them ends
  `and archived_at is null`. Putting it in the policy rather than in the queries is what makes
  it true of the fifty-first query as well as the first fifty, and of anything reaching
  PostgREST directly. Two consequences that shape the code: `with check` carries the clause
  too, so **no ordinary session can archive or restore a row** — the entry point is
  `set_records_archived()`, SECURITY DEFINER, membership- and role-checked inside, called on
  the caller's *RLS-bound* client so `auth.uid()` is real; and **the service-role client is the
  one reader policies do not apply to**, which is why `/api/notifications/sweep` filters
  `archived_at` by hand. The policy rewrite is generic — `apply_archive_policy()` reads each
  policy's existing expression out of the catalogue and wraps it — because this repo and the
  hosted project disagree about what the `invoices` policies say (§11), and re-stating either
  shape would have dropped the other's tenancy predicate.
- `notifications`: RLS scopes them to the tenant, as everywhere. The `audience` capability on
  each row narrows them further to the people who can act on it — but that is a UI filter
  applied in `src/lib/notifications/query.ts`, layered on top of RLS and never instead of it.
- **The payable side and the chart of accounts are `purchases.*`, since `0036`** —
  `gl_accounts`, `suppliers`, `supplier_bills`, `purchase_orders`,
  `supplier_payments`, `import_activation_state`. All six shipped on
  `apply_tenant_policy`, so one permissive `for all … using is_member(tenant_id)`
  policy governed them: **every member could read the whole thing and rewrite it**
  off PostgREST — a driver, the counter, the plant floor. Not cosmetic:
  `current_balance` is on `gl_accounts`, so an open read was every account balance
  in the business. Probed as one of Adelaide's own `board` logins on 2026-08-25 —
  268 accounts including the owner's equity and every loan balance, 192 suppliers,
  1,515 bills worth $65,724 outstanding — and an UPDATE renaming `4-1600 Laundry`
  **succeeded**, because a `for all` policy's USING half grants the writes as well
  as SELECT. This is the same shape 0006 put on `invoices`, 0017 replaced, 0018
  repeated on `laundry_prices` and 0033 replaced: **the third time**. It hid for
  the same reason 0033's defect hid — the demo tenant has no accounts and no bills,
  so the 2026-08-20 board sweep read 0 from all six and they looked clean. **An
  empty table is not a proof.** The `for all` is dropped rather than supplemented,
  the 0033 trap one table set later. `can_read_purchases()` and
  `can_write_purchases()` name the `roles.ts` holders — which is what `/accounts`,
  `/suppliers` and `/bills` were always gated on, so no role lost anything it could
  reach through a screen — and are deliberately *not* derived from
  `can_read_billing()`: §3 keeps those two sets independent, a dispatcher holding
  `invoices.read` and no `purchases.*` and finance the reverse. The auditor reads
  and does not write, which is why read and write are separate role lists.
  **`0037` reached this same gate independently and its half was dropped in the
  merge** — see §27.
- `audit_logs` is **read by four roles and written by everybody** (0035). SELECT needs
  `super_admin`/`operations_manager`/`regional_manager`/`auditor` — the four that hold
  `admin.read`, the auditor being why it is a role list and not `admin.write`. INSERT stays open
  to any member, deliberately: `recordAudit()` runs on the *caller's* RLS-bound client at the
  moment they cause an event, so narrowing it would stop the log recording the very people it
  exists to record; `actor_id` is pinned to `auth.uid()` so nobody signs an entry as somebody
  else. There is **no UPDATE and no DELETE policy at all**, which with RLS on is what makes the
  trail append-only — 0001's `for all` had handed both to any member, so the log could be edited
  by the person it incriminates. Nothing in `src/` does either verb.

**A platform admin's session reads *every* laundry, so RLS is not the tenant filter for
them.** `is_member()` is true of every tenant for that role (0019) while every *write* in the app
is filtered to the laundry they are currently working in — so any read that feeds a write must
filter `tenant_id` explicitly or the two disagree. Left unfiltered it produced exactly that: a
job raised in one business against a customer of another, a run crewed by a driver who works
somewhere else, and an assignment that failed with "somebody else changed this job's driver"
because the tenant-filtered UPDATE matched no row. The rule is the one §2 already states for the
admin client, extended to the RLS-bound client wherever a platform admin can be the caller:
**pickers, lookups and anything whose id is posted back must name the tenant.** The 2026-08-18
entry has the list of what was fixed; the sweep is not finished (§23).

**`platform_admin` is the one role above tenancy** (0019). It is not a membership — it is a row
in `platform_admins`, a table with **no `tenant_id`**, and the check constraint on
`memberships.role` deliberately refuses the value. It reaches every laundry because
`is_member()` and `has_role()` each gained `or public.is_platform_admin()`; widening those two
helpers rather than rewriting policies is what makes it retroactive, reach code not yet
written, and — critically — leave the `invoices` policies alone, which this repo and the hosted
project still disagree about (§11). `is_driver_only()` gained `and not is_platform_admin()` so a
platform admin who also holds a `driver` membership somewhere is never narrowed to that run.
`platform.read`/`platform.write` are held by this role alone: every tenant role is built from
`TENANT_ALL` (= `ALL` minus the platform block), so a capability added to that block cannot leak
into `super_admin` by default. `MEMBERSHIP_ROLES` is the app's copy of the column's check
constraint and is what the People picker and both membership actions validate against —
`ROLES` is the twelve, `MEMBERSHIP_ROLES` the eleven a row can hold.

Roles and capabilities are declared once in `src/lib/roles.ts` and drive the nav, page guards
and action guards. **The financial ones (`pricing.*`, `billing.*`, `invoices.approve/send/bulk`)
are backed by RLS as well and held by no operational role — see §20.**
`ROLE_PRESETS` names three of the eleven in an owner's words — Owner
(`super_admin`), Office (`operations_manager`), Driver — and is **presentation only**: a preset
carries a `role`, never a capability list, so there is exactly one answer to "what can this
person do". `rolesWith(capability)` is derived, and is what the People screen uses to refuse the
change that would leave a tenant with nobody holding `admin.write`. **`purchases.*` is "whoever writes money records, except the dispatcher"** — the same holders as
`invoices.*` minus that one role, who bills the work they plan and has no business seeing what
the laundry pays its suppliers. Worth stating because most holders arrive by deriving from
`TENANT_ALL` rather than by being named, which is how a capability added to `roles.ts` quietly
reaches six roles; `roles.test.ts` pins the two sets against each other so a change to either
fails a test rather than handing somebody the chart of accounts. `orders.*` follows the same split as routes: `write` creates and edits a
laundry job, `status` walks it through the workflow, and `manage` is the supervisor's
set — cancel a job, backdate a receipt, edit one already completed. **`super_admin`,
`operations_manager` and — since 2026-08-24 — `customer_service` hold the first three;
`manage` is the first two alone.** The counter's `orders.*` had been taken away by 0025 and was
given back because the alternative was making a counter hand an Office manager, which is 31
screens to do the one job their role is named for (§26, now closed). `orders.manage` stayed
where it was: cancelling a job and backdating a receipt are not part of taking laundry in.
`driver` and `board` hold none of them — counter jobs are not stops on a run — and
`warehouse_operator` holds none either, having lost `orders.status` in 0025; the floor runs
every warehouse stage and no longer walks the customer's job along behind it. **Restoring the
counter needed `0034` as well as `roles.ts`**, because 0025's restrictive write policies are the
actual boundary and a capability without a policy writes zero rows in silence. `routes.write` (plan and assign) is separate from `routes.status` (advance
a run that is already out): the latter also goes to `driver` — RLS confines them to their own
run — and to `customer_service`, so a stuck run is not waiting on a dispatcher.
**`routes.sequence` (0036) is separate again, and narrower than both**: it is the order a board
drives its day in, held by `super_admin` and `operations_manager` alone. The client's rule is
that management determines the order and drivers execute it, and `routes.write` was the wrong
authority for it — `dispatcher`, `branch_manager` and `regional_manager` all hold that. It is
named in a `RUN_SEQUENCE` block and *subtracted* from the roles derived from `TENANT_ALL`, the
same mechanism `JOB_TO_INVOICE` uses and for the same reason: a capability merely not mentioned
is a capability six roles quietly hold. `can_write_run_sequence()` is the database's copy of the
same sentence — see §4 and §28.

### 3a. Test role profiles
`npm run seed:roles` provisions **one login per role** so a capability change can be checked by
signing in rather than by reading `roles.ts`. `scripts/role-profiles.mjs` is the list (plain
JS — the runner is bare Node with no build step, and `role-profiles.test.ts` imports that same
file, so there is no second copy); `scripts/seed-role-profiles.mjs` is the runner. Addresses are
`<role-with-hyphens>@roles.example.com` — reserved by RFC 2606, so a stray invitation or overdue
chase aimed at a test profile can never leave the building — and the shared password is printed
on every run. **The exception is the owner, who is `owner@roles.example.com` and not
`super-admin@`**: a profile may carry an `email` local part, and `super_admin` does, because
"Owner" is what `ROLE_PRESETS`, the People picker and the profile's own name all call that role.
Deriving the address from the role *identifier* made the one string an operator has to type the
only place in the app that said "super-admin", and an owner working from a list of test logins
typed `owner@` and was told their details were invalid — true, and useless. A moved profile also
carries `formerly`, which the runner looks it up under, so a rerun **renames** the same login
(keeping its id, its membership and every row pointing at it) rather than leaving a second owner
behind at an address nothing mentions. Needs `SUPABASE_SERVICE_ROLE_KEY`: creating a login is an Auth admin call and the
membership insert writes a `tenant_id` no session is bound to, so every statement in it filters
`tenant_id` by hand.

Four decisions worth keeping:
- **Idempotent, and that is also the recovery path.** An address that exists is reused and its
  password reset, so a rerun is how you get back a test login nobody wrote down.
- **`platform_admin` is opt-in (`--platform-admin`), not part of "all the roles".** It is not a
  membership (0019) and it reaches *every* laundry on the project — on this deployment that
  includes the real tenant beside the demo one, so it is not a demo-tenant test login at all.
- **The driver profile gets a `drivers` row.** A `driver` membership with no such row leaves
  `current_driver_id()` null, every driver-scoped policy then matches nothing, and the result is
  a login that works with empty screens — which reads as a bug in My Runs.
- **`--remove` deletes a login only when this script's grants were the whole of it**, and
  unlinks the driver row rather than deleting it, because runs and stops point at it.

`role-profiles.test.ts` pins the list against `ROLES`, so a twelfth role added to `roles.ts`
fails a test rather than shipping with no way to be signed in as.

**The eleven live profiles were written by SQL rather than by this script, and the owner's
decision (2026-08-20) is to keep them as they are.** Do not "correct" the provenance by
re-provisioning or by reverting the `owner@` rename. They were checked against a login Supabase's
own Auth API created (`jay@`) and match it in every column GoTrue reads — `aud`/`role`, confirmed,
all seven token columns `''` rather than NULL (the 2026-08-18 trap), `email_change_confirm_status`
0, `app_meta`, a bcrypt `$2a$` hash and exactly one email identity. The only difference is a
missing `role_profile_note` in `user_metadata`, which **nothing in `src/` reads** — the script
writes it as documentation. Running `npm run seed:roles` from a machine holding the service-role
key remains the way to reset or re-assert them through the Auth API, but nothing is waiting on it.

## 4. Business rules enforced in the database
- Run cannot start without `load_confirmed_at`; cannot close before `unloaded_at`
  (`guard_route_transition`). The vehicle inspection is recorded and surfaced but is **not**
  a gate — 0012 dropped that check, because only a driver on `/run` can create an inspection
  and a run without one had no legal transition out of `inspection_pending`.
- Items on an active agreement cannot be soft-deleted (`guard_item_soft_delete`).
- Customer / agreement / job / invoice / credit-note numbers come from `next_number()`.
- **A delivery takes its linen from the van if the van has it, and from the run's depot
  otherwise** (`lib/routes/delivery-stock.ts`). Deliveries used to draw from `in_transit`
  unconditionally, and **nothing ever puts clean linen there**: `unload.ts` sweeps
  `in_transit → at_depot` when a van returns, but `confirmLoad` records no movement at all, so
  the only writer of `in_transit` is a *pickup* — the dirty linen going the other way. Every
  delivery therefore failed with `only 0 of that item are in transit`. A short van falls back
  whole rather than splitting, so one delivery line stays one ledger row. A real load manifest
  (which would record the depot hop when it happens) is deliberately not built: the load step
  captures no quantities, because the counts are taken at the door.
- `move_inventory()` is the single entry point for stock changes: it upserts both pools and
  writes the ledger row in one transaction.
- `recalculate_invoice()` keeps invoice totals consistent with lines and payments.
- **Recurring invoicing is one invoice per customer per period**, carrying every contract
  they hold **and every laundry job they had completed in it**. Not a preference: the weighed
  collections and the damaged/missing linen are recorded against the *customer*, so one
  invoice per contract would bill the same kilograms and the same lost towels once per
  contract. Each contract's minimum, levy and surcharges are still computed against its own
  services only; every line keeps its `agreement_id` (null for replacement and laundry
  charges, which belong to no contract) and a laundry line keeps its `laundry_order_id`.
  **A customer with no contract at all is invoiced when they handed laundry over the counter**,
  which is why contracts are no longer a precondition of the run.
- **Laundry is priced per customer, and a missing price is reported rather than billed at
  zero.** `laundry_prices` (0017) holds one row per kind of laundry either for a customer or
  for the tenant (`customer_id is null`); the customer's own row wins, the default is the only
  fallback, and there is no third. A kind of laundry nobody has priced comes back from
  `buildLaundryCharges` as *unpriced*, with the reason and the job number, and the monthly run
  says so in a toast that sticks — a silently missing line looks exactly like laundry that was
  never taken in. A bulk lot bills by the bag when a bag rate is set and the bags were counted,
  otherwise by the counter's estimate; a lot with neither cannot be priced and says so.
- **A laundry job is billed exactly once.** `invoice_lines.laundry_order_id` is the record of
  it: the generator skips any job already carried on an invoice that is not void, so a job
  finished near a period boundary cannot be billed by two runs. Voiding an invoice makes its
  work billable again, which is what voiding is for. Archiving (0017) hides a job and the
  invoice lines that bill it in the same call, so the two halves of this check can never
  disagree — the generator reads both through the RLS-bound client.
- **A job's laundry names an item, and the item decides what kind of laundry it is**
  (`sync_laundry_item_type`, 0032). `item_type` is what three pricing tiers, every report and
  every pre-0032 row match on; `item_id` is the coded item. A trigger derives the first from the
  second, so a job of TOW001 filed as "sheets" — which would be priced at the sheet rate with
  nobody able to see why — is impossible however the row is written. An item with no
  `laundry_category` leaves the caller's own answer, because "this is a rented tablecloth" is not
  an answer to "what kind of laundry is this".
- **A laundry job's seven statuses are enforced by `guard_laundry_order_transition`**, not just
  by the screen: no skipping the middle, no going backwards, `completed`/`cancelled` terminal,
  a customer pickup never reaches `assigned` or `out_for_delivery`, a delivery job must be
  assigned to a driver before it goes out, and it cannot be completed off the shelf. The one
  backwards edge is `assigned → ready_for_delivery`, which is Remove Assignment: the trigger
  clears the four assignment columns and the stop with it, so no half-assignment can survive. The trigger stamps `completed_at`/`cancelled_at`, so no client can record a
  finished job with no finishing time. Overdue is **not** among the statuses — it is
  `due_date < today and status not in (completed, cancelled)`, computed every time it is
  asked, where `due_date` is a generated column (delivery date, or collection date for a
  pickup job). A job's laundry list is replaced through `save_laundry_order_items()`, one
  transaction, because a delete-then-insert over PostgREST has a window with no items in it.
- **A job is assigned to a Board and a Delivery Date, and the two records of that cannot
  disagree** (`guard_laundry_order_assignment`, 0016 retargeted by 0031). Eligibility first: a
  customer pickup is refused outright, so is a job still in the plant and a completed or
  cancelled one, the board must be an active board of the same tenant, and the stop has to belong
  to the same tenant *and* the same customer. Then coherence: the stop's run must name the same
  board and the same date, and — the case worth naming — **a job on a crewed run must name a
  board**, since otherwise it sits on somebody's route sheet and on nobody's My Runs. Four check
  constraints hold the rest, each restated by 0031 to accept **either** assignee so no historical
  row is invalidated: `assigned` requires an assignee and a date, an assignee requires a
  non-ready status, an assignee and a date travel together, and a customer pickup has neither.
  **Every assignment written from 0031 on names a board**, refused by the guard rather than by a
  constraint — the guard fires only when an assignment changes, so history is never re-judged. The guard fires only when the stop or the assignment
  changes, so completing an assigned job never re-runs eligibility.
- **The order of a run may only be changed by the office, and a worked stop cannot move at all**
  (`guard_job_sequence`, 0036). `jobs` is published on `/rest/v1/jobs` and `jobs_access` is a
  single permissive `for all` policy, so before this **a driver could PATCH the sequence of the
  run they were standing in** and anybody else in the laundry could PATCH any run's — proved by
  probe, not by reading. A trigger rather than a restrictive policy because the rule is about
  *one column*: RLS is row-level, and a driver must go on writing `progress_status` and
  `arrived_at` on their own stops. It also refuses **out loud** (42501), where a restrictive
  policy writes zero rows in silence — the failure this project has shipped twice. It fires only
  on UPDATE of `sequence`, so assigning a new stop (an INSERT, appended at the end) is untouched.
  `guard_run_sequence_control` protects the lock and the version on `daily_routes` the same way,
  or a board could simply unlock its own run and walk past the first guard.
- A production batch cannot start with an empty manifest, cannot be completed except from
  `ready_for_dispatch`, and cannot be reopened once finished (`guard_batch_transition`). Its
  manifest freezes when it leaves receiving — only `rejected_quantity` and notes stay writable
  (`guard_batch_line_change`), because everything else drove a stock movement.

## 5. Branch & deploy
Feature branch → `Dev` → `Prod`. CI (`Prod`/`Dev`) runs verify, gitleaks and the DB job
(migrations + pgTAP + seed); the Vercel build runs the same verify gate and only those two
branches deploy. Never force-push `Prod`.

## 6. Routes
`/` landing · `/login` · `/auth/callback` · `/auth/invite` · `/offline` · `/api/sync` ·
`/api/media` · `/api/invoices/:id/pdf` ·
`/api/notifications/sweep` (cron, bearer-token authed, no session)
`(app)`: `/dashboard` · `/my-runs[/jobs/:id]` · `/runs` · `/boards` ·
`/billing[/:customerId]` ·
`/customers[/new|/:id|/:id/edit|/:id/prices]` · `/agreements[/new|/:id]` ·
`/invoices/awaiting` (the billing queue — a list of *jobs*, under Money because the decision is a
billing one; `sectionFor` takes the longest match so it lands there rather than on the register;
Price Selected → Approve Selected → Generate Selected) ·
`/orders[/new|/:id|/:id/edit]` ·
`/items[/:id]` · `/drivers` · `/vehicles` · `/routes/templates[/:id]` ·
`/routes/daily[/:id|/:id/sheet]` · `/routes/planner` · `/jobs[/:id]` ·
`/operations/{pickups,deliveries,exceptions}` · `/run` · `/warehouse[/:id]` · `/inventory` ·
`/invoices[/:id|/prices]` · `/reports` · `/search` · `/help` · `/notifications` ·
`/admin` (redirects) `[/depots|/users|/holidays|/audit|/notifications|/data]` ·
`/platform[/admins|/settings|/release]` (platform admin only)

**There is no user-facing Runs module.** `/routes/daily`, `/routes/planner` and
`/routes/templates` still exist, still work and still hold their history, but **no rail row
points at them** and no office or driver screen links to one. Nobody creates, opens or manages
a run: a job is given straight to a driver and a date, and the `daily_routes` row underneath is
found-or-created by `assignJobToDriver`. `nav.test.ts` asserts, for every role, that no
navigation href starts with `/routes/`. Drivers and Vehicles were tabs under the old Runs area
and are not run management, so they moved to their own **Fleet** area rather than vanishing
with it.

**"My Runs" (`/my-runs`) is a board's whole workspace**: the jobs assigned to that round for a
date it chooses, grouped To deliver / Out for delivery / Completed, in the order the office set
and with each stop's position printed on the card, with Confirm Load and Start Route in front of
them. Gated on `routes.read` so a manager can open it for a board.
`/run` survives as the second tab ("At the depot") because it owns the offline outbox, the
service worker and the unload inventory sweep, and is the one screen that must work with no
signal.

**The rail is three collapsible groups** (2026-08-24): "Day to day" open, "Customers & money"
and "Set-up & reports" shut, Help pinned outside them — 12 flat rows down to 6 visible for an
owner. This softens the "one flat list, no headings" rule below and does not undo it: the
*screens* inside an area are still tabs, never rail rows. `navigationFor()` still returns one
flat list and `groupNavigation()` arranges it for the rail alone, so `sectionFor` and the tab
strip are untouched. An area in no group falls through to the ungrouped rows rather than
vanishing; the group a person is currently inside always draws open; the shut groups ride an
`es_nav` cookie read in the layout.

**Navigation is data** (`src/lib/nav.ts`): eleven areas, each with optional `children`
rendered as a tab strip (`SectionNav` in the layout, not per page). An area is visible
when any screen inside it is, and `navigationFor()` resolves its href *and capability*
together to the first screen the role can open — so a row never links somewhere the auth
gate would bounce. `sectionFor()` (longest match wins) decides which rail row highlights
and which tabs show, so detail routes stay inside their area. `capability` is optional:
omitted means every signed-in member, which is what `/dashboard` and `/help` need since no
single capability is held by all eleven roles. **`/orders` and `/jobs` are two different things and both keep their rail row**: `/jobs` is a
visit on a driver's run, `/orders` is a customer's laundry from counter to hand-back. They were
labelled "Jobs" and "Stops", which is the arrangement the 2026-08-24 review found to be the
single largest vocabulary blocker — both read as "a job somebody has to do", and telling them
apart needed the glossary. They are **"Customer laundry"** and **"Driver visits"** now. The
decision §6 records is unchanged: both rows stay, and the route path is still `/orders` because
0004 already took `/jobs` — the same label-is-not-the-route arrangement as Contracts
(`/agreements`) and Linen (`/inventory`). `/help` defines both words. **Invoices is now "Money", with both sides of the ledger**: the register and `/invoices/prices`
as before, plus `/bills`, `/suppliers` and `/accounts` from the MYOB import, gated on the
separate `purchases.read` — a dispatcher holds `invoices.read` so they can see whether a
customer is on stop, which is no reason to show them what the business pays its suppliers.
It was previously **an area with two tabs** — the register and
`/invoices/prices`, the tenant's laundry price list — because what the monthly run charges is a
billing decision, not a setting. A customer's own prices live on their record
(`/customers/:id/prices`), reached from the customer page rather than from a tab, since it is
one customer's exception to the list. `/notifications` (the bell's list) is
deliberately off the map — the bell is its entry point, so it needs no rail row and
renders no tab strip. Tested in `src/lib/__tests__/nav.test.ts`.

## 7. Schema
- `0001_init` — tenants, memberships, RLS helpers, `apply_tenant_policy`, number sequences,
  audit logs.
- `0002_operations_core` — depots, customers, locations, contacts, items, vehicles, fuel
  logs, drivers.
- `0003_service_agreements` — public holidays, agreements (jsonb patterns, holiday rules,
  versioning), priced lines, item-delete guard.
- `0004_routing_execution` — route templates and stops, daily routes, vehicle inspections,
  jobs, pickups/deliveries and their lines, additional charges, run-transition guard,
  driver-scoped RLS.
- `0005_inventory` — pools, movement ledger, `move_inventory()`, stock counts, containers.
- `0006_billing` — invoices, lines, payments, credit notes, `recalculate_invoice()`,
  role-gated write policies.
- `0007_media` — the private `run-media` bucket, `media_tenant()`, and tenant-scoped policies
  on `storage.objects`.
- `0008_invoice_delivery` — `invoices.emailed_to`, stamped at send time.
- `0009_warehouse` — production batches and their manifest lines, stage/manifest guards.
- `0010_function_hardening` — tenant check inside `next_number()`, pinned `search_path`.
- `0011_revoke_public_execute` — closes the implicit PUBLIC grant on `public` functions.
- `0012_optional_inspection` — `guard_route_transition` no longer requires `inspection_id`
  to start a run. Restates the pinned `search_path` (a `create or replace` drops it) and the
  revoke, then asserts `anon` still cannot execute it.
- `0014_laundry_orders` — the counter's job: `laundry_orders` (+ generated `due_date`),
  `laundry_order_items`, `laundry_order_activity`, the transition and cancelled-items guards,
  and `save_laundry_order_items()` for the atomic child-set replace. Adds nothing to 0001–0013.
- `0015_run_assignment` — `laundry_orders.stop_id` (the one link between the counter's Job
  and a driver's Stop), its two indexes, three new `laundry_order_activity` verbs, the
  eligibility guard, and the driver clause on the three laundry policies. One column; no table.
- `0016_job_assignment` — the seventh status `assigned`; `assigned_driver_id`,
  `assigned_delivery_date`, `assigned_at`, `assigned_by`, `load_confirmed_at`,
  `load_confirmed_by` on `laundry_orders`; four integrity constraints; two indexes; rewritten
  transition and assignment guards; the driver RLS clause widened to include a direct
  assignment. **Adds no table and drops nothing** — `vehicle_inspections`, `daily_routes`,
  `jobs` and every historical row on them are untouched.
- `0018_laundry_pricing` — `laundry_prices` (one row per kind of laundry per customer, or per
  tenant when `customer_id is null`; unique `nulls not distinct`, so the default list cannot
  hold two prices for one kind) and `invoice_lines.laundry_order_id`, the billed-once link.
  Role-gated writes like 0006. **Adds no trigger, drops nothing and touches no existing row.**
  It is deliberately *not* in `archivable_tables()` (0017): a price list is configuration, not
  a customer's paperwork, and it carries no name or address to hide. Since the rate card was
  adopted this table is the **fallback tier**, not the primary one — see §21.
- `0017_customer_pricing_billing` — the money half of a job. `customers.billing_method`,
  `rate_card_agreement_id`, `xero_contact_id/_name`; `service_agreement_lines.laundry_item_type`;
  `laundry_orders.billing_status` (+ approval stamps and an exclusion reason);
  `job_charge_snapshots` and `invoice_source_jobs`; `invoices.source_job_id` and four `xero_*`
  columns; `invoice_lines.laundry_order_id`; four guards, two functions
  (`save_job_charge_snapshot`, `freeze_job_charges`), three RLS helpers, and narrowed read
  policies on every billing table. **Adds no operational behaviour and drops nothing.**
  **Statement order is load-bearing** for the same reason 0016's is: the billing columns are added
  and backfilled (cancelled → `not_billable`, completed → `awaiting_review`) *before* the guard
  that polices them, because those are not transitions — they are what was already true.
  **Applied live on 2026-08-15, seven months of code later** — the branch it came from sat
  unmerged until 2026-08-17 (§21), which is why §11 recorded two rival schemas for a while.
- `0017_archive_records` — `archived_at` + a partial index on the nineteen customer/job/
  invoice record tables, and `archived_at is null` appended to every policy already on them.
  Adds no table, drops nothing, and changes no row until somebody asks. The three functions
  are `archivable_tables()` (the list, stated once and read by both the DDL loop and the
  stamper), `set_records_archived(t, archive)` and `archived_record_counts(t)`.
- `0030_member_directory` — **`tenant_members(t)`: one laundry's people, with their names.**
  A definer function returning `user_id`, address, the name out of `auth.users.raw_user_meta_data`,
  the linked driver's name, role, site and an `is_platform_admin` flag, for a tenant the caller
  belongs to (`is_member`, raising 42501 otherwise). Adds no table, no column, no policy, and
  changes no row. It exists because `auth.users` is unreadable by an ordinary session and
  PostgREST does not publish it — the same reason `platform_migrations()` (0019) and
  `archived_record_counts()` (0017) are shaped this way. **Scoped by argument, which is the
  other half of the fix:** `memberships` under RLS returns *every* laundry's rows to a platform
  admin (0019), so the screens that read it directly listed one person once per laundry.
- `0029_revoke_anon_table_grants` — **`anon` may not touch a table in `public`, and no future
  table hands it one back.** Revokes all table/sequence/function privileges from `anon`, then
  rewrites the **default privileges** that were re-granting them on every new table. Adds no
  table, changes no row, and touches neither `authenticated` nor `service_role`. Asserts its own
  outcome three ways (no table grant, no executable function, RLS on everywhere), so it fails
  rather than half-applying. `usage on schema public` is deliberately left granted — with nothing
  in the schema reachable, keeping it makes a future mistake read as "permission denied for
  table" rather than a confusing schema error. The `storage`, `graphql` and `graphql_public`
  default ACLs are deliberately untouched: they are Supabase's own, and `storage.objects` is
  where 0007's media policies live.
- `0028_archive_billing_policies` — puts `archived_at is null` back on the twelve **permissive**
  policies that `0017_customer_pricing_billing` replaced. Needed only because the two 0017s apply
  in filename order on a fresh database and in timestamp order live, and those orders disagree;
  see the §3 note. Touches no restrictive policy (0025's), adds nothing and changes no row. It
  asserts its own outcome, so it fails rather than half-applying.
- `0031_boards` — **the round, not the person.** `boards` (a standing delivery
  round with its own login), `laundry_orders.assigned_board_id`,
  `daily_routes.board_id` + `operated_by_driver_id`, `current_board_id()`,
  `is_board_only()`, the twelfth value on the `memberships.role` check
  constraint, four restated integrity constraints, three rewritten permissive
  policies and 0025's three restrictive `laundry_orders` policies widened.
  **Drops nothing and invalidates no row**: `assigned_driver_id` keeps every
  historical job's driver, and the constraints accept either assignee. New
  assignments must name a board, enforced by the guard — which fires only when an
  assignment changes, so history is never re-judged. `apply_tenant_policy` and
  **not** `apply_archive_policy`: a board is configuration, like a depot.
- `0032_item_master` — **one item vocabulary.** `items` gains `item_code`,
  `description`, `is_sell`/`is_buy`, `sell_price`/`cost_price`, `tax_code`,
  `laundry_category`, `myob_item_id`/`myob_item_code`, `external_synced_at`;
  `laundry_order_items.item_id`; `laundry_prices.item_id` and a rewritten unique
  index; `sync_laundry_item_type()` and its trigger; `save_laundry_order_items()`
  carrying `item_id` through. `item_code` is backfilled from `sku` and asserted
  non-null afterwards. **Adds no table, drops nothing and invalidates no row.**
- `0033_laundry_prices_read` — **the read half of 0018's role gate, which was never
  written.** Replaces `laundry_prices_read` (`is_member`) with `can_read_pricing()`,
  and splits the permissive `for all` `laundry_prices_write` into explicit
  INSERT/UPDATE/DELETE policies so no USING half is a second door onto SELECT.
  Self-asserting on both halves. Adds no table, no column, no function and no
  capability, and changes no row. Narrows no write: 0025's restrictive layer
  already ANDs `super_admin`/`operations_manager` on top. Not in
  `archivable_tables()`, so there is no `archived_at` clause to preserve — the
  0028 trap does not apply.
- `0034_counter_takes_jobs` — **the half of the counter's role that lives in the
  database.** Widens `0025`'s restrictive write layer on `laundry_orders`,
  `laundry_order_items` and `laundry_order_activity` to admit `customer_service`,
  restating 0025's driver carve-out and 0031's board carve-out verbatim because a
  restrictive policy has no existing clause to wrap. Leaves the other six of 0025's
  nine untouched — billing did not move. DELETE is granted on the item rows only
  (`save_laundry_order_items()` is SECURITY INVOKER and replaces the child set) and
  withheld on the job, which nothing in the app deletes. Four self-assertions,
  including that the counter did **not** reach billing and that both carve-outs
  survived the rewrite. Adds no table, no column, no function; changes no row.
- `0035_audit_log_read` — **the activity log is for the people who answer for it.**
  Drops 0001's `audit_logs_member` (`for all … using is_member`) and replaces it with
  `audit_logs_read` (SELECT to the four `admin.read` roles, auditor among them) and
  `audit_logs_write` (INSERT to any member, `actor_id` pinned to `auth.uid()`).
  **No UPDATE and no DELETE policy at all** — with RLS on, the absence is the refusal,
  so the trail is append-only. The `for all` is dropped rather than supplemented,
  because its USING half grants SELECT too (the 0033 trap, one table later). Five
  self-assertions. Adds no table, no column, no function; changes no row.
- `0036_invoice_account_codes` — **an invoice line says where the money lands, and
  the payable side stops being everybody's.** `can_read_purchases()` /
  `can_write_purchases()`; the six payable tables' single permissive `for all`
  policy replaced by explicit SELECT + INSERT/UPDATE/DELETE gated on them;
  `items.income_account_id`; `invoice_lines.gl_account_id` + `account_code`; two
  partial indexes; `sync_invoice_line_account()` and its trigger. **Adds no table,
  drops nothing and changes no row.** None of the six is in `archivable_tables()`,
  so there is no `archived_at` clause to preserve — the 0028 trap does not apply.
  Six self-assertions.
- `0036_run_sequence_control` — **the order of a run is management's decision, and the
  database says so.** Four columns on `daily_routes` (`sequence_locked`, `sequence_version`,
  `sequence_updated_by`, `sequence_updated_at`), `can_write_run_sequence()`, the two guard
  triggers §4 describes, `apply_run_sequence()` (Save & Lock, one transaction) and
  `compact_run_sequence()` (the gap-closer). **Adds no table, drops nothing and invalidates no
  row**: every column's default describes what was already true — the order has always been the
  office's, and nobody has moved it yet. `daily_routes` is not in `archivable_tables()`, so the
  0028 trap does not apply. Self-asserting on all five outcomes, including that
  `can_write_run_sequence` does *not* name the dispatcher.
  **Numbered 0036 twice**: this file and `0036_invoice_account_codes` came from two branches the
  same afternoon and both are live under that number. Filename order puts `_invoice_` first
  (`i` < `r`), which is also the order they were applied, so nothing depends on renumbering —
  recorded here rather than fixed, the same call §7 makes about the two 0017s.
- `0037_account_and_item_codes` — **the Owner keeps the codes, and the codes reach Xero.**
  `gl_accounts.xero_account_code`; `items.xero_item_code`;
  `xero_connections.sales_account_code`/`_name` with `xero_connection_status()` re-created to
  carry them. **Adds no table, drops no column and changes no row.** Every new column is
  nullable and null, so an item nobody has coded pushes exactly the payload it pushed before.
  **Its policy half was removed in the merge and that is the interesting part**: as written it
  also created `can_read_accounts()`/`can_write_accounts()` and four `gl_accounts` policies —
  which `0036_invoice_account_codes` had already created, with *identical* role lists, across
  all six payable tables. Applying both failed outright (`42710: policy "gl_accounts_read" …
  already exists`), so 0036's gate stands and this file asserts against it instead. `items.income_account_id` is
  likewise 0036's; this file no longer re-adds it. See §27.
- `0013_notifications` — `tenants.settings jsonb` (AD-3) and the `notifications` table
  (AD-4). Beware the numbering drift: the unmerged branch
  `claude/warehouse-inventory-flow-psooyq` carries its own `0012_return_count.sql`, which
  has to be renumbered when it lands.

- `0019_platform_admin` — `platform_admins` (**the one table with no `tenant_id`**),
  `platform_settings` (one row, jsonb), `is_platform_admin()`, the `or is_platform_admin()`
  clause on `is_member`/`has_role` and the `and not` on `is_driver_only`, a write policy on
  `tenants` (0001 shipped a select policy and nothing else, which is why laundries were seeded
  by hand), a last-administrator delete guard, and the read-only `platform_migrations()`.
  **Rewrites no policy, drops nothing, and changes no row**: with no `platform_admins` rows
  every added predicate is `or false`, which is what lets the eleven existing proofs pass
  unchanged. `apply_tenant_policy` is deliberately not used — its whole job is a tenancy
  predicate and there is none here. There is deliberately **no function that applies a
  migration**; the Release screen reads the ledger and nothing more.

- `0025_main_flow_owner_office` — **restrictive** write policies on the nine job→invoice
  tables (applied live 2026-08-16), narrowing INSERT/UPDATE/DELETE to `super_admin` and `operations_manager`.
  Restrictive rather than a rewrite precisely because of the §11 divergence: this repo's
  `invoices` policies carry 0006's inline `has_role` and the hosted project's use
  `can_write_billing`, and a restrictive policy ANDs with whichever is there without reading
  or replacing it. **SELECT is deliberately untouched** — a driver has to read the job they
  are delivering, and the app already gates who is shown the screens. Adds no table, no
  column, no function, and changes no row.
- `0020_return_count` — the depot count as a control rather than a re-typing exercise.
  Renumbered from 0012 on the way in (0012_optional_inspection holds that number here), and
  already applied to the hosted project under the old name.
- `0021_purchases` / `0022_supplier_payments` / `0023_import_helpers` / `0024_import_activation`
  — the payable side carried across from MYOB: suppliers, their bills, purchase orders, the
  chart of accounts, and the switch that holds imported master records inactive. Renumbered
  from 0014/0015/0016/0015, all four of which collided with numbers this repo already used.
  All are live on the hosted project under their original names (§11), so the renumbering
  changes the repo's ordering only. None re-adds `grant execute … to anon`, which is what makes
  them safe to sit after 0019's revoke. None is in `archivable_tables()`.

- `0027_xero_payments` — `payments.xero_payment_id`/`xero_pushed_at`/`xero_push_error`,
  `xero_connections.payment_account_code`/`payment_account_name`, and
  `xero_connection_status()` re-created to carry the account. Four columns, no table, no policy
  change, no row touched. The re-create restates the pinned `search_path` and the revoke, the
  same trap 0012 recorded.
- `0026_xero_connection` — `xero_connections` (one row per laundry, keyed on `tenant_id`),
  `xero_connection_status()`, `invoices.xero_invoice_id`/`xero_pushed_at`/`xero_push_error`, and
  `customers.xero_contact_id`/`xero_contact_name` added `if not exists` because the hosted
  project already has them from the unmerged pricing branch (§11, §19). **The first table
  `authenticated` may not touch at all**: RLS on, no policy for it, and the table grants
  revoked — a refresh token is a bearer credential for somebody's accounting system, and no
  screen needs its value. The Settings screen reads the definer function instead, which returns
  the organisation name and the timestamps and never a token.

Proofs in `supabase/tests/`: `rls_isolation`, `rls_coverage`, `driver_scope`,
`business_rules`, `media_scope`, `warehouse_rules`, `notifications_scope`, `laundry_orders`,
`run_assignment`, `archive_records`, `laundry_pricing`, `platform_admin`, `main_flow_scope`,
`job_billing`, `purchases_scope`, `supplier_payments_scope`, `import_helpers`,
`import_activation`, `member_directory`, `boards_scope`, `item_master`,
`audit_log_scope`, `run_sequence`, `accounts_scope` (**431 assertions**).

**`run-db-tests.sh` parses the output rather than trusting the exit code, and that is not
pedantry.** `psql` exits 0 for a pgTAP file that runs to completion, and a failed assertion is a
*result row* (`not ok 7 - …`), not an error — so with `ON_ERROR_STOP=1` alone this script and
therefore **CI went green over a security proof that had started failing**. It now fails on a
`not ok`, on "Looks like you failed", and on a plan mismatch; all three were proved to fail the
run by breaking a proof on purpose. The plan half matters because `plan(N)` is what catches a
file that dies half way through — the case where the assertions you care about are the ones that
never ran. Three files had drifted out of step that way (`boards_scope` 20/23, `item_master`
16/17, `main_flow_scope` 29/27) and are corrected; none of them was failing. Demo data in `supabase/seed.sql` — not
applied by migrations.

**Do not re-add `grant execute on all functions in schema public to anon`.** That
boilerplate in 0002–0009 is what exposed every SECURITY DEFINER helper on
`/rest/v1/rpc/…` without a login; 0011 revokes it and `rls_coverage` asserts it stays
revoked.

**A trigger function needs `authenticated` named in its revoke, not just `public, anon`.** Postgres
grants EXECUTE on a new function to PUBLIC, so locally `revoke ... from public` takes it from
everybody; a hosted project instead hands each new function a **direct** grant to `anon` and
`authenticated`, which that revoke leaves standing. The consequence is only visible for a
**SECURITY DEFINER** trigger function — it is then published at `/rest/v1/rpc/…` for any signed-in
user, where it can only ever error, which is exactly why it should not be there. `0019` revokes
`guard_last_platform_admin` from `public, anon, authenticated` and is the pattern to copy; `0036`
did not, and the live security advisors caught it the hour it was applied. `pg-bootstrap.sql` now
mirrors Supabase's **function** default privileges as well as its table ones, so the local suite
reproduces the hosted posture and 0036's own assertion has something real to catch — without that
mirror it passed vacuously, the same trap 0029 records one object class over.

**The same applies to tables, and that half stayed open for months longer** (0029). Supabase's
stock **default privileges** grant `anon` and `authenticated` on every table created in `public`,
so each new table arrived reachable without a login — nothing in this repo asked for it and
nothing noticed. RLS kept it inert for reads, but **RLS does not apply to TRUNCATE**, and `anon`
held that too. 0029 revokes the grants *and* the default privileges behind them.

`scripts/health/pg-bootstrap.sql` now **mirrors those default privileges** so a local run
reproduces the hosted posture. Before that it did not, which is exactly why CI looked clean for
months while the live database was not: without the mirror, 0029's proof passes vacuously.
**Since 2026-08-25 it mirrors the *function* default ACLs too**, for the same reason and after the
same kind of miss — see the trigger-function note above.

`scripts/health/pg-bootstrap.sql` shims what Supabase provides outside our migrations: the
`auth` schema, and the `storage` bucket/object tables plus `foldername()` that 0007 attaches
policies to.

## 8. Offline
`src/lib/offline/queue.ts` (IndexedDB outbox, client-generated refs) +
`src/components/offline-capture.tsx` (capture UI, flush on save / `online` / SW message) +
`public/sw.js` (shell cache, never intercepts writes) + `/api/sync` (idempotent batch insert
keyed on `client_ref`, unique per tenant).

The outbox carries three record kinds: `pickup`, `delivery` and `exception` — the run
screen's "Something's wrong at this stop" (reason + note + optional photo) rides the same
queue, so a problem can be flagged with no signal and without leaving `/run`. Exceptions
sync as a job *update* (status/reason/notes), which is naturally idempotent, so they skip
the `client_ref` duplicate check the insert kinds need. The photo path travels inside
`exception_notes` as a `[photo:…]` marker (`src/lib/exceptions.ts` packs and parses it —
every display site strips the marker; jobs have no media column and Phase B adds no
migration).

Photos and signatures ride in the same record as data URLs and upload one file at a time to
`/api/media` *before* the batch goes out, so a queue of stops is never one multi-megabyte
request that fails as a unit. Object keys are deterministic (`clientRef` + index) and the
upload upserts, so a replay overwrites rather than duplicates. A record whose media fails to
upload stays queued whole — half a proof-of-service on the server is worse than none.

## 9. Media
`src/lib/media.ts` (shared constants + path builder, no I/O) · `/api/media` (one file per
request, tenant segment written from the session) · `src/lib/media-urls.ts` (`signMedia()`,
short-lived signed URLs, server-only) · `src/components/media-capture.tsx` (camera + canvas
signature, downscales on device) · `media-upload-field.tsx` (the online forms) ·
`proof-of-service.tsx` (display). Nothing is public: reads always go through a signed URL.
Scopes: `pickup` / `delivery` / `inspection` / `exception` — a new scope is just a new path
segment, since the storage policies check only the tenant segment.

## 10. Environment
See `.env.example`; validated fail-fast in `src/lib/env.ts`. Email delivery
(`RESEND_API_KEY`, `INVOICE_FROM_EMAIL`) is optional — without it the app runs and the send
action says so rather than the deployment refusing to boot. **Since 2026-08-24 those two are the
sender for the auth mail as well** — invitations and sign-in links, which used to go through
Supabase's own mailer and so needed custom SMTP nobody had configured. One provider posts
everything the app sends. The names still say `INVOICE_` because renaming them would take a live
deployment's mail down at the moment it redeployed. `CRON_SECRET` is optional on the
same principle, with one difference that matters: `/api/notifications/sweep` refuses **every**
request while it is unset, so an unconfigured deployment loses the swept notifications rather
than exposing an endpoint that enumerates every tenant's overdue invoices. The Vercel cron
entry lives in `vercel.json` and its schedule is **UTC** — the five daily hits are 07:00 to
15:00 Sydney (AEST; an hour later in wall-clock terms under AEDT, still inside the working day).

## 10a. Toolchain pins
Next 16 (Turbopack), React 19, Tailwind 4 (CSS-first — no `tailwind.config.ts`), Zod 4,
vitest 4. Two pins are held back on purpose: TypeScript **6** (typescript-eslint does not
support TS 7) and ESLint **9** (`eslint-config-next@16` depends on typescript-eslint 8,
which targets ESLint 9). Next 16 needs `experimental.useTypeScriptCli` and the auth gate
lives in `src/proxy.ts`, not `src/middleware.ts`.

`eslint.config.mjs` adds one rule on top of `eslint-config-next`:
**`@typescript-eslint/no-unused-vars` as an error**, because a value fetched and then dropped
is how `createOrder` drew a job number, never wrote it, and broke every job creation past a
green typecheck — `.insert()` takes an untyped object, so `tsc` cannot see a missing column.
The plugin instance is pulled back out of the Next config rather than declared as its own
dependency, keeping the pins above the only source; it throws if that registration moves.

## 10b. Design system
**YSM Hub — "paper and ink with accent."** Adopted from `ysm-prog/ysm-hub` (`src/index.css`) in
the 2026-08-16 re-skin so the two products read as one company's software. It supersedes the
2026-08-13 Electro Services language, which in turn replaced Plantline (flat, square,
near-black chrome, monospace labels) because that read as a developer console to the counter
staff, drivers and managers who use it. Tokens live in the `@layer base` block of
`globals.css`; nothing hard-codes a colour, radius or shadow at a call site — which is what let
the whole re-skin happen in the token layer, with `src/` otherwise untouched.

**Every hex in YSM Hub's stylesheet was converted to HSL and pinned to one decimal place**, so
each token round-trips to YSM's exact byte (`--background` really is `#f4f1ea`, not a near
miss). Integer percentages drift by 1–2 per channel; if you add a token, carry the decimal.

- **One brand colour, used for intent.** `--primary` (YSM teal `#01696f`) marks the primary
  action and the place you are — buttons, active nav, focus ring. `--action` is a separate
  token pointed at the same value, because the whole app spells the solid button `bg-action`;
  the seam stays if the two ever need to diverge.
- **Status keeps its own family** (`--success`, `--warning`, `--danger`, `--info` — YSM's
  earthier semantic four) and is **always paired with a written label** — a badge never carries
  meaning by colour alone. Text on a solid status fill uses `--on-status`, never a literal
  white.
- **The dark theme is ours, not YSM's, and that is deliberate.** YSM Hub's own stylesheet
  contrast-checked its dark `--ink-3`/`--ink-4` and never its dark accent: `#00898f` measures
  4.4:1 on the dark page and 4.0:1 on a dark card, under the 4.5:1 floor its light theme holds.
  Its semantic four are left at their light values, which are unreadable on `#141412`. So every
  dark colour **keeps YSM's hue exactly and moves only lightness** until it clears AA on the
  page, on a card, and as a fill under `--on-status`. Same teal, legible. `--muted-foreground`
  is lifted one step past YSM's `#84817a` for the same reason — that value clears AA on the
  page (4.7:1) but not on a *card* (4.3:1), and most muted text in this app sits on a card.
- **Paper, not panels-on-grey.** Warm paper page carrying an 18px dot lattice at 3% ink (felt,
  not seen — it stops a large empty page reading as a void), warm off-white cards, hairlines in
  stone rather than cool grey. Shadow is used sparingly and is retinted to YSM's ink so it no
  longer goes faintly violet on warm paper.
- **YSM's geometry**, which is crisper than what came before: `--radius-*` now spans 2–22px,
  with **`rounded-lg` = 6px the control corner** (YSM `--r`) and **`rounded-xl` = 12px the card
  corner** (YSM `--r-lg`). Those two names were already load-bearing at ~130 call sites, so the
  remap changed the geometry of the whole app without touching one of them. A base rule gives
  `button`/`select`/`textarea`/`input` the system radius, so the ~120 hand-rolled controls
  cannot come out square; a `rounded-*` utility still wins.
- **Comfortable, not dense — the one place we do *not* follow YSM's numbers.** 15px body, 44px
  (`min-h-11`) inputs and touch-first buttons, 40px standard buttons, nothing tappable below
  36px. YSM Hub is 14px body and 36px controls because it is a desktop repair-shop console;
  this is a counter tablet and a driver's phone. YSM reasons the same way — it re-declares its
  whole type scale under `@media (pointer: coarse)` to get a legible touch floor — so holding
  the comfortable sizing follows its intent rather than departing from it.

- **The default type scale is the tidy one; the reading control is the accessibility path.**
  Labels 14px, hints 12px, `--text-2xs`/`--text-3xs` 12/11px. Two deliberate exceptions: a field
  *error* is 13px medium in the danger colour (one on screen at a time, and it is the sentence
  saying why the work did not save), and `CONTROL` is `text-base sm:text-sm` — 16px on a phone,
  because under 16px iOS zooms the page on focus, and 14px from `sm` up, because a 16px input
  sitting larger than the 15px body around it is what makes an application read as oversized.
- **`--control-border` is the edge of a box you type in, and is not `--strong`.** An input is
  `bg-surface` on a card that is also `bg-surface`, so its border is the only thing identifying
  it — and at `--strong` that measured 1.42:1 light / 1.22:1 dark against 1.4.11's 3:1. The new
  token carries 3:1 and is used by `CONTROL` and the checkbox alone. `--strong` stays exactly
  where YSM put it, because its other 60 call sites are card edges and table rules: decorative
  separators, outside 1.4.11, and strengthening them would trade the paper language for nothing.
  Same hue and saturation, lightness only — the rule the dark palette already follows.
- **Reading comfort is a root font size, and it is the whole of the lever.** `html[data-text-size]`
  in `globals.css` moves the root between 100%, 115% and 130%. Everything in the app is `rem` —
  Tailwind 4's `--spacing` is `0.25rem`, its type scale is rem, `body` is rem — so text, padding,
  gaps, control heights and the rail's own width all scale together: a real zoom, in three lines,
  with no call site touched. **`normal` sets nothing at all**, so a browser-level preference is
  respected rather than overruled. Media-query `rem` resolves against the browser's initial size,
  so breakpoints hold and the layout keeps its shape while the content inside it grows. The
  preference lives in `localStorage` and is applied by the root layout's pre-paint script beside
  the theme — it *must* be on `<html>`, because `rem` resolves against the root element and
  nothing else, so the cookie-in-the-layout pattern the rail's collapsed state uses would have
  scaled nothing. `lib/display.ts` holds the rule; the header carries a cycling button and the
  home screen a labelled three-way picker, both of which are the same preference.

Instrument Sans + Instrument Serif + JetBrains Mono via `next/font` (self-hosted). This is the
one thing YSM Hub does that could not be copied as-is: it pulls all three from
`fonts.googleapis.com` with a `<link>`, which is fine for a shop counter on wifi and wrong for
a van — the driver app must render without signal. Same three faces, fetched at build time.

**`em` is Instrument Serif italic**, bound globally in `globals.css` — YSM's signature accent
word inside a heading. Safe to bind because the app contained no `<em>` at all; use it in a
page title, not in body copy. **Mono stays bound but deliberately rare**: YSM spends it freely
on eyebrows, table headers and badges, and **this app does not follow it there**, because that
uppercase-mono-label treatment is exactly what the 2026-08-13 redesign swept out of 28 files.
Same fonts, same palette, different label voice — deliberate, not drift. The one exception is
`BrandMark`, where YSM spends mono too (`.side-shop .av`): a single letter in a teal tile is a
mark, not prose. `Eyebrow` in `ui.tsx` remains the supporting-label voice: 12px sentence case.

The strong border colour is named `--color-strong`, **not** `--color-border-strong`: the latter
would spell the utility `border-border-strong` and silently do nothing.

The sidebar is a paper surface driven by its own `--sidebar-*` tokens (it used to be near-black
with literal hex). Tokenised separately so the rail can be themed without touching the page
surfaces beside it. **The active row is the one place the language goes loud**: an *ink pill
with paper-coloured text* (YSM's own `.side-nav a.is-active`), inverting to a paper pill with
ink text on dark. 15.7:1 either way, and it leaves the teal free to mean "this is the action"
rather than "this is where you are". Note `/design-preview` never shows it — the gallery's
pathname matches no nav area, so no rail row is ever active there; verify it by token, not by
screenshot.

**Shared components** (`ui.tsx` unless noted). Layout: `PageContainer` (caps width — `form`
≈1040px for entry screens, `default` ≈1280px, `wide` opts out), `PageHeader` (title, one-line
description, primary action, optional `back`), `Card`, `FormSection` (a titled group of fields;
what turns a wall of inputs into a short sequence of questions), `Stat`, `Stage`, `EmptyState`.
Status: `Badge`/`StatusBadge`, `Notice` (icon + tone). Actions: `Button`/`ButtonLink`
(primary/secondary/danger/ghost/subtle × sm/md/lg), `IconButton`, `CONTROL` + `SELECT_CHEVRON`
(the one input skin — import it, never restyle an input at the call site).
Forms (`form.tsx`): `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `WeekdayPicker`,
`SubmitButton`, `FormActions` (**sticky at the foot of the viewport on a phone**, so the one
action the operator came for is never buried under a long form).
Shell: `AppShell` (rail + header + content; owns the collapse and drawer state),
`AppNav`/`SectionNav`/`BrandMark`/`ThemeToggle` (`app-nav.tsx`), `GlobalSearch`, `UserMenu`,
`NotificationBell`, `ListControls`/`Pagination` (`list-controls.tsx`).
Overlays: `ConfirmSubmit` for destructive actions (**inline, not a modal** — the consequence
belongs beside the control, especially on a phone) and `Overlay` for a genuine detour
(centred dialog from `sm`, bottom sheet below it; focus trap, scroll lock, Escape, focus
returned on close). Entry is a page, not a modal — that has not changed.

`DataTable` is the one table. Below `sm` each row becomes a labelled card, so a new screen gets
a working phone layout for free and a hand-rolled `<table>` silently does not. `bare` drops its
own frame for a table filling a `Card` that has already drawn one — without it the two rounded
borders sit a pixel apart. `stickyHeader` caps the body height so the header has something to
stick to. Icons are **Lucide**, one set, one weight; the rail's icon is a *name* held in
`nav.ts` (`NavIcon`) and mapped to a component in `app-nav.tsx`, keeping `nav.ts` pure data for
the unit tests.

`/design-preview` is a static component gallery: no data, 404s in production, outside the auth
gate so it can be rendered from a build box. It exists because every real screen is an async
server component reading Supabase, so none render without a live project — which is how a
doubled hairline and an invisible dark-mode sidebar edge both survived a green `verify`.
Screenshot it with Playwright (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) against
`next start`. **Two defect classes it is worth asserting on, not just looking at:** horizontal
document overflow at 390px, and `role="dialog"` sitting on a full-screen wrapper rather than on
the panel.

**Absolutely-positioned children escape an ancestor's `overflow` clip** unless something inside
that scroller is their containing block. `sr-only` is `position:absolute`, so an `sr-only` label
inside a horizontally scrolling board stretched the document ~230px on a phone; the planner
column carries `relative` for exactly that reason.

## 10c. Invitations
`/admin/users` invites by email. **The app mints the link and sends it through Resend** —
`generateLink()` on the service-role client creates the login and hands back the link *without
sending it*, and `lib/auth/send-link.ts` then posts the email through the same transport the
invoices use. It used to be `inviteUserByEmail()`, which asks Supabase's built-in mailer to
deliver; that needs custom SMTP this deployment has never had, so **every invitation the screen
has ever reported as sent went nowhere** (§18, 2026-08-24 — 0 `auth.one_time_tokens` on the live
project, and `invited_at` NULL on all 18 logins). The **membership** row still goes in through the
caller's own RLS-bound client, so which tenant somebody joins is the database's decision. An
address that already has a login is resolved with `generateLink()` too and gets no mail — they
have a password already, and issuing one would only invalidate a link they may still hold.

**A refused send un-does the invitation.** Minting the link *creates* the login, so a provider
that refuses afterwards would leave an `auth.users` row nobody can reach — and the retry would
answer "they already have a login", which is the one thing that stops the administrator sending
the mail that never went. The login this call just made is deleted, so a retry starts clean; the
provider is also checked *before* the mint, so the ordinary unconfigured case creates nothing.

**"Email sign-in link" sits on every row of the People screen**, because an invitation only goes
out once. Somebody who never opened theirs, or who has lost their password, previously had no way
back in that an owner could offer. The address is resolved from `listMembers()` rather than from
the posted id, so an id from another laundry resolves to nothing rather than mailing a stranger.

**A sign-in link is a `recovery` link**, both from that button and from the login page. It is the
one type that signs a person in *and* lets them set a password — which is what "No password, or
forgotten it?" promises — and it cannot create an account, so a mistyped address still cannot mint
an orphan login. `lib/auth/auth-links.ts` holds the reasoning and the link builder; both are pure
and tested, because the fetch beside them reaches `lib/env` and no unit test can import it.

**The invite lands on `/auth/invite`, not `/auth/callback`.** Supabase bounces an accepted
invitation back with the session in the URL **fragment**, which never reaches the server, and
`inviteUserByEmail` cannot use the PKCE `?code=` flow because the browser that sent the
invitation is not the one that opens it — there is no code verifier waiting. So `/auth/invite`
is **the one client-rendered screen in the app**, and `src/lib/supabase/client.ts` is the one
browser Supabase client (it reads `process.env.NEXT_PUBLIC_*` directly, because `lib/env`
validates the service-role key and must not enter the client bundle). It handles all three
shapes a link can arrive in — fragment, `?token_hash=`, `?code=` — and strips the tokens out of
the address bar once the session is stored.

**No deployment note any more, and that is the point.** This used to read: *the Supabase project
must list `<origin>/auth/invite` under its allowed redirect URLs, or invitations fall back to the
project's Site URL.* Because the link is now built on **this** origin around a `token_hash`,
Supabase never does the redirecting and has nothing to allow — so a preview deployment invites
into itself with no configuration at all. What the deployment does need is `RESEND_API_KEY` and
`INVOICE_FROM_EMAIL`; without them every one of these actions says so by name rather than
reporting a success that did not happen.

Removing access deletes the membership and nothing else: the login survives (it may be their
access to another tenant), and every row they wrote still points at them. Both removal and a
role change refuse the last `admin.write` holder — with two administrators each could otherwise
demote the other and lock the tenant out of its own People screen.

## 11. Hosted project
`laundrymart-syd` · ref `xujhwljrmogenhvqpkrf` · ap-southeast-2 (Sydney) · org `ysm-prog`.
Deployed on Vercel at `ats.coreit.com.au`. All migrations through `0030_member_directory`
applied (0014 on 2026-08-13, 0015 and 0016 on 2026-08-14, 0017, 0018, 0019 and 0025 on
2026-08-16, 0026 and 0027 on 2026-08-17, 0030 on 2026-08-18), each verified by rolled-back probe
rather than trusted. **Every migration through `0036_invoice_account_codes` is applied**, and the
ledger's last four entries are `0033_laundry_prices_read`, `0034_counter_takes_jobs`,
`0035_audit_log_read` and `0036_invoice_account_codes`. 0020–0024 are the renumbered branch migrations, already live under their original
names (§7).

**`0036_run_sequence_control` and `0037_account_and_item_codes` were applied on 2026-08-25**, in
that order — and the pre-flight turned up a collision that changed what 0037 could be.

**There is a third `0036` on this project, from a branch not in this repo.**
`0036_invoice_account_codes` was applied the same day from `claude/…invoice-account-codes` and
does much of what our 0037 does: `can_read_purchases()`/`can_write_purchases()` — **the same two
role lists** as our `can_read_accounts()`/`can_write_accounts()` — the identical four-policy
rewrite of `gl_accounts` (same names), `items.income_account_id`, and additionally
`invoice_lines.gl_account_id` + `invoice_lines.account_code` with a `sync_invoice_line_account`
snapshot trigger. So **the chart of accounts was already closed before we got there**, which is
why §7's warning about it is now historical rather than live.

Our 0037 was therefore applied **reconciled**: only the four Xero-code columns
(`gl_accounts.xero_account_code`, `items.xero_item_code`,
`xero_connections.sales_account_code`/`_name`) and the re-created `xero_connection_status()`.
Its policy half was skipped, because re-running it would fail on 42710 and, if forced, would
leave `gl_accounts` gated differently from the five sibling tables that branch gates the same
way. The repo file is unchanged and still correct for a fresh database; the ledger entry records
the difference. Same shape as the 0018 convergence above, and the same remedy.

- **After `0036_run_sequence_control`**, probed as **real sessions** in transactions that were
  then aborted. The board and the dispatcher — both of which can *see* the run — were refused
  `42501` with the sentence *"the order of a run is set by the office, and your role cannot
  change it"*, and both were refused the unlock. A driver was lent one of the board's stops
  inside the same rolled-back transaction (there is no ordinary driver login on this deployment
  that can see a stop, so probing without that would have proved only RLS filtering, not the
  guard) and, **seeing the row**, was refused identically. The office manager saved a real order
  and the version moved 1 → 2; reversing it was refused *"that stop has already been worked"*;
  and a stale session replaying version 1 got the concurrency sentence. Afterwards: 11 runs all
  `sequence_locked` at version 1, both guards attached, **0 duplicate positions**, and 16 stops /
  8 laundry jobs / 647 invoices / 20 memberships / 5 boards / 508 archived customers all
  untouched.
- **After `0037`**, nothing arrives coded — **0** accounts and **0** items carry a Xero code — so
  the payload every invoice pushes is exactly the payload it pushed before. `xero_connection_status()`
  now returns the sales account (8 columns), `authenticated` still cannot read `xero_connections`
  (0026's posture survived the re-create), and an owner and an office manager can both **add an
  account** while a driver, a board and the counter are refused `42501`.
- **Advisors went 18 → 22**: `can_write_run_sequence` and `compact_run_sequence` from ours, plus
  `can_read_purchases`/`can_write_purchases` from that other branch. All the documented definer
  shape. `guard_job_sequence` and `guard_run_sequence_control` are **not** on the list, because
  their EXECUTE is revoked — the trigger-function trap 0019 recorded. **0** `anon` table grants,
  **0** `anon`-executable functions and **0** tables without RLS throughout.

**Two things the read-back turned up that are the owner's, not the code's.** The chart of
accounts (268 rows) belongs to **Adelaide**, which holds **no items**; the six items belong to
**Harbour**, which holds **no accounts**. So coding an item to an account needs one or the other
filling in first. And all **647 invoices carry 0 `invoice_lines`** — they came from the import as
headers — so there is nothing yet for the Xero line coding to act on.

**`0031_boards` and `0032_item_master` were applied on 2026-08-20**, in that order, each
verified before the next. **`0033_laundry_prices_read` followed the same day.**

**`0036_invoice_account_codes` was applied on 2026-08-25**, and is the ledger's last entry
(`20260825114025`). Rehearsed in three aborted transactions first, the way §11 requires.

- **Pre-flight:** every object it creates absent (0 functions, 0 columns, 0 trigger); all six
  `*_member` policies present and **the only** policies on those tables (6 of 6), so nothing else
  was there to preserve; all six carrying `tenant_id`; 0 `anon`-executable functions and 0 `anon`
  table grants, so its own assertions would pass. `invoice_lines` was **0 rows** — the 647 invoices
  are imported headers — so the two new columns landed on an empty table.
- **Rehearsed, then read back as real sessions after the apply.** `board1@ats.example.com` went from
  **268 accounts / 192 suppliers / 1,515 bills / 1 order / 62 payments / 636 activation rows** to
  **0 of each**, and its rename of `4-1600 Laundry` touched **0 rows** — the account is still called
  *Laundry*. Its own work is untouched: 1 run, 2 jobs. The counter reads 0 and the driver reads 0.
  `jay@ctnorwood.com.au` still reads 268 and 1,515, and — **the assertion that matters, because the
  failure this class produces is a statement that succeeds and touches nothing** — an
  importer-style insert **landed** (1 row). Finance and a plain `super_admin` each read their own
  laundry's chart where the counter in the same tenant, over the same rows, read **0**: the role
  gate, told apart from tenancy.
- **The trigger, probed against real rows:** the code came back **derived** (`4-1100`) rather than
  taken from the caller; a free-text line carried **null**; a heading was refused with *"that is a
  heading, not an account you can code to"*; another laundry's account with *"that account belongs
  to another business"*; and after deleting `4-1100` the line **still said `4-1100`** with its link
  cleared — the snapshot outliving the link, which is the whole reason it is kept.
- **Counts unchanged:** 647 invoices, 268 accounts, 192 suppliers, 1,515 bills, 62 supplier
  payments, 636 activation rows, 508 archived customers, 8 jobs, 20 memberships, 5 boards, 6 items.
  24 policies across the six tables (4 each), **0 permissive `for all` left**, 0 `anon` table
  grants, 0 tables without RLS.
- **Advisors went 18 → 21, and one of the three was a defect.** `can_read_purchases` and
  `can_write_purchases` are the documented definer shape and expected. The third,
  `sync_invoice_line_account`, was not: the migration as applied revoked it from `public, anon`
  and **not** `authenticated`, so a SECURITY DEFINER trigger function sat on `/rest/v1/rpc/…` for
  every signed-in user. Revoked live within the hour, the trigger confirmed to still derive the
  code afterwards (Postgres checks EXECUTE at `create trigger` time, not at fire time), and
  advisors settled at **20** — 19 definer helpers plus the auth leaked-password toggle. **The
  repo's `0036` file carries the corrected revoke and a fifth self-assertion for it**, so a fresh
  database cannot repeat it; the live ledger's stored statements for `20260825114025` predate that
  one line, which is recorded here rather than glossed.

**Two more migrations went on the same afternoon, from a different session and a different
branch** — `0036_run_sequence_control` (11:54) and `0037_account_and_item_codes` (11:58), both from
`claude/code-review-requirements-ns6bav`. The live ledger therefore carries a **second migration
numbered 0036**, the same situation §7 records for 0015 and the two 0017s. Filename order
(`_invoice_` before `_run_`) matches the order they were applied, so nothing depends on
renumbering. **Both branches are merged as of 2026-08-25** and `supabase/migrations/` is a complete
picture of the live project again. My work was re-read
afterwards and is intact: 24 policies across the six payable tables, `gl_accounts_read` still gated on
`can_read_purchases`, **0** permissive `for all` left, the coherence trigger attached, and
`sync_invoice_line_account` still not callable by `authenticated`. The two extra definer functions on
the advisor list (`can_write_run_sequence`, `compact_run_sequence`) are that branch's, not 0036's.

**The two branches could not both merge as they stood, and this was proved rather than reasoned
about — it is fixed, and recorded because the shape recurs.** Applying every repo migration to a fresh Postgres 16 and then that branch's two, in filename
order, fails:

    ERROR: policy "gl_accounts_read" for table "gl_accounts" already exists

`0037_account_and_item_codes` drops `gl_accounts_member` and creates `gl_accounts_read` — which
`0036_invoice_account_codes` had already created. CI's DB job applies every migration to a fresh
database, so **whichever of the two branches merged second would have broken CI**. The live database
never showed it, because that session applied a *reconciled* 0037 that skips the policy half by hand
— which is exactly the resolution the merge then adopted in the repo.

**The two are the same rule under two names.** `can_read_accounts`/`can_write_accounts` (0037) and
`can_read_purchases`/`can_write_purchases` (0036) carry **identical role lists** — the six
`purchases.read` holders and the five `purchases.write` ones. So this is a naming collision rather
than a disagreement, and the remedy is one of: drop 0037's policy half (live already has it), or
rename one pair and have 0037 replace the four policies idempotently. **0036 covers six tables and
0037 covers `gl_accounts` alone**, so keeping 0036's is the option that leaves the payable side gated
one way rather than two. Whoever merges second decides; nothing is broken until then.

**A fourth entry, `0038_invoice_line_account` (12:26), went on after the merge and is a no-op.** It
is that same session converging on `invoice_lines.gl_account_id`, which `0036_invoice_account_codes`
had already added — the 0018 arrangement, and its own header says so. Its file is not in
`supabase/migrations/` yet; nothing is missing, because a database built from this repo alone gets
the column, the index and the single foreign key from 0036. **Checked rather than assumed:** the
migration as applied was replayed against a fresh database built from these files and came back
*column already exists, index already exists, 1 FK to gl_accounts* — so when that file does land it
merges cleanly. Its reading of the column matches this repo's: the line's own account is preferred
over the item's at push time, which is what `lib/xero/push.ts` does.

**`0034_counter_takes_jobs` and `0035_audit_log_read` were applied on 2026-08-24**, in that order,
and are now the ledger's last two entries. Both are self-asserting, and `apply_migration` is
atomic, so a failed assertion rolls the whole thing back — which is what makes it safe to apply
one directly. Both returned clean.

- **After 0034**, read back as **real sessions** in a transaction that was then aborted: the
  counter's job insert **landed** (1 row), its item insert **landed** (1 row), and an edit of an
  existing job returned **true** — the assertion that matters, because the failure this migration
  exists to prevent is a statement that succeeds and touches nothing. 0 probe rows survived the
  rollback. Billing did not move with it: the counter still reads **0** invoices and **0** prices.
- **After 0035**, the same sweep by role: `board`, `driver` and `customer_service` read **0** audit
  rows where `auditor` and the owner read **47**. `audit_logs` carries exactly two policies —
  `audit_logs_read`/SELECT and `audit_logs_write`/INSERT — and no `ALL`, no UPDATE and no DELETE,
  so the trail is append-only by the absence of a policy rather than by a check somebody can
  forget.
- **Advisors stayed at 18** (the 17 documented SECURITY DEFINER helpers and the auth
  leaked-password toggle): neither migration adds a function. **0** `anon` table grants and **0**
  tables without RLS, so 0029 and the tenancy spine are holding. 647 invoices, 508 archived
  customers, 8 laundry jobs, 20 memberships and 5 boards, all as recorded.

**Adelaide's four board logins went on the same day** (§24): `board1@`…`board4@ats.example.com`,
written by SQL for the reason §3a records, each with a `board` membership in Adelaide and nowhere
else, each linked to one of Board 1–4. Rehearsed in a transaction first and the rollback confirmed
to leave **0** rows before anything was committed; verified afterwards column by column against the
`board@roles.example.com` profile, and by reading back as Board 1, which now sees `LJ00003` and
`LJ00004` and **0** invoices. Boards linked: **5 of 5**, up from 1.

**The month-end run was rehearsed read-only and there is a finding.** Read-only because generating
writes drafts against 508 real customers and the question was whether it works, not whether to
bill. It does — and pressing "last month's invoices" *today* would answer **nothing to invoice**,
because the default period is the previous month (1–31 July, the 2026-08-20 fix) and Adelaide's one
approved job `LJ00002` completed on **20 August**. "Nothing to invoice" reads as *everything is
billed*, not as *wrong month*. The default is right for the ordinary case; the trap is that the
first real run happens mid-month against a job from the current one. **Set the period to August, or
run it in September.**

**0033 was found by probing, not by review, and only because the cutover put data in the table.**
Every table in `public` was counted as a real `board` session — the sweep the boards work made
possible for the first time — and `laundry_prices` came back **9**. Before it: all eight roles
probed (board, driver, counter, dispatcher, warehouse operator, sales, finance, owner) read all
nine rows. After it: board, driver, counter, dispatcher and warehouse read **0**; sales, auditor,
finance, owner and the office manager read 9 — exactly `can_read_pricing()`. `xero_connections`
answered −1 (refused at the grant level) throughout, which is the 0026 design holding. 9 price
rows still present, 7 policies on the table (1 read + 3 write + 0025's 3 restrictive), 0 `anon`
table grants, and 647 invoices / 508 archived customers / 6 jobs / 16 memberships untouched.
Advisors stayed at **18** — 0033 adds no function.

**The live cutover data went on the same day** (§24, §25), all of it read back afterwards:

- **Five boards.** `Adelaide Towel Service` — the real laundry — has **Board 1–4** at the Adelaide
  depot, **none linked to a login**, because none exists and this deployment cannot send an
  invitation. `Harbour Commercial Laundry` has **Board 1**, linked, at Sydney Depot.
- **A twelfth role profile.** `board@roles.example.com` / `RoleTest!2026`, `board` in Harbour and
  nowhere else. Written by SQL like the other eleven (§3a) and checked column by column against
  `driver@roles.example.com`: `aud`/`role`, confirmed, all eight token columns `''` rather than
  NULL (the 2026-08-18 trap), `email_change_confirm_status` 0, `app_meta`, a bcrypt `$2a$` hash
  that verifies against the shared password, exactly one email identity, and **not** a platform
  admin.
- **The demo round is real work, not an empty screen.** `RUN00002` is Board 1's run, with
  `operated_by_driver_id` = Sam Okoye — the field §24 exists for — and LJ00004/LJ00005 name the
  board. LJ00006 is completed history on the same run and the guard rightly refuses to reassign a
  finished job, so it was left exactly as it is. Read back **as the board**: 1 board, RUN00002,
  2 stops, LJ00004/5/6, 4 customers, **0 invoices**, `current_board_id` resolving and
  `is_board_only` true. Adelaide's 510 customers are outside it.
- **Item categories.** The five Harbour items that are laundry a customer hands in carry a
  `laundry_category` (apron → `uniforms`, bath towel → `bath_towels`, hand towel → `hand_towels`,
  tea towel → `towels`, table cloth → `linen`). `LB-STD-01` is deliberately left null: a laundry
  bag is a container the laundry lends, not laundry. Adelaide has **no items at all**, so there
  was nothing to categorise there.
- **The first price list on the project.** There were **zero** `laundry_prices` rows and **zero**
  rate cards, so "Price this job" could only ever answer *nothing came back priced* — correct, and
  inert for every job in both laundries. Harbour now carries a tenant default for all nine kinds.
  **Adelaide's was deliberately left empty**: inventing rates for a real business is not a repair.
- **Two false rows cleared, and one deliberately not.** The 2026-08-18 cross-tenant bug left
  `RUN00001` (Adelaide) crewed by Sam Okoye and `RUN00004` (Harbour) crewed by Mario Forte. Both
  were `planned` — never loaded, never started, never closed, **0 stops worked, 0 deliveries, 0
  pickups** — so `driver_id` recorded nothing that happened. Cleared on both; nothing deleted, 10
  runs and 15 stops unchanged, and the ids are in the changelog if it ever needs putting back.
  Harbour's own `RUN00001` (Sam Okoye, `in_progress`) is correct and untouched.
  **`LJ00001` is left alone**: an Adelaide job whose customer belongs to Harbour, still
  `ready_for_delivery`. Its remedy is to cancel it, which is terminal, and it is a job against a
  customer rather than a bug's leftover — the owner's call, not this session's.

Pre-flight, before anything was written: every object both migrations create was **absent**;
every constraint and index they drop **by name** was present (`memberships_role_check`,
`uq_laundry_prices_scope`, the four 0016 assignment checks, `idx_laundry_orders_ready_unassigned`);
0 `anon`-executable functions and 0 `anon` table grants, so both migrations' own assertions would
pass; and — **the check that mattered most** — the live `guard_laundry_order_transition` was
confirmed to carry 0017's `awaiting_review` and `not_billable` hooks, so rebuilding it from 0017's
body preserved them rather than reverting anything. That is the trap the local pgTAP run caught
first (§18) and the reason it was checked here before, not after.

Every constraint both migrations add was then evaluated against live data first: **0 violations**
across all four restated assignment checks, the widened membership role list, and the
case-insensitive item-code index. `apply_migration` is atomic, so a failed assertion rolls the
whole thing back — which is what makes it safe to apply a self-asserting migration directly.

After 0031: `boards` present with RLS on and its tenant policy; the billing hook **survived** the
guard rebuild; the assignment guard is board-aware; all three of 0025's restrictive
`laundry_orders` policies name `current_board_id` (the insert one in its `with check`, which is
the only half an INSERT policy has); both permissive policies still carry `archived_at is null`
— the 0028 trap, checked from the other direction; 0 `anon` functions and 0 `anon` table grants;
and 647 invoices / 508 archived customers / 6 jobs / 15 memberships / 3 drivers / 10 runs all
untouched, with **5 jobs keeping their original `assigned_driver_id`**.

After 0032: all 6 live items backfilled with an `item_code` from `sku`, the coherence trigger
attached, `save_laundry_order_items()` carrying `item_id`, and `uq_laundry_prices_scope` rewritten
to `(tenant_id, customer_id, item_type, item_id) NULLS NOT DISTINCT`.

**Then read back as real members, in one rolled-back transaction.** The `operations_manager`
profile saw 4 jobs, 13 stops, 8 runs and 6 items — its own laundry only, unchanged. The
`driver` profile was still narrowed to 0 jobs and 1 run, so no driver's visibility moved. Five
behavioural probes against **real rows**, all rolled back: a driver-only assignment refused
(*"a job is assigned to a board, not to a driver"*), another laundry's board refused (*"that board
could not be found"*), this laundry's own board **accepted** with the status moving to `assigned`
and `assigned_at` stamped, Remove Assignment clearing the board, and the item trigger storing
`bath_towels` for a row that was sent `sheets`. Nothing survived the rollback: 0 boards, 0 coded
job items, 0 categorised items.

Advisors went **16 → 18**, the two additions being `current_board_id` and `is_board_only` — the
documented definer shape, internally scoped to `auth.uid()`, and the exact counterparts of
`current_driver_id`/`is_driver_only` already on the list. `sync_laundry_item_type` is *not* on it
— **and the reason given here for two days was wrong.** This said "because its EXECUTE is revoked".
It is not: 0032 revokes from `public, anon` only, and the live grant is
`{postgres=X,authenticated=X,service_role=X}`, so `authenticated` can call it. It stays off the
advisor list because it is **SECURITY INVOKER**, which is what the advisor screens on — called
outside a trigger it runs as the caller and errors immediately. Right observation, wrong reason,
and the wrong reason is what let `0036` ship a *definer* trigger function with the same revoke.
Corrected 2026-08-25; see that changelog entry and the note under 0011 below.

**Read back on 2026-08-24, and the real laundry has been used since the cutover.**
`Adelaide Towel Service` now holds four laundry jobs of its own, three of them raised after the
20 August entry above: `LJ00002` was completed, **priced and approved** (1 frozen
`job_charge_snapshots` row — the first time the billing lifecycle has run against real work), and
`LJ00003`/`LJ00004` are `assigned` to boards. Two things follow, and both are the owner's to act
on rather than the code's:

- **No invoice has been generated from any of it.** `invoice_source_jobs` is 0 and no invoice has
  been created since 20 August, so `LJ00002` is sitting approved in the billing queue waiting for
  the month-end run. The roll-up is still the one step of the money path never exercised end to
  end.
- **Adelaide's four boards were linked to no login (0 of 4)**, so `LJ00003` and `LJ00004` were
  assigned to rounds nobody could sign in as and My Runs was empty for them. **Fixed the same day**
  — see §24 and the 0034/0035 paragraph above: four logins written by SQL, boards linked 5 of 5.
  Still true: Adelaide **has no member who is not a platform administrator**, and it holds **0**
  `laundry_prices`, so `LJ00002` was priced by hand rather than by a price list.

**Still to do in the app, not the database:** invite one person into Adelaide who is not a platform
administrator, enter its price list, and set `laundry_category` on the items that are laundry a
customer hands in (§25) — Adelaide holds no `items` rows at all, so that one waits on the item
master arriving. Creating and linking the boards is **done**.

For **0030** that was: pre-flight (function absent, **0** `anon`-executable functions so the
migration's own assertion would pass, 0 `anon` table grants, 15 memberships, 2 platform admins);
then the whole migration plus probes in two aborted transactions, read **as a real member** —
the `operations_manager` role profile, who belongs to the demo laundry and nothing else. It saw
**13 rows for Harbour, 2 of them platform administrators, 11 carrying a real name**, and was
refused Adelaide at 42501 (`that business is not yours`) and refused a laundry id that does not
exist. After the apply: still 0 `anon`-executable functions and 0 `anon` table grants,
`authenticated` holding EXECUTE, and 647 invoices / 508 archived customers / 5 jobs / 15
memberships untouched.

**One live data repair went with it, and it is the reason the eleven test logins rendered as
UUIDs.** They were written straight into `auth.users` by SQL (§3a records this), and GoTrue's
admin API reads `confirmation_token`, `recovery_token`, `email_change` and
`email_change_token_new` into non-nullable strings — all four were NULL on all eleven, so
`getUserById` failed for every one of them while the two API-created logins resolved. Set to
`''`, which is what GoTrue itself writes. Nothing else about those rows was touched. 0030 does
not depend on this (it reads the table directly); **renaming somebody from the People screen
does**, because that write still goes through the admin API.

**Adelaide Towel Service has two members and both are platform administrators**, so with the
owner's "never list a platform administrator" decision its People screen and its job pickers are
now empty until somebody is invited. That is the decision working, not a fault — but it means
the first thing to do in the real laundry is invite one real person.

For **0026/0027** that was: the whole of both migrations plus probes in one aborted
transaction, then applied for real and re-verified. `xero_connections` present with RLS on and
its single deny-everything policy; **a rehearsal row inserted and both `anon` and
`authenticated` refused at 42501 with that row present** — the grants are revoked, so the
refusal happens before RLS is even consulted, which is stronger than the "0 rows" 0018 and 0019
settled for; `xero_connection_status()` carrying the payment account (6 out columns); the two
partial indexes created; 647 invoices, 0 payments and the 508 archived customers untouched; and
still **zero** `anon`-executable functions, which is the migrations' own assertion. Advisors
went 14 → 15, the one addition being `xero_connection_status` — the documented definer shape,
role-checked inside and returning the organisation name, the timestamps and the account but
never a token.

**Pre-flight found `invoices.xero_invoice_id` already on the live database** — from the unmerged
`claude/customer-pricing-invoicing-sad9af` branch, which §11 below records as converging on
exactly this column. `0026` adds it `if not exists`, so the apply was a no-op for that column
and the 647 existing invoices kept their values (all null). `payments` had none of the three,
and there are **no payment rows at all**, so the payment path starts from nothing at risk.

**Nothing has yet talked to Xero.** `XERO_CLIENT_ID`/`XERO_CLIENT_SECRET` are unset on the
deployment by the owner's decision ("I will add variable later"), so the Settings screen says so
and every invoice issues exactly as it did before. First live run: set the two variables,
register `https://ats.coreit.com.au/api/xero/callback` on the Xero app, connect, pick the bank
account, then issue **one** invoice and take **one** payment and read them in Xero.

For **0017_customer_pricing_billing** that was (2026-08-15, recorded when the branch was
still unmerged — §21): preconditions read first (all twelve 0006 policy names, the
`service_agreement_lines_member` policy and the `invoices_invoice_type_check` constraint present;
none of the new columns or tables already there); the backfill read back — LJ00003 and LJ00006
`completed → awaiting_review`, LJ00004/5 left `pending`, and all 512 customers defaulted to
`monthly_consolidated`; **fourteen guard probes in one rolled-back block** against live rows —
completing a job set `awaiting_review` and created no invoice, approving unpriced and approving
incomplete both refused, review could not be skipped, a non-review job could not be priced, a
frozen charge refused both update and delete, approval succeeded once priced, a second invoice on
the same job hit 23505, a stray `source_job_id` was refused, release was refused while the job
was still on an invoice and permitted once the links were gone, and a foreign rate card was
refused. Then **the RLS claim proved end to end**: one real member was demoted to `driver` inside a
rolled-back transaction and read *as* that session — **0 of 647 invoices, 0 of 5 rate lines**, 0
payments, 0 credit notes, 0 job charges, while contract headers (2) and customers (512) stayed
readable. `anon` reads 0 from every one of them.

**CLOSED 2026-08-17 by `0029` — the `anon` grant drift found while verifying 0017.** The
original note said "SELECT and INSERT"; a proper look found `anon` holding **DELETE, INSERT,
REFERENCES, SELECT, TRIGGER, TRUNCATE and UPDATE** on **52 of 53** tables. It also called the
state "inert", which was too generous: RLS filters rows and therefore says nothing about
TRUNCATE, so the thing actually preventing an unauthenticated wipe was PostgREST not exposing
that verb plus 0011's function revoke — not the policies. Rehearsed and applied: **364 anon
table grants → 0**, `authenticated` unchanged at 364 and `service_role` at 371, a real signed-in
owner still reading (4 customers, 1 invoice — the rest are archived), `anon` refused at 42501,
a brand-new table arriving with **zero** anon grants, 0 anon-executable functions, RLS still on
all 53, and 647 invoices / 508 archived customers / 5 jobs untouched.

**One residual, stated rather than glossed:** three default ACLs in `public` still name `anon`
and belong to **`supabase_admin`**, which `postgres` is not a member of — so they cannot be
altered from here and the migration skips them by design. They are latent, not live:
**zero tables in `public` are owned by `supabase_admin`**, so nothing is currently created under
them. If Supabase ever creates a table in `public` itself, that table would arrive granted to
`anon`. Worth re-checking after any Supabase platform upgrade with:
`select count(*) from information_schema.role_table_grants where table_schema='public' and grantee='anon';`
— it should stay 0.

For **0019** that was: the live `is_member`/`has_role`/`is_driver_only` bodies confirmed
identical to this repo's 0001 before being replaced (this is the check that matters most — a
`create or replace` against a project carrying unmerged branches could silently revert one);
zero `anon`-executable functions, so the migration's own assertion would pass; both new tables
absent; then the whole migration plus probes in one aborted transaction, proving a rehearsal
laundry invisible to an ordinary member and visible to a platform admin. After the apply:
`anon` reads 0 rows from `platform_admins` with a row present, RLS on both new tables, the
`tenants` policy set now `tenants_member, tenants_platform`, the last-admin delete trigger
attached, and the 508 archived customers untouched. **Advisors went 12 → 14**: `is_platform_admin`
and `platform_migrations` are the documented definer shape and both are internally scoped;
`guard_last_platform_admin` briefly made a third before EXECUTE was revoked from
`authenticated` — it is a trigger function, so Supabase's default privileges had published it
at `/rest/v1/rpc/…` where it could only ever error. The repo migration carries that revoke now,
so a fresh apply matches. For **0018** that was: RLS on, both policies
present, the unique index confirmed `nulls not distinct`, the `updated_at` trigger attached,
`laundry_prices` confirmed absent from `archivable_tables()`, and a price row inserted and read
back as `anon` in one rolled-back block — 0 rows, so the standard Supabase `anon` SELECT grant
(which every table in this project carries) is refused by the policy, not merely unused. No new
security advisor: still the same 12 warnings, being the documented SECURITY DEFINER helpers —
including `can_read_billing`/`can_write_billing`/`can_read_pricing` from the branch below — and
the auth leaked-password toggle.

**`0018` had to be renumbered and made partly idempotent, and the reason is worth reading.**
The live ledger already carried **`0017_customer_pricing_billing`** (applied 2026-08-15 from the
unmerged branch `claude/customer-pricing-invoicing-sad9af`) — *an independent design for this
same requirement*: a customer is pointed at a service agreement acting as a rate card
(`customers.rate_card_agreement_id`) and each job's cost is frozen into `job_charge_snapshots`
at financial approval. It converged on **exactly** the link this branch added —
`invoice_lines.laundry_order_id`, same foreign key, same partial index, same name — so 0018
adds that column `if not exists` or it fails on the hosted database with 42701 and takes the
price table with it. **Both schemas are now live and only this one has code behind it**:
`job_charge_snapshots` is empty, no customer has a rate card, and no invoice line carries a job
yet. Two answers to "what is this customer charged?" is the duplication this file argues
against everywhere else, so that branch needs deciding — adopted, or dropped and its two
objects removed — before either is relied on.

**There are two tenants and only one of them is real.** `Adelaide Towel Service`
(`20000000-…-000000000001`) is the business: 508 customers and 646 invoices, no laundry jobs
yet. `Harbour Commercial Laundry` (`10000000-…`) is the demo seed. Both logins
(`darshan@`, `jay@ctnorwood.com.au`) are `super_admin` of **both**, and `requireSession()`
picks a membership with `.limit(1)` and **no ordering** — so which of the two a person lands in
is effectively arbitrary. Pre-existing, and worth fixing before anything depends on the split.

**The real tenant's records are archived as of 2026-08-16** (§18): 1,154 rows hidden, nothing
deleted, restored by `set_records_archived('20000000-…-000000000001', false)`.

**Thirteen logins as of 2026-08-16, and eleven of them are test profiles.** The two real ones are
above; the rest are `<role>@roles.example.com` (§3a), one per membership role, members of
`Harbour Commercial Laundry` **only** — proved rather than assumed: `is_member()` is false for
`Adelaide Towel Service` for every one of them, and none is a platform admin, so the real
laundry's 508 customers are outside all eleven. Shared password, printed by `npm run seed:roles`
and easy to reset with a rerun; `npm run seed:roles -- --remove --yes` takes them off again.
Written by SQL rather than by the Auth admin API because no session here holds the service-role
key — `auth.users` + `auth.identities` in GoTrue's own shape, one email identity each. Treat
this as a **demo-tenant** convenience: an address on a real laundry would want the script and a
real invitation.

The live project also carries real supplier data from the unmerged purchases branch — 1,515
supplier bills, 192 suppliers, 268 GL accounts, 636 import-activation rows. **No screen in this
build reads any of it**, so it is already invisible in the deployed app and 0017 leaves it
alone. If those screens ever land, that data needs its own decision. For **0016** that was: the three existing jobs backfilled from the runchain and read back (LJ00004/5 `ready_for_delivery → assigned` under Sam Okoye for 16 Aug,
LJ00003 keeping its driver as the record of who delivered it); five guard probes all refused
in one rolled-back block — Assigned with no assignment data, a driver with no date, ready
straight to out-for-delivery, a job on a crewed run naming no driver, and reopening a completed
job; and no new security advisor (still the same 7 warnings — 5 documented SECURITY DEFINER
helpers, `park_number_sequence` from another branch, and the auth leaked-password toggle).

**0016 carries a backfill, so its statement order is load-bearing**: the transition guard is
replaced *before* the backfill (which performs `ready_for_delivery → assigned` and needs the
new function to permit it), and the check constraints and the new assignment guard come
*after* it, over data that is already consistent. Re-running it against an empty database is
a no-op on that UPDATE; re-ordering it would break the next project it is applied to.

**The number 0015 is used twice against this project.** The live ledger already carried
`0015_import_activation` and `0015_import_activation_grants` (applied 2026-08-13 from an
unmerged branch) before `0015_run_assignment` went on. Supabase keys migrations on their
timestamp, not their name, so nothing collided — but when that branch lands here there will be
two `0015_*` files in `supabase/migrations/` and one of them has to be renumbered. The live
project also carries `0012_return_count`, `purchases`, `supplier_payments` and
`import_helpers` from branches not yet merged here, so `supabase/migrations/` is still not a
complete picture of it.
Demo tenant seeded
(`Harbour Commercial Laundry`); two `super_admin` logins, one also linked to the seeded driver.
Sign-in verified end to end 2026-08-05.

Two things the hosted project does differently from local Postgres, both handled in the SQL:
- `storage.objects` belongs to `supabase_storage_admin`, so `alter table … enable row level
  security` fails with "must be owner". RLS is already on there; 0007 guards the ALTER and
  only runs it against the local shim. Creating *policies* on the table is separately granted
  to `postgres` and works.
- PostgREST publishes `public` as RPC. Anything executable by `anon` is an unauthenticated
  endpoint — see the warning under §7.

## 19. Branches evaluated and dropped
Recorded so nobody re-opens them by finding the branch and assuming it is pending work.

**`feature/job-billing-workflow` — dropped, 2026-08-17** (owner's decision). 11 commits, and the
reason is its base rather than its idea: merging it would have **deleted 337 lines of `nav.ts` and
625 of `orders/actions.ts`**, reverting the navigation-is-data model and the job workflow to get
one screen. It also carried a *third* migration numbered 0017.

Its idea — an "Awaiting invoice" review step between a job finishing and it being billed — was
adopted anyway, from `customer-pricing-invoicing` (§21), which builds the same thing on current
code and backs it with a `billing_status` lifecycle in the database. So nothing was lost.

Left on the remote rather than deleted, per the convention below.

**`claude/phase-6-build-0yybvq` — dropped in full, 2026-08-16** (owner's decision). 1,001 lines
across 16 files, conflicting in 7. It was an earlier take on Phase D, and each of its three
parts was rejected on its own merits rather than as a batch:

- **Simple mode (D2).** Designed against a 22-row rail. The rail is eleven areas (twelve for a
  platform admin), and 0025 cut most roles down further — a warehouse operator now sees a
  handful of rows and a driver fewer, so the problem simple mode solves has largely solved
  itself. Its `advanced` flags also predate the Money and Platform rows and would have defaulted
  both to visible in simple mode, which nobody had considered.
- **Its own `inviteMember`.** Built on `generateLink` in both paths, which returns a sign-in
  link and **sends nothing**. The shipped action uses `inviteUserByEmail`, which is precisely
  what makes Supabase send the invitation (§10c). Taking it would have been a regression that
  looked like a refactor, and it was the cause of most of the seven conflicts.
- **The branded invitation email** (`src/lib/email/invite-email.ts`). Standalone and usable, but
  only if invitations are sent through Resend instead of Supabase — and the Resend path has
  never been exercised against the provider from this environment (§18, Phase C's C0). Not worth
  trading a working invitation flow for an unproven one to change how the mail looks.

The branch is left on the remote rather than deleted; nothing in it is lost if the reasoning
above ever stops holding.

## 17. Dispatch planner and the billing two-pane
Both are compositions over existing tables — neither added a migration.

- `/routes/planner` arranges a whole day at once: one column per run, a tray for stops with
  no run, crew pickers in each column header. Nothing commits until **Apply plan**, because
  dispatching is a sequence of trial moves and a board that saved each drag would leave the
  run sheet transiently wrong after every one. `plan.ts` holds the rules the board and the
  action both obey (a stop is frozen once `progress_status` leaves `not_started`; a closed or
  cancelled run neither gains nor loses stops) — the browser enforces them so a plan is never
  composed that the action will reject, and the action re-enforces them because the browser is
  not the boundary. `plan.ts` also owns the **posted payload** (`planSchema` /
  `parseDispatchPlan` / `DispatchPlan`), and `toPlan` in the board is typed to that inferred
  type — because the two disagreed for the feature's whole shipped life: the board sent `id`
  and no date, the schema wanted `routeId` and a date, and not one plan was ever applied.
  The load meter averages the customer's own recent weighed collections and
  says how many stops it actually covers; there is no promised weight per stop in the schema,
  so it never implies one.
- `/invoices` is the register + working pane. The left list is a chase queue, the right pane
  is issue / send / take payment, and selection lives in `?selected=` so filters and page
  survive. `?tool=` opens the bulk panes instead: `recurring` (the month-end run, defaulting to
  the **previous** month), `issue` (Issue Selected over the drafts) and `send` (Send Selected
  over the issued). `InvoiceSelection` is one component serving the last two. Pane actions post a `return_to` and come back to the pane — `returnTo()` in
  `lib/actions.ts` only honours a plain same-site path, since an absolute one would make every
  action an open redirect. `/invoices/:id` stays as the printable record and the place lines
  are edited and invoices voided.

## 20. Xero
Each laundry connects **its own** Xero organisation — `xero_connections` is keyed on
`tenant_id`, because a deployment-wide connection works exactly until a second real business
arrives and then posts one laundry's receivables into another's books.

Modelled on `ysm-prog/ysm-hub` (`lib/_xero.js`, `lib/_xero-invoice.js`): tokens refreshed on
read a minute before expiry, an `ACCREC` invoice carrying Contact + LineItems + DueDate, and
the invoice number in both `InvoiceNumber` and `Reference`. Two things this app does that YSM
does not need: the connection is per tenant, and there is no POS/B2B sync policy — every issued
invoice goes, because this app has no counter-cash concept.

- `lib/xero/invoice-payload.ts` is **pure and tested** — the mapping is the part with rules in
  it (GST per line from `invoice_lines.taxable`, the PO as `Reference`, a zero-priced line kept
  rather than dropped, `numeric`-as-string coerced). The fetch lives in `push.ts` beside it.
- **A push never blocks issuing.** `issueInvoice` issues, then pushes; a refusal leaves the
  invoice issued with `xero_push_error` set and a Retry button. The money record is this
  database's and Xero is a copy of it, so an outage must not roll back an invoice the customer
  has been told about.
- **`xero_invoice_id` is the idempotency key**: a retry carries it, which turns the create into
  an update. `customers.xero_contact_id` is filled from the first successful push so the second
  invoice attaches to the same contact instead of making a twin.
- A draft and a void are never pushed (`canPushToXero`), and a laundry that has not connected
  is *skipped*, not failed — it should not have every invoice wearing a red error it cannot act
  on.
- **Payments go too** (`0027`). A payment posts against the Xero invoice it settles, into a
  bank account **the laundry chooses** — Xero will not take one without an account, and guessing
  puts real money against the wrong ledger with nothing to notice it, so the settings screen
  offers the laundry's own accounts read back from Xero rather than a text box.
  `payment_account_code` is null until picked and payments are *skipped* while it is.
- **A payment carries an `Idempotency-Key`, and that is stricter than the invoice path on
  purpose.** The payment's own id goes in the header, so a retry after a timeout — where the
  first attempt may in fact have landed — cannot post the money twice. A duplicated invoice is
  visible and embarrassing; a duplicated payment quietly makes a customer look paid up.
- `paymentGate()` is pure and tested, and its four "not yet" cases are **skips, not failures**:
  already posted, the invoice never reached Xero, no bank account chosen, and a zero or negative
  amount (a refund is a credit note in Xero, not a payment). Marking those as errors is how an
  integration teaches people to ignore its warnings.
- **A void reaches Xero too** (2026-08-17). Voiding here voids there, on the same
  never-blocks-the-money contract: the local void and the job release happen first, and a
  refusal is written to `xero_push_error` with a Retry. `voidGate()` is pure and tested, and it
  distinguishes three *skips* — never pushed, already `VOIDED` there, laundry not connected —
  from the one real **refusal**: **Xero will not void an invoice with payments applied to it**,
  and it is right not to, because that protects a reconciled bank line. The message names the
  remedy (a credit note in Xero) rather than relaying validation text, and it is a failure
  precisely because somebody must act on it — their books still show the money.
- **Retry is status-aware.** On a voided invoice the Retry button retries the *void*, not the
  push: `canPushToXero` refuses a void, so the plain retry would have answered "a void invoice
  is not sent to Xero" — true, useless, and leaving the actual failure with no way to retry.
- **`recordXeroReference` was removed, not kept alongside.** It let a person type an invoice's
  `xero_invoice_id` in by hand, which was correct on the branch it came from — that code had no
  Xero client and could only hold a reference for reconciliation. The same column is now the
  push's **idempotency key**, so a typed value turns the next push into an update against an
  arbitrary invoice in the laundry's books, and steers the void and payment gates as well.
  There is deliberately no replacement control: if a push went wrong, the answer is to look in
  Xero, not to retype a GUID.
- **`invoices.xero_synced_at` (0017) and `xero_pushed_at` (0026) are two columns for one fact**,
  and only the second is written now. Left in place rather than dropped — it costs nothing and a
  destructive migration to remove an unread column is the wrong trade (the same call 0016 made
  about Pickup Time).
- **The codes on a line reach Xero, and until somebody says what they are, nothing changes**
  (0037). `buildInvoicePayload` has mapped `line.account_code` to `AccountCode` since 0026 and
  **nothing had ever populated it** — `push.ts` selected `description, quantity, unit_price,
  taxable` and stopped — so every invoice this app has pushed landed uncoded. The codes now
  travel `invoice_lines.item_id → items.income_account_id → gl_accounts.xero_account_code` for
  the account, and `items.xero_item_code` for `ItemCode`.
  - **Both are separate fields from our own codes, on purpose.** Xero refuses an invoice naming
    a code its own chart or inventory does not carry, so sending `items.item_code` on the
    assumption the two match would turn one mismatched item into *every* invoice failing to
    push. Blank means the key is omitted, which is exactly the payload that shipped before.
  - **`xero_connections.sales_account_code` is the fallback**, chosen from the laundry's own Xero
    income accounts beside the bank account payments post to. It exists because **most invoice
    lines carry no item at all** — a fuel levy, a contract minimum, a consolidated laundry
    charge — so item-level coding alone would leave uncoded precisely the lines a bookkeeper
    would otherwise re-code by hand every month. A line's own account still wins.
  - **Resolved at push time rather than snapshotted onto the line.** A code is a
    *classification*, not money: a laundry that fills its codes in later, or corrects a wrong
    one and presses Retry, should have the corrected code sent. What is frozen is the amount,
    which `job_charge_snapshots` already holds. Both embeds are unambiguous (one FK per hop),
    checked rather than assumed — this repo has shipped an ambiguous embed that was
    compile-clean and dead in production.
- `summariseXeroError` in `lib/xero/errors.ts` is shared by all three pushes. It was a private
  copy in two of them and the void path would have made three, at which point they drift and the
  least-used one stops parsing the shape Xero actually sends.
- `XERO_CLIENT_ID`/`XERO_CLIENT_SECRET` are optional like the mail provider, and a **partial**
  pair counts as unconfigured. The redirect URI is derived from the request origin, so a
  preview deployment connects to itself — and must be registered on the Xero app.

## 18. Changelog
### 2026-08-25 · Two branches, one chart of accounts: reconciled
`claude/invoice-item-code-selection-vlwwb4` and `claude/code-review-requirements-ns6bav` were
built the same afternoon, both applied migrations to `laundrymart-syd`, and **both independently
gated `gl_accounts`**. Merged here. No new migration; nothing dropped from either side.

- **They could not both merge as they stood, and that was proved rather than argued.** Applying
  every migration to a fresh Postgres 16 in filename order failed:
  `ERROR: policy "gl_accounts_read" for table "gl_accounts" already exists`. CI's DB job does
  exactly that, so whichever branch merged second would have broken it. The live database did not
  show it, because that session had applied a hand-reconciled 0037 that skipped the policy half.
- **0036's gate stands; 0037's half is gone.** `can_read_accounts()`/`can_write_accounts()` and
  `can_read_purchases()`/`can_write_purchases()` carried **identical role lists** — two names for
  one rule. 0036 covers all six payable tables where 0037 covered `gl_accounts` alone, so keeping
  0036's leaves the payable side gated one way rather than two, and makes the repo match what is
  already live. 0037 now *asserts against* that gate instead of creating its own, which is
  stronger than deleting the check: this migration is what puts a Xero code on the table, so
  "who can read that?" is its business even though the answer is another file's.
- **The Xero push takes theirs and generalises it.** Two charts are in play and they are not the
  same: `invoice_lines.account_code` is the MYOB code the bookkeeper reads (`4-1100`), and
  `gl_accounts.xero_account_code` is what that account is called in Xero. Sending the first would
  make Xero refuse an invoice naming a code its own chart does not carry — so the MYOB code stays
  on the screen and in the PDF, and only the Xero one travels. Their resolution went
  `line → item → account`, which misses a line coded **straight to an account** with no item;
  0036's `invoice_lines.gl_account_id` is set in both cases, so it is read first and the item is
  the fallback.
- **The item form was built twice, and the two versions disagreed about tenancy.** One read the
  account list through RLS alone; the other passed `tenantId` as a required argument, which is
  what §23 demands — a platform admin's session reads every laundry and the id chosen here is
  posted into a write scoped to one. The tenant-filtered read wins, wrapped in the one component
  both item screens now use, keeping the empty-state sentence the other version had.
- **A live regression was found on the way and is what made this urgent.** `0036_run_sequence_control`
  was applied to the hosted project while its code sat unmerged, so the database narrowed stop
  reordering to `super_admin`/`operations_manager` while the deployed screen still offered it on
  `routes.write`. Probed as the dispatcher profile: *"the order of a run is set by the office, and
  your role cannot change it"* — refused by the database, from a control the screen still showed.
  Merging the branch is the fix; the entry below is the feature it belongs to.
- 431 pgTAP assertions across 24 proofs (382 + 49, less the plan corrections), every migration
  applied to a fresh Postgres 16 with the whole suite and the seed on top. `verify` green.

### 2026-08-25 · The Owner keeps the codes, the codes reach Xero, and the proofs count themselves
Three things asked for together, and each turned out to have a defect behind it. One migration
(`0037`), **no new table, no dropped column, no row changed and no new capability**. §20 and §25
hold the design; §3, §7 and §11 the consequences.

**1. The three plan-count mismatches are fixed, and so is the reason they hid.**
`boards_scope` (20/23), `item_master` (16/17) and `main_flow_scope` (29/27) now declare what they
run. None was failing — `main_flow_scope` genuinely *contains* 27 assertions and claimed 29, so
nothing was being skipped, the number was simply wrong.
- **The finding underneath is bigger than the counts.** `run-db-tests.sh` ran
  `psql -v ON_ERROR_STOP=1` and trusted the exit code — but `psql` exits **0** for a pgTAP file
  that runs to completion, and a failed assertion is a *result row* (`not ok 7 - …`), not an
  error. So **CI would have gone green over a security proof that had started failing**, which
  is a much worse thing than a wrong plan number. The runner now fails on `not ok`, on "Looks
  like you failed" and on a plan mismatch, and **all three were proved to fail the run by
  breaking a proof on purpose** rather than assumed to work.

**2. The Owner can add to the chart of accounts — and before this, everybody could.**
`/accounts` has been read-only since the MYOB import landed; its empty state said "appears here
once it is imported from your accounting system", so a laundry wanting one more revenue code had
nowhere to put it. There was no create action anywhere in `src/`.
- **Underneath, the opposite was true.** 0021 attached `apply_tenant_policy` to `gl_accounts`,
  whose single permissive `for all` policy carries nothing but `is_member(tenant_id)` — so
  **every member could read *and rewrite* the chart straight off `/rest/v1/gl_accounts`**.
  Proved against a 0001–0036 database rather than reasoned about: a `driver` session read the
  balances, renamed an account, zeroed its balance and inserted a new one. `current_balance` is
  on that table, so the read alone was every account balance in the business.
- The `for all` is **dropped and replaced** by four explicit policies, not supplemented: its
  USING half grants SELECT too, so a narrower read beside it would have been a second door onto
  the same rows. The 0033 trap, one table later and now recorded three times.
- **No new capability.** `purchases.read`/`purchases.write` are what `/accounts` was already
  gated on, so no role lost anything it could reach through a screen. The auditor reads and does
  not write, which is why `can_read_accounts()` and `can_write_accounts()` are two role lists
  rather than one.

**3. Nothing this app knew had ever reached Xero as a code.**
`buildInvoicePayload` has mapped `line.account_code` to Xero's `AccountCode` since 0026 and
**nothing ever populated it** — `push.ts` selected four columns and stopped. Every invoice line
this app has pushed landed in Xero uncoded, to be sorted out by hand; no `ItemCode` went either.
- An account code and an item code now travel with each line, through
  `invoice_lines.item_id → items → gl_accounts`, with the laundry's default sales account behind
  them for the many lines that carry **no item at all** (a fuel levy, a contract minimum, a
  consolidated laundry charge — the lines a bookkeeper actually re-codes).
- **Both Xero codes are separate fields from our own**, which is the decision that keeps this
  safe: Xero refuses an invoice naming a code its own chart or inventory does not carry, so
  defaulting to `items.item_code` would have turned one mismatched item into *every* invoice
  failing to push. Blank omits the key, so a laundry that fills none of this in pushes exactly
  the payload it pushed yesterday — asserted first in the payload tests, because it is the
  property most worth not breaking.
- Resolved at push time rather than snapshotted onto the line: a code is a *classification*, not
  money, so correcting a wrong one and pressing Retry should send the corrected one. What is
  frozen is the amount, which `job_charge_snapshots` already holds.

- 766 unit tests (was 755) and **417 pgTAP assertions (was 398)**. `verify` green — typecheck,
  lint, tests and the production build. All thirty-seven migrations applied to a fresh Postgres
  16 with the whole pgTAP suite and the seed on top, and every pre-existing proof passes
  unchanged.
- Both new embeds were checked for ambiguity rather than assumed: exactly one FK per hop
  (`invoice_lines → items`, `items → gl_accounts`). An ambiguous embed is compile-clean, test-
  clean and dead in production with PGRST201, which this repo has shipped once.

**Applied to `laundrymart-syd` on 2026-08-25** — §11 has the read-backs. 0037 went on in a
**reconciled** form: an unmerged branch's `0036_invoice_account_codes` had already closed
`gl_accounts` with the same four policies and the same two role lists, so only the four Xero-code
columns and the re-created `xero_connection_status()` were applied. Verified afterwards as real
sessions: an owner and an office manager can add an account, a driver, a board and the counter
are refused 42501, and **0** accounts and **0** items carry a Xero code — so every invoice pushes
exactly the payload it pushed before.

### 2026-08-25 · The run is locked, and only the office may change its order
The client's controlled-sequencing requirement, built on the existing
`daily_routes → jobs` architecture rather than beside it. One migration (`0036`), **no new
table, no new column on `jobs`, nothing dropped and no existing row invalidated**. §28 holds the
design; §3, §4, §7 and §11 the consequences.

- **The security boundary did not exist, and that is the finding.** `roles.ts` gated the reorder
  on `routes.write` while `jobs` sits on `/rest/v1/jobs` under a single permissive `for all`
  policy — so **a driver could PATCH `jobs.sequence` on the run they were standing in**, and any
  other member could PATCH anybody's. Reproduced against a 0001–0035 database rather than
  reasoned about: `UPDATE 1`, a real row changed. That is exactly what §8 of the requirement says
  must fail server-side, and it is why this could not be done in `roles.ts` alone.
- **A trigger, not a restrictive policy, and the reasons are worth keeping.** The rule is about
  *one column*, and RLS is row-level — a restrictive UPDATE policy on `jobs` would also stop a
  driver writing `progress_status` and `arrived_at` on their own stops as they work them. And a
  restrictive policy writes **zero rows with no error** to a caller it excludes, the silence this
  project has shipped twice (0031 for boards, §26 for the counter); a trigger raising 42501
  reaches the flash toast as a sentence. It fires only on UPDATE of `sequence`, so board
  assignment — an INSERT appended at the end — is untouched, which §11 and §21 of the
  requirement both insist on.
- **`routes.sequence` is a capability of its own** because `routes.write` was the wrong
  authority: the dispatcher, the branch manager and the regional manager all hold it and the
  requirement names two roles. Named in a block and *subtracted* from the `TENANT_ALL`-derived
  roles — the trap this file has now recorded three times, and the one that actually catches
  `branch_manager` and `regional_manager` here.
- **Editing is a screen state and is deliberately never persisted.** §6 of the requirement says
  Cancel writes nothing, which settles it: entering edit mode cannot write either, or Cancel
  would have to write it back. So `sequence_locked` is the standing statement that the order is
  management's — read by the guard — and not a mutex. Nothing is checked out, and an abandoned
  tab strands nothing.
- **Concurrency is a version, not a timestamp** (§14). `updated_at` on `daily_routes` moves for
  status changes and load confirmation, so it would refuse saves over edits that never touched
  the order. The compare-and-swap happens inside the transaction that writes the positions.
- **Two defects found while building, both by probing rather than review:**
  - a board or a driver may update their **own** run row, so without a second guard they could
    have set `sequence_locked = false` and walked straight past the first one, or rewound
    `sequence_version` to defeat the concurrency check. `guard_run_sequence_control` narrows
    those four columns and leaves status, crew, load confirmation and closing exactly as
    writable as they were.
  - **removing a stop left a hole in the run** (§12): `retireStopIfEmpty` soft-deleted the row
    and never renumbered, so a run that lost its second call read 1, 3, 4 on the driver's phone.
    Closed through `compact_run_sequence()`, which is safe to admit wider roles to *by
    construction* — it takes no order from its caller, so it can only close a gap.
- **`applyDispatchPlan` moved to the same capability**, because the unlinked planner writes
  `jobs.sequence` too and would otherwise have been a live bypass of the screen next door.
- 755 unit tests (was 739) and **398 pgTAP assertions (was 368)**. `verify` green — typecheck,
  lint, tests and the production build. All thirty-six migrations applied to a fresh Postgres 16
  with the whole pgTAP suite and the seed on top, and **every pre-existing proof passes
  unchanged**, which is the check that mattered: the new trigger sits on a table five of them
  own.
- **Recorded rather than glossed:** three existing proofs declare a `plan(N)` that disagrees
  with what they run (`boards_scope` 20/23, `item_master` 16/17, `main_flow_scope` 29/27).
  Pre-existing and identical without 0036 — checked, not assumed. Nothing in them fails, but
  `main_flow_scope` running 27 of a declared 29 means two assertions in a security proof are not
  what somebody thought they were. Left alone as unrelated churn; worth a look.
- **The lock/edit/cancel cycle was driven in a real browser**, not just reasoned about:
  `/design-preview` gained the locked state as its own fixture, and 26 interaction assertions
  pass at 390/768/1440 in light and dark — locked by default with no draggable row and no Save
  anywhere, Adjust Run revealing 44×44 move controls, the payload carrying the version, Cancel
  restoring the exact saved order and returning to locked, a board seeing no control at all, and
  a worked stop disabled with a reason beside it. Zero console errors, zero overflow.

**Applied to `laundrymart-syd` on 2026-08-25** — §11 has the read-backs. The boundary was proved
against real rows rather than assumed: a board and a dispatcher that can *see* the run were both
refused 42501 with the sentence, a driver lent a stop inside a rolled-back transaction was
refused identically **while seeing the row**, the office manager saved a real order (version
1 → 2), moving a worked stop was refused, and a stale session replaying the old version got the
concurrency message. 11 runs locked at version 1, 0 duplicate positions, every count unchanged.

### 2026-08-25 · An invoice line says where the money lands
The client's chart of accounts, and the ask that came with it: an invoice line added
**by selecting an item or by the code**, with anything in neither list written as
free text. One migration (`0036`), no new table, no new role, no new capability,
nothing dropped and no row changed. §27 holds the design.

- **Three ways to fill one line, not three kinds of line.** Whichever route is taken
  the row is the same shape, so there is no `line_kind` column and a line the
  month-end run writes is indistinguishable from one typed at a desk. `items.income_account_id`
  is the bridge that makes "pick an item" produce a code; `invoice_lines.gl_account_id`
  + `account_code` carry it, the link for joins and the text for history.
- **An uncoded line is legal and counted, never refused.** The free-text line is the
  one the client explicitly asked for, so the app makes the gap visible rather than
  blocking the work — the same call the pricer makes about laundry nobody has priced.
- **Xero has been ready for this since 0026 and was never fed.** `buildInvoicePayload`
  has mapped `account_code` → `AccountCode` from the day it was written and nothing
  ever selected the column, so **every line this app has pushed has landed in Xero's
  default sales account**. One word in one `select`.

**The migration's first part is not the feature, and it is the reason it shipped with
it.** Coding a line means reading `gl_accounts` from an invoice screen, and that table
was wide open. All six payable tables (`gl_accounts`, `suppliers`, `supplier_bills`,
`purchase_orders`, `supplier_payments`, `import_activation_state`) shipped on
`apply_tenant_policy` — one permissive `for all … using is_member(tenant_id)` policy,
the identical shape 0006 put on `invoices`, 0017 replaced, 0018 repeated on
`laundry_prices` and 0033 replaced. **The third time.**

- **Probed as one of Adelaide's own `board` logins before anything was written**, and
  it read **268 accounts** — the owner's equity, the drawings, every vehicle loan —
  **192 suppliers** and **1,515 supplier bills** worth $65,724 outstanding, while
  correctly reading 0 invoices and 0 prices. Then an UPDATE renaming `4-1600 Laundry`
  **succeeded**: a delivery round could rewrite the chart of accounts. The write half
  was the worse of the two and is the half a read-only audit would have missed.
- **It hid for exactly the reason 0033's defect hid.** The demo tenant has no accounts
  and no bills, so the 2026-08-20 sweep that read every table as a board found 0 in all
  six and they looked clean. **An empty table is not a proof** — the same lesson, now
  three times over.
- `can_read_purchases()` / `can_write_purchases()` name the `roles.ts` holders and are
  deliberately **not** derived from `can_read_billing()`: §3 keeps those two sets
  independent, a dispatcher holding `invoices.read` and no `purchases.*` and finance the
  reverse. The `for all` policies are **replaced**, not supplemented, because their USING
  half grants SELECT too — the trap 0033 records, one table set later.

**Three defects found by driving the screen rather than by reading it**, which is the
argument for §10b's gallery rule and is why the composer landed there in three states:
- the first measurement run reported a clean sweep **vacuously**: `next start` had failed
  with `EADDRINUSE`, the old build kept serving, and the element being measured did not
  exist in it. `getElementById` returned null and the loop `continue`d. The same shape as
  the 0029 note about a proof passing against a friendlier database than the real one;
- picking `TT001`, switching to Account code and picking `4-2000` left the description
  reading **"Tea Towel"** on a line coded to delivery fees. "Never overwrite what somebody
  typed" and "a new pick should describe the new thing" contradict each other unless the
  form knows which it is holding, so it tracks that now;
- the no-chart card offered an "An account code" button whose only possible outcome was a
  notice saying there is no chart. A greyed-out button with a sentence under it beats a
  dead end dressed as a choice.

- **`searchAccounts` was wrong on the first attempt and a test caught it.** Ranking revenue
  above the rest *within* a match tier left `5-1000 Towel Purchases` — whose name starts
  with "towel" — beating `4-1000 Sales of Towels`, which merely contains it: the other side
  of the books answering a question asked on a sales invoice. Revenue is a whole tier ahead
  now, and an exact code still wins outright so the escape hatch stays open.
- 765 unit tests (was 739) and **382 pgTAP assertions (was 368)**, the last run against the
  stricter `pg-bootstrap.sql` above. `verify` green; all thirty-six migrations applied to a
  fresh Postgres 16 with the whole pgTAP suite and the seed on top. **All fourteen new
  assertions were confirmed to fail without `0036`** rather than assumed to be doing
  something — including "the board's rename touched nothing", which is the write hole.
- The gallery gained the composer in three states (a full chart, no chart, no items) and was
  measured light and dark at 320/390/768/1440 across all three text sizes: **24 combinations,
  0 console errors, 0 overflow inside the composer and 0 interactive targets under 36px**.
  Document overflow is 7px / 55px / 104px at 320 and 34px at 390 Biggest — **byte-identical
  to the baseline the 2026-08-24 entry recorded**, so this adds none. Twenty-six interaction
  assertions drive every route and both empty states.

**Applied to `laundrymart-syd` on 2026-08-25** — §11 has the full record. Rehearsed in three
aborted transactions first; after the apply the same probe that found the defect was re-run as real
sessions and `board1@ats.example.com` went from **268 / 192 / 1,515 / 1 / 62 / 636** to **0 of
each**, with its rename touching 0 rows and its own run and jobs untouched. The counter and the
driver read 0; `jay@` still reads 268 and 1,515 and its importer-style insert **landed**. Every
count unchanged, 24 policies across the six, **0 permissive `for all` left**.

**The apply found a defect in this very migration, and the security advisors were what caught
it.** They went 18 → **21**: two are the documented helpers, and the third was
`sync_invoice_line_account` sitting on `/rest/v1/rpc/…` for every signed-in user. The revoke said
`from public, anon` — and **that is enough locally and not on Supabase**. Postgres grants EXECUTE
on a new function to PUBLIC, so revoking from PUBLIC takes it from everybody; a hosted project
instead hands each new function a **direct** grant to `authenticated`, which that revoke leaves
standing. It only matters for a **SECURITY DEFINER** trigger function, which is what this one is
and what `guard_last_platform_admin` was when 0019 recorded the identical trap. Revoked live within
the hour, the trigger proved to still derive the code afterwards, advisors settled at **20**.

**Three things came out of that, and the second is worth more than the fix.**
- The repo's `0036` carries `revoke execute … from public, anon, authenticated` and a **fifth
  self-assertion** naming it, so a fresh database cannot repeat it.
- **`pg-bootstrap.sql` now mirrors Supabase's *function* default privileges**, not just its table
  ones. Without that the new assertion passed **vacuously** — proved by reverting the one word and
  watching the migration apply cleanly on the old shim, then fail with the assertion's own message
  on the new one. This is 0029's finding one object class over: *the local harness was reproducing
  a friendlier database than the real one.* CI can now catch this whole class.
- **CLAUDE.md said something false and it is corrected rather than quietly fixed.** §11 claimed
  `sync_laundry_item_type` stays off the advisor list "because its EXECUTE is revoked". It is not
  revoked — 0032 revokes from `public, anon` only and `authenticated` holds a direct grant today.
  It is off the list because it is SECURITY **INVOKER**, which is what the advisor screens on.
  Right observation, wrong reason — **and the wrong reason is what made 0036's revoke look
  correct.** A note that explains a clean result by the wrong mechanism is worse than no note.

**Merged to `Prod` on 2026-08-25** (`315f238`), a clean fast-forward, so it is live on
`ats.coreit.com.au`. CI green on all three jobs — verify, gitleaks, and the DB job against a fresh
Postgres 16 with the whole pgTAP suite and the seed, **now on the stricter `pg-bootstrap.sql`**. The
migration went on **before** the merge, so the schema led the code: the safe order, and the same one
the 2026-08-18 and 2026-08-20 entries record. `Dev` was not merged and is 2 commits behind.

**Still not verified end to end:** set an income account on a few items, add a line each way on a
draft, read the PDF, and push one invoice to Xero. **The account code reaching Xero is the one to
watch** — it is the first time that field has ever been populated.

**Adelaide's own state, which shapes the first run:** 268 accounts and **zero items**, so
until the item master lands the code is picked per line. That is why the composer opens on
the account code when a laundry has a chart and no item list.

### 2026-08-24 · Auth emails go through Resend, so no SMTP is needed
The owner's instruction, and it closes the longest-standing open item in this file. **No
migration; no schema, RLS, capability, policy or workflow change** — one sender replaces another.

**The project had never sent a single auth email, and it had been saying otherwise.** Invitations
went through `inviteUserByEmail` and sign-in links through `signInWithOtp`, both of which ask
**Supabase's built-in mailer** to deliver — and that mailer only reaches members of the Supabase
organisation and is capped at a couple of messages an hour until the project is pointed at custom
SMTP. This one never was. Read off the live database before anything changed: **0
`auth.one_time_tokens`, 0 `auth.flow_state`, and `confirmation_sent_at` / `recovery_sent_at` /
`invited_at` NULL on all 18 logins.** Not "few" — none, ever. It is why the four board logins and
the eleven role profiles had to be written by SQL (§3a, §24), why Adelaide still has no real
member, and why §24 said the shared board password "wants changing once SMTP is configured".

Meanwhile invoices, delivery confirmations and overdue chases have been going out through
**Resend** the whole time. So there was a working sender and a broken one, and the auth mail was
on the broken one.

- **`generateLink()` is the seam.** On the service-role client it mints an invitation or a
  recovery link and **returns it without sending anything** — that is what it is for. The app then
  builds the email and hands it to `sendEmail()`, the same Resend transport the invoices use. This
  is `ysm-prog/ysm-hub`'s arrangement: every message that product sends goes out through
  `resend.emails.send()` and it asks Supabase to deliver nothing.
- **The link points at this app, not at Supabase, and that removes a deployment step.**
  `generateLink` hands back both an `action_link` (a Supabase `/auth/v1/verify?…&redirect_to=`
  URL) and the `hashed_token` behind it. Building `<origin>/auth/invite?token_hash=…` ourselves
  skips the redirect hop *and* the requirement §10c used to record — the project no longer has to
  list this origin under its allowed redirect URLs, because Supabase is never the one redirecting.
  A preview deployment now works with **no configuration at all**.
- **A sign-in link is a `recovery` link, deliberately.** The login page offers it under "No
  password, or forgotten it?", so the person pressing it either has none or has lost it — and
  `recovery` is the one type that both signs them in *and* lets them set one, which is the promise
  the button was already making. It also cannot create an account, so it keeps the property
  `shouldCreateUser: false` was there for: a mistyped address still cannot mint an orphan login.
- **Both kinds land on `/auth/invite`**, which has read `?token_hash=&type=` since it was built and
  already branched on `invite` versus `recovery`. One screen, two sets of words — an invitation is
  news, a sign-in link is something asked for a minute ago, and a dead link has a different remedy
  in each case (ask whoever invited you, versus ask for another yourself).
- **A failed send now un-does the half-made invitation.** Minting an invite link *creates the
  login*, so a mail provider that refuses afterwards would leave a real `auth.users` row nobody
  can reach — and the retry would come back "they already have a login", which is the one answer
  that stops an administrator sending the email that never went. The login this call just made is
  deleted, so a retry behaves like the first attempt. The provider check also runs **before** the
  mint, so the ordinary "no key configured" case never creates anything at all.
- **"Email sign-in link" is new on the People screen**, per row, and it is the rung that was
  missing: an invitation goes out once, so somebody who never opened theirs — or who has lost their
  password — had no way back in that an owner could offer. The screen could change their role and
  take their access away and nothing in between. It exists now because it *can*, and it is how the
  four board logins stop sharing one bootstrap password: send each round its own link and let it
  set one. The address is resolved from `listMembers()` rather than from the posted id, so an id
  from another laundry resolves to nothing instead of mailing a stranger a way in.
- **The anti-enumeration rule survived the transport change unchanged**, which is the part worth
  checking rather than assuming. *A failure true of every address is named; a failure true of this
  address is hidden behind the same answer as success.* `magic-link.ts` still holds it — what moved
  is the vocabulary, from Supabase's mailer codes to this app's provider. `classifyLinkError`
  **defaults to "about this address"**, so an unrecognised refusal is hidden: guessing the other
  way would turn every future Supabase error code into an account-enumeration oracle. The cost is
  that an administrator sees a duller message, which `inviteFailureMessage` fixes by being allowed
  to say more — they typed the address themselves, so there is nothing there they could learn.
- **`INVOICE_FROM_EMAIL` is now the sender for auth mail too, and was deliberately not renamed.**
  A rename would take a live deployment's mail down at the moment it redeployed, for tidiness.
  `.env.example` says so instead.
- 739 unit tests (was 700), `verify` green. `/auth/invite` and `/login` are outside the auth gate,
  so unlike most of this app they could actually be rendered: asserted in both themes at
  320/390/768/1440 across all three text sizes — **72 combinations, 0 document overflow and 0
  interactive targets under 36px**, with the heading confirmed as "You have been invited" and
  "Choose a new password" in the two modes. The 48 console errors are all one line,
  `ERR_TUNNEL_CONNECTION_FAILED`, from the invite screen calling the *placeholder* Supabase URL the
  build uses here — exactly 2 pages × 2 themes × 3 sizes × 4 widths, and `/login` contributes none.

**One inconsistency was found by re-reading the path rather than by a test, and it would have
shown up on somebody's first attempt to sign in.** The invite action worked its origin out from
`x-forwarded-host`/`host`; the sign-in form read the **`Origin` header**, which a browser sends on
a form post but which nothing guarantees and a proxy may strip. An absent origin does not fail
loudly — it answers "this deployment could not work out its own web address", which is a poor
thing to meet the first time you ask for a link. Both now go through `originFromRequest()`, which
is pure and tested, assumes https unless the host is plainly local (so a bare `next start` still
produces an openable link), and is asserted to hand `authLinkUrl()` something it accepts — the two
halves disagreeing would be a link that silently never gets built.

**Every login on the project can be sent one today, which was checked rather than assumed.** All
**18** are `email_confirmed_at` non-null, none banned, none soft-deleted, none SSO and every one
carries a real address — so `generateLink({type:"recovery"})` has a user to work with in all 18
cases, including the four board logins and the eleven role profiles. That is the fact the advice
in §24 rests on: press *Email sign-in link* beside each board and it will mint.

**Nothing here has been sent yet, and the baseline above is what makes the first send checkable.**
This container has no Resend key and no service key, so no link has been minted and no email
posted. **Before trusting it: invite one real address on `ats.coreit.com.au`, follow the link, and
then confirm the counters moved** — `auth.one_time_tokens` should no longer be 0, and that login's
`recovery_sent_at`/`confirmation_sent_at` should stop being NULL. If `RESEND_API_KEY` and
`INVOICE_FROM_EMAIL` are not set on the deployment, every one of these actions now says so by name
rather than reporting success; that is the same contract the invoice send has had since it shipped.

**Merged to `Dev` and `Prod` on 2026-08-24** (`abbeafa`), both clean fast-forwards, CI green on all
three jobs for each — verify, gitleaks, and the DB job against a fresh Postgres 16 with the whole
pgTAP suite and the seed. **No migration went with it**: the ledger's last entry is still
`0035_audit_log_read`, and `git diff --name-only` over `supabase/` is empty.

### 2026-08-24 · Four questions the owner answered, and the two migrations behind them
Asked rather than assumed, because each was theirs to decide and three of the four could not be
done safely in `src/` alone. Two migrations (`0034`, `0035`), no new table, no new column, no new
function, no new capability, and no row changed by either.

**1. The counter may take laundry in again** (`0034` + `roles.ts`). §26 recorded this as open and
it is now closed: `customer_service` holds `orders.read/write/status` again, reversing the
`orders.*` half of 2026-08-16. That decision was coherent — job→invoice is one flow and it answers
to the Owner and the Office manager — but its effect was that a laundry wanting counter staff to
book jobs had to make them **Office manager**: 12 rail areas and 31 screens, including the whole
ledger, the plant and the activity log, handed to the least-trained person in the building to do
the one job their role is named for. It is roughly 7 rows and 11 screens now.
- **The migration is not optional and is most of the work.** `roles.ts` drives the nav and the page
  guards; it is not the boundary. 0025 put *restrictive* write policies on the nine job→invoice
  tables, and a restrictive policy ANDs with the permissive one — so the capability without the
  policy is a counter hand opening the form, pressing Save, and writing **zero rows with no error
  at all**. Not a refusal: a silence. That exact failure has shipped here twice (0025's own comment
  for the driver, 0031 for the board, `lives_ok` passing throughout both times).
- **Three tables, not nine.** `laundry_orders`, `laundry_order_items` and `laundry_order_activity`.
  `invoices`, `invoice_lines`, `payments`, `credit_notes`, `credit_note_lines` and
  `laundry_prices` are left exactly as they were — the counter takes laundry in and cannot see,
  raise or alter a bill for it, which assertion 4 of the migration checks by name.
- **DELETE on the job itself is withheld.** Nothing in the app deletes a `laundry_orders` row —
  cancelling is a terminal status and hiding is `set_records_archived` — so granting a verb nobody
  uses is how a role quietly grows past its job. `laundry_order_items` is the one exception and
  genuinely needs it: `save_laundry_order_items()` is SECURITY INVOKER and replaces the child set
  by deleting and re-inserting, so without it the counter could take a job in and never correct
  what is on it.
- **`orders.manage` is not granted either**, in `roles.ts` or in the policy: cancelling, backdating
  a receipt and editing a completed job are the supervisor's set.
- **The proof asserts the write *landed*.** `main_flow_scope.test.sql` goes 18 → 29 assertions and
  counts the row afterwards rather than trusting `lives_ok` — the invoice is read back **as the
  owner**, because the counter cannot read `invoices` and a subquery returning NULL would have
  passed a broken policy. A stray fixture row from that insert then made a later assertion read 3
  where it expected 2, which is its own small lesson: a probe that writes must clean up after
  itself or it silently re-scopes everything below it.

**2. The activity log is for the people who answer for it** (`0035`). `audit_logs` carried 0001's
`for all … using is_member(tenant_id)` and nothing more, so a driver, a board, the counter and the
plant floor could all read the whole tenant's trail — who did what, to which record, when — off
PostgREST. It carries no price and no amount, which is why it outlived the billing narrowing.
- **SELECT** goes to the four roles holding `admin.read`: owner, office manager, regional manager
  and **auditor** — the last is why this is a role list and not `admin.write`; a read-only role
  whose whole purpose is to look at what happened would be absurd to shut out.
- **INSERT stays open to every member, and that is not an oversight.** `recordAudit()` runs on the
  *caller's* RLS-bound client at the moment they cause an event, so a driver completing a delivery
  writes their own row. Narrowing it would not tighten anything; it would silently stop the log
  recording the very people it exists to record. `actor_id` is pinned to `auth.uid()`, so nobody
  signs an entry in somebody else's name.
- **UPDATE and DELETE go to nobody.** The old `for all` handed both to any member, so a trail could
  be edited or erased by the person it incriminates. Nothing in `src/` does either — the only verbs
  anywhere are `insert` and `select` — so append-only costs the application nothing.
- **The `for all` policy is dropped, not supplemented.** Its USING half grants SELECT too, so
  narrowing the read beside it would have left the whole log readable through it. The same trap
  0033 found one table earlier and §22 records for 0017 before that.
- `audit_log_scope.test.sql` is new: 11 assertions, each by **outcome**. A refused SELECT is an
  empty result and a refused UPDATE is a silence, so both are counted afterwards from a session
  that can see the rows; only the `with check` half is asserted by raising.

**3. §22 said something the database does not do.** It claimed the agreement header is "readable to
`agreements.read`". `service_agreements` carries 0003's `for all … using is_member(tenant_id)`, so
**any member reads every contract header**. The decision behind the sentence is sound and is
unchanged — when a customer is served is operational information, and only the priced lines moved
behind `can_read_pricing()` — so the owner's call was to correct the wording rather than narrow the
policy. Recorded as a correction, because a file that describes a boundary the database does not
enforce is worse than one that says nothing.

**4. Adelaide's four boards have logins** (live data, no code). See §11 and §24. `board1@`…
`board4@ats.example.com`, written by SQL in GoTrue's own shape for the reason §3a records — this
deployment still cannot send an invitation. Verified column by column against the `board@` profile:
`aud`/`role`, confirmed, all eight token columns `''` rather than NULL (the 2026-08-18 trap),
`email_change_confirm_status` 0, `app_meta`, a bcrypt `$2a$` hash that verifies against the shared
password, exactly one email identity, `board` membership in Adelaide and nowhere else, and **not** a
platform admin. Boards linked went **1 of 5 → 5 of 5**, and `LJ00003`/`LJ00004` are no longer
assigned to rounds nobody can sign in as. **The shared password is a bootstrap, not a credential
policy** — it is deliberately in no committed file, and it wants changing once a real invitation
can be sent. **That is now possible**: the entry above this one moved auth mail onto Resend, so
each board can be sent its own sign-in link from the People screen and set its own password.

**The month-end run was rehearsed read-only, and the rehearsal is the finding.** Read-only because
generating writes drafts against 508 real customers, and the question was whether it would work,
not whether to bill. It would — and pressing it today would report **nothing to invoice**, which
reads as *everything is billed* rather than as *wrong month*. The default period is the previous
month (1–31 July, the 2026-08-20 fix), and Adelaide's one approved job `LJ00002` was completed on
**20 August**. So the operator has to set the period to August, or wait until September. The
default is right — the ordinary case is running last month's work — and the trap is that the first
real run happens mid-month against a job from the current one. Nothing in the code is wrong; this
is written down so the first run is not read as a failure.

- 700 unit tests (was 698) and **368 pgTAP assertions (was 348)**. `verify` green; all thirty-five
  migrations applied to a fresh Postgres 16 with the whole pgTAP suite and the seed on top.
- **Both new proofs were confirmed to fail without their migration** rather than assumed to be
  doing something: the counter block against unwidened 0025, and the audit block against the
  `for all` policy.

**Applied to `laundrymart-syd` on 2026-08-24** — §11 has the read-backs. Both migrations'
self-assertions passed, so neither could half-apply. Verified afterwards as **real sessions**:
board, driver and counter read **0** audit rows where auditor and owner read 47; the counter's
insert, item insert and edit all **landed** (1, 1, true) in a transaction that was then aborted,
leaving 0 probe rows. Advisors stayed at **18** — neither migration adds a function. 647 invoices,
508 archived customers, 8 laundry jobs, 20 memberships, 5 boards, 0 `anon` table grants and 0
tables without RLS, all as recorded.

### 2026-08-24 · Tidied: the rail collapses, and the type scale goes back down
The owner's response to the accessibility work, the same day: the side panel wanted collapsing
section by section, and the whole application read as oversized. Both fair. **No migration; no
schema, RLS, capability or workflow change**, and no destination moved.

- **The default type scale is back where it was, and the reason it can be is the control.** The
  accessibility pass raised labels to 16px, inputs to 16px, hints to 14px and the two small
  tokens to 12/13px, and the result was an application that looked shouted. The honest answer is
  that making every screen bigger for everybody is the *wrong* fix once a person who needs bigger
  can press one button and get 130% of everything. So `--text-2xs`/`--text-3xs` are 12/11px again,
  field labels are 14px, hints are 12px, and the toast is 14px.
- **Two exceptions, kept deliberately.** A field *error* stays at 13px, medium, in the danger
  colour: there is at most one on screen and it is the sentence saying why the work did not save.
  And `CONTROL` is **`text-base sm:text-sm`** — 16px on a phone, 14px from `sm` up. The two
  widths genuinely want different things: under 16px iOS zooms the page the moment an input takes
  focus, which throws a driver out of the layout they were working in, while on a desktop 16px
  inputs sit *larger* than the 15px body around them, which is most of what made the app read as
  oversized. One breakpoint buys both.
- **The rail is three collapsible groups** — "Day to day" open, "Customers & money" and "Set-up &
  reports" shut, with Help pinned outside them. An owner's rail goes from **12 flat rows to 6
  visible**, and every destination is still exactly one click from where it was.
- **This softens §6's "one flat list of areas — no headings, no nesting", and says so rather than
  doing it quietly.** That decision replaced a 22-row inventory of database tables under headings
  named after internal concepts, and none of that comes back: the *screens* inside an area are
  still tabs, never rail rows, so the rail still never becomes a table of contents for the schema.
  What changed is the count — the flat list was eleven rows when the decision was made, and Runs
  coming back on 2026-08-20 plus Platform before it made it thirteen.
- **Grouping is a way of drawing the rail, not a change to what the rail is.** `navigationFor()`
  still returns one flat list, so `sectionFor`, the tab strip and every existing test are
  untouched; `groupNavigation()` arranges that list for the rail alone. Groups are keyed on area
  hrefs in **one list in one place** rather than a flag per nav entry — the drift §19 records as
  a standing objection to the rejected simple mode — and an area named in no group **falls
  through to the ungrouped rows** rather than vanishing, which is the failure that would matter.
  `nav.test.ts` asserts every role's areas appear exactly once, that an invented area is drawn,
  and that Help never lands in a drawer.
- **A group holding the area you are in always draws open**, whatever the cookie says: a shut
  drawer with the active row inside it would leave the rail showing nowhere as "here". The open
  state rides an `es_nav` cookie read in the layout — the `es_rail` pattern, so the rail paints at
  the right height on the first frame instead of snapping after hydration — and stores the
  **shut** groups, so a release that adds a group gets that group's own default rather than a
  missing name reading as "closed". Collapsed (icon-only) the rail stays flat: there is nothing to
  shorten when every row is one glyph.
- **The headings are sentence case, not uppercase.** They went out uppercase first and that is
  precisely the treatment the 2026-08-13 redesign swept out of 28 files for reading as a developer
  console; §10b names `Eyebrow`'s 12px sentence case as the supporting-label voice, and a rail
  heading is the last place to reintroduce the other one.
- 698 unit tests (was 691), `verify` green. Re-measured light and dark at 320/390/768/1440 across
  all three text sizes: no console errors, no overflow, nothing under 36px, and the control border
  still 3.21:1 light / 3.01:1 dark.

### 2026-08-24 · Usable by somebody who has been shown it once
The owner's brief: a ten-year-old and a seventy-year-old who only knows how to turn on a laptop
must both be able to use this. Four specialist reviews first (UX, accessibility, business
analysis, frontend architecture) against `.claude/skills/`, then the work the evidence pointed
at. **No migration; no schema, RLS, capability, policy or workflow change** — every screen still
exists, every route still resolves, and no role gained or lost anything.

- **One rule makes the whole application bigger.** Every size in this app is `rem` — Tailwind 4's
  spacing scale is `calc(var(--spacing) * n)` with `--spacing: 0.25rem`, its type scale is rem,
  and `body` is rem — so moving the *root* font size scales text, padding, gaps, control heights
  and the rail's width together. `html[data-text-size]` in `globals.css` is three lines and it is
  a genuine zoom, not text growing out of the buttons around it. Measured: root 16 → 18.4 →
  20.8px, body 15 → 17.3 → 19.5px, and the smallest control in the new card 44 → 51 → 57px. The
  alternative lever — overriding `--spacing` and `--text-*` — was rejected because `--text-2xs`
  and `--text-3xs` are inlined by `@theme inline` and would not have moved, nor would the 18
  arbitrary `text-[13px]`-style sizes.
  **`normal` deliberately sets nothing**: somebody who has already raised their browser's default
  has said what they want, and pinning `16px` would overrule them. `rem` in a media query resolves
  against the browser's initial size, so breakpoints do not shift and a phone cannot flip to the
  desktop layout because the text grew.
- **The control is in three places, because the person who needs it will not find one.** A cycling
  button beside `ThemeToggle` in the header (the letters drawn at the size they select), a
  three-option labelled picker on the home screen, and the same picker **on the sign-in page** —
  which matters most of the three: somebody who cannot read the login screen cannot sign in to
  reach the one in the header, and the preference is stored per browser, so setting it there
  carries through to everything afterwards. All three share `lib/display.ts`; the preference
  rides `localStorage` and the root layout's pre-paint script beside the theme, because it has to
  be on `<html>` — `rem` resolves against the root element and nothing else, so a cookie read in
  `(app)/layout.tsx` and applied to a wrapper would have scaled nothing.
- **"What do you want to do?" is the way in.** The dashboard is a control tower: it answers "how
  is the day going" for somebody who already knows what the day is, and none of it is a way to
  *start* a piece of work. `lib/quick-actions.ts` is seven jobs stated as verbs, capability-
  filtered, first on the page. **This is not the simple mode §19 records as built and rejected**,
  and deliberately so: there is no mode flag, nothing is hidden, no rail row moves, and the
  standing objection — that a second hand-maintained list drifts from `nav.ts` — is answered by a
  test asserting every card's href is a real destination inside `NAVIGATION`.
- **The most-read sentence in the app was addressed to whoever wrote the schema.** `firstIssue`
  rendered the Zod path, so a rejected job form said `expected_delivery_date: Invalid input` —
  112 call sites. It now names the box as it is labelled on screen. `describeDbError`'s default
  case returned `error.message` verbatim, which is Postgres naming its own tables and columns to
  a counter; unrecognised codes now say that nothing was changed, and the detail goes to the
  server log. Both rules live in `lib/messages.ts`, not in `lib/actions.ts`, because that file
  imports `next/headers` and is unreachable from a unit test — the trap `plan.ts` and
  `order-items.ts` both record.
- **A test that asserted the defect was rewritten to the decision, not satisfied.**
  `actions.test.ts` pinned `"email: bad email"` — the developer-facing format, exactly. That
  assertion is why the format survived. The same move `laundry_pricing.test.sql` needed on
  2026-08-20.
- **Nothing dismisses itself any more.** A success toast disappeared after five seconds, and it
  is the *only* record that anything happened — the form has already been redirected away.
  Somebody who looks up to an empty screen assumes it did not save and does it again. Both tones
  now wait to be closed (WCAG 2.2.1), and the close button went 32 → 44px. This reverses a
  documented decision ("good news can pass by") and does so on purpose: it held for a fast reader.
- **Every input in the app had its focus ring switched off.** `CONTROL` carried
  `focus:outline-none focus:ring-2 focus:ring-primary/25`, which replaced the global 2px ring with
  a 25%-opacity halo measuring about 1.5:1 — under the 3:1 WCAG asks — on every input, select and
  textarea. The `outline-none` is gone and the ring is 3px. `:focus-visible` also set
  `border-radius: 2px`, which does not shape the outline (that already follows the element) but
  reshapes the *element*, so every button and card visibly squared off on focus.
- **Field errors are now part of the field.** `aria-describedby`, `aria-invalid` and
  `aria-errormessage` appeared nowhere in `src/`; `Field` wires the hint and the error to the
  control through context, so the ~200 call sites and the four control components need not pass
  it. Hints and errors went 12px → 14px, labels and typed values 14px → 16px — the last of which
  also stops iOS zooming the page on focus.
- **Plain words, where the word was the blocker.** "Jobs" (`/orders`) and "Stops" (`/jobs`) both
  read as "a job somebody has to do"; they are now **Customer laundry** and **Driver visits**.
  §6's decision is intact — both rows are still there, and `nav.test.ts` still asserts no rail
  href starts with `/routes/`. Eleven pages carried the trade term as an eyebrow directly above
  the plain-English title ("Sites" over "Depots"), re-teaching exactly the word the title was
  chosen to avoid; those are gone. "Danger zone" — over an action that is reversible — is now
  "Hide this customer" with `ConfirmSubmit` and the eyebrow "This can be undone".
- **`counted()` in `format.ts` retires `invoice(s)`.** The parenthetical plural is how a program
  writes when nobody has decided what it should say, and it is never right for either reading.
- **The help page taught the vocabulary boards replaced.** It defined "Assigned driver" and had
  no entry for a board at all, five days after the cutover made the round the unit work is given
  to. Rewritten around the delivery round.
- **Copy that was factually wrong is fixed.** The customer billing card said "This app does not
  connect to Xero" and "Nothing in this app talks to Xero" — untrue since 0026/0027, and a person
  who believed it would key every invoice twice.
- **The counter's own form is shorter.** Instructions and Job management are entirely optional and
  were expanded for every job; both are now disclosures. Neither contains a `required` field,
  which is the thing that would make this unsafe — a required control inside a closed `<details>`
  fails native validation with nothing to focus.
- **Three destructive controls were 16×50px of unpadded 12px text** ("Remove" on an invoice line,
  a contract line and a public holiday), and the run-sequencer arrows were 26×28 — where the
  2026-08-20 entry claims 36×36, which the shipped code never carried. All now ≥44px, and a
  `dangerGhost` button variant exists so a destructive control in a list row is not teal.
- 691 unit tests (was 621), `verify` green. `/design-preview` gained the card for two roles;
  asserted light and dark at 320/390/768/1440 **across all three text sizes** — 24 combinations,
  **zero console errors, zero overflow inside the card, and zero interactive targets under 36px
  anywhere on the page** (the only things left under it are the 18px checkbox *boxes*, which sit
  inside the 44px padded labels §10b describes). The sub-36px count across the gallery went 79 →
  0. Four defects were found by measuring rather than by looking: a grid item's `min-width: auto`
  pushing the row 6px wide, a `min-w` floor in `rem` that scaled with the text and so defeated
  itself, a label breaking mid-word ("deliverie/s") because Chromium has no hyphenation dictionary
  here, and five more `focus:outline-none` sites — three of them on `/my-runs`, the board's whole
  workspace — each killing the ring the same way `CONTROL` did.
- **A code review caught two things the tests did not, and both are worth reading.**
  - `validationMessage` was written as a **denylist** — it recognised Zod's known default
    wordings and passed anything else straight through. That is the wrong shape, and it was
    incomplete: `z.enum()` produces `Invalid option: expected one of "van"|"truck"|"ute"` and a
    bare `.min()` produces `Too small: expected number to be >=1950`, neither of which matched,
    so both went to a counter verbatim — the exact defect the module exists to prevent. It now
    builds its sentence from the issue's **structured fields** (`code`, `origin`, `format`,
    `minimum`), and lets a message through only when it survives a machine-text guard, so an
    unknown issue kind falls to a plain sentence rather than to Zod's. Safe by construction, the
    same shape `databaseMessage` already had. The tests missed it because they exercised neither
    kind; there is now a table of every validator family this app actually uses.
  - **The rail rename never reached the pages it points at.** `/orders` was still titled "Jobs"
    and `/jobs` still "Stops", so pressing the renamed row landed you on a heading carrying the
    exact word the rename existed to remove. Nothing caught it because every other navigation
    test asserts `nav.ts` against itself; the new one reads the page sources, which is the only
    way to compare the two halves — a `page.tsx` reaches Supabase at module scope and cannot be
    imported into a unit test.
- **Three contrast failures, computed rather than eyeballed, and fixed at the token layer.**
  - **A field did not look like a field.** `--strong` on the fill it outlines measures **1.42:1**
    light and **1.22:1** dark, where WCAG 1.4.11 asks 3:1 of anything identifying a control — and
    an input here is `bg-surface` on a card that is also `bg-surface`, so its border is the whole
    of what says "type here". A new `--control-border` token carries 3:1 and is used by `CONTROL`
    and the checkbox and nothing else. Deliberately *not* a change to `--strong`, which is 60
    call sites of card edges and table rules: those are decorative separators, explicitly outside
    1.4.11, and dragging them to 3:1 would turn YSM's paper into a wireframe. Verified as
    rendered: 69 controls at **3.21:1** light and **3.01:1** dark.
  - **`--muted-foreground` failed AA in dark where it lands most often** — 4.45:1 on a sunken
    panel, 4.76:1 on a card. It carries every hint, every table header, every description, and
    through `Eyebrow` the row label on every `DataTable` card on a phone. Both themes now clear
    **AAA** on page, card and sunken panel alike (7.0–8.7:1).
  - **The dark danger badge was 4.45:1**, just under AA, on the words "Overdue", "Cancelled" and
    "Void". Half a percent of lightness clears it.
  All three keep YSM's hue and saturation exactly and move only lightness — the precedent §10b
  already set when the dark palette was built.
- **Document-level overflow at the largest text on the narrowest phone is real and is recorded
  rather than hidden.** `/design-preview` overflows 7px at 320px today (pre-existing, the
  dispatch-planner fixture the 2026-08-16 entry already measured); at Large that becomes 55px and
  at Biggest 104px, and 34px at 390px. It is the same fixture scaling up, it is outside the new
  card (which measures 0 at every combination), and it is the honest cost of a real zoom on a
  320px screen. `/routes/planner` is unlinked from every rail, so nobody reaches it — but its
  controls were enlarged with the rest anyway rather than excused.

**Verified against `laundrymart-syd` on 2026-08-24, and there was nothing to apply.** This
branch adds **no migration**: the ledger's last entry is still `0033_laundry_prices_read`, and
`git diff --name-only` over `supabase/` is empty. What was checked anyway, because a release is
the moment to look: advisors still **18** (the 17 documented definer helpers and the auth
leaked-password toggle — no function added, none expected); **0** `anon` table grants and **0**
tables without RLS, so 0029 and the tenancy spine are holding; and 647 invoices, 508 archived
customers, 16 memberships, 5 boards and 9 prices, all exactly as recorded above.

**One check was specific to this branch and only the database could answer it.** `FIELD_LABELS`
maps 79 schema field names to the words on the label, and a typo there would silently fall back
to a derived name — right-looking and wrong. 76 are real columns in `public`; the other three
(`default_gst_rate`, `received_date`, `return_board`) are real *form* fields with no column
behind them, which is correct in each case — the middle one is the job form's date that
`receivedInstant()` composes into `received_at`, exactly as the 2026-08-13 entry describes.

**The authenticated screens themselves are still unopened.** This container has no Supabase
credentials. **Before trusting it: sign in as `owner@roles.example.com`, press each card on the
home screen, and set the text to Biggest on a phone.**

**Merged to `Dev` and `Prod` on 2026-08-24** (`de7e265`), so it is live on `ats.coreit.com.au`.
CI green on all three jobs for both branches — verify, gitleaks, and the DB job against a fresh
Postgres 16 with the whole pgTAP suite and the seed. **Both merges were clean fast-forwards**, and
`Dev` finally caught up: it had been 18 commits behind `Prod` since 2026-08-16, which the last
five changelog entries each recorded and none fixed. **No migration went with this one** — there
was none to apply, and the ledger's last entry is still `0033_laundry_prices_read`.

**Deliberately not done, because it is the owner's call and needs a migration** (§26): the
business analysis found that `orders.write` is held by two roles, and `customer_service` — the
role named for the counter — is not one of them, so the untrained person taking laundry in must
be made `operations_manager` and given 31 screens. Restoring it would cut that to about 11, but
it reverses the 2026-08-16 decision **and** needs `0025`'s restrictive write policies widened, or
the counter opens the form and writes zero rows with no error — the exact silent failure boards
hit in 0031.

### 2026-08-20 · The cutover, and a price list every member could read
The database was ready and the data was not: no board existed, no item said what kind of laundry
it was, and **the project held zero prices and zero rate cards**, so the Price button was inert
for every job in both laundries. Putting the first price list in is what exposed the defect below.
One migration (`0033`), no new table, no new column, no new function, no new capability, and no
row changed by the migration.

- **Every member of the laundry could read every price.** 0018 gated who may *change*
  `laundry_prices` and left the read policy at `is_member(tenant_id)` — the identical shape 0006
  shipped on `invoices` and that 0017 had replaced **one migration earlier**. Driver, counter,
  warehouse operator, dispatcher and, since 0031, a board: all nine rows, straight off PostgREST.
- **It hid behind an empty table and a proof that asserted it.** Nothing could leak while no
  price existed, and `laundry_pricing.test.sql` said in as many words *"the counter can read the
  tenant's prices"*, count 2. **A proof that encodes the defect defends it** — that assertion was
  rewritten to the decision rather than satisfied, the way the rate-card adoption rewrote four.
- **Two policies, and the second is the half that is easy to miss.** A permissive `for all`
  policy's USING clause grants SELECT as well, so narrowing `laundry_prices_read` alone would have
  left the whole list readable through `laundry_prices_write` to `dispatcher`, who holds no
  pricing capability at all. 0018's `for all` is now three explicit policies. The same trap §22
  records for 0017, one table later. **No write set changed in substance**: 0025's restrictive
  layer already ANDs `super_admin`/`operations_manager` over all of it.
- **Found by probing, not by reading.** Every table in `public` counted as a real `board` session
  — a sweep the boards work made possible for the first time. It is also what confirmed
  `invoices` 0, `service_agreement_lines` 0 and `xero_connections` refused at the grant level.
- **The three new assertions were proved to fail without the migration** — 10, 13 and 14 — rather
  than assumed to be doing something.
- 621 unit tests (unchanged: this adds no logic) and **348 pgTAP assertions (was 342)**. `verify`
  green; all thirty-three migrations applied to a fresh Postgres 16 with the whole suite and the
  seed on top.

**The cutover itself, applied live** (§11 has the read-backs):

- **Boards exist.** Adelaide Towel Service — the real laundry — has **Board 1–4**, unlinked,
  because no login exists for them and this deployment cannot send an invitation. Harbour has
  **Board 1**, linked to a new `board@roles.example.com` profile (§3a), with `RUN00002` as its run
  and LJ00004/LJ00005 on it. `operated_by_driver_id` carries Sam Okoye, which is the whole reason
  §24 kept drivers. Signed-in-as check: 1 board, 1 run, 2 stops, 3 jobs, 4 customers, **0
  invoices** — not the empty application the unlinked-driver failure produced in July.
- **Five items now decide their own kind of laundry.** The sixth, a laundry bag, is left null on
  purpose: it is a container the laundry lends, not laundry a customer hands in.
- **Harbour has a default price list; Adelaide deliberately does not.** Inventing rates for a real
  business is not a repair — the owner enters theirs at Money › Laundry prices, and until they do
  the pricer will keep saying so by name.
- **Two false rows from the 2026-08-18 cross-tenant bug were cleared**: `RUN00001` (Adelaide,
  crewed by a Harbour driver) and `RUN00004` (Harbour, crewed by an Adelaide driver). Both were
  `planned` with **0 stops worked, 0 deliveries and 0 pickups**, so `driver_id` recorded nothing
  that happened. Nothing was deleted and the ids are recorded: Sam Okoye
  `60000000-0000-4000-8000-000000000001` on Adelaide's `RUN00001`, Mario Forte
  `fa1a7cb7-dcf0-484b-a5fe-65755c55f1ce` on Harbour's `RUN00004`.
- **`LJ00001` was deliberately not repaired.** It is an Adelaide job whose customer belongs to
  Harbour, still `ready_for_delivery`. Its remedy is cancellation, which is terminal, and it is a
  job against a customer rather than a bug's leftover — the owner's call.

**Still not done, and it needs a browser rather than this container: take one job through
complete → Price this job → Approve → run the month.** The roll-up has never been exercised
against real rows. Harbour is now the laundry where that will work, because it is the one with
prices in it.

### 2026-08-20 · The client's change requests: periodic billing, boards, run order, item codes
Nineteen change requests, reviewed against the code first
(`docs/CHANGE-REVIEW-2026-08-20.md`) and then built in the order that review
recommended. **Two migrations (`0031`, `0032`), two new tables, nothing dropped
and no existing row invalidated.**

**Priority 1 — the invoice now summarises.** A consolidated invoice wrote one
line per job charge, prefixed with the job number, so ten jobs of towels, sheets
and pillowcases came out as thirty lines. `consolidateChargeLines` rolls them
into one line per item; the rule is pure and lives in `lib/domain/` because a
rule stated in `lib/invoices/` reaches `lib/env` and is unreachable from a test.
Three decisions in it, each tested: unit price and GST are part of the grouping
key, so a mid-period rate change stays two lines at the two rates actually
charged rather than one at an average nobody agreed to; a charge merges only
when it names a kind of laundry, so three deliveries' fuel levies stay three
lines with their job numbers on them — an event is not a quantity; and amounts
are summed rather than recomputed, so the invoice total equals the frozen
snapshots to the cent. **`invoice_lines.laundry_order_id` is null on a rolled-up
line**, which is safe only because the billed-once constraint is
`uq_invoice_source_jobs_once` and not that column — the pointer is still written
wherever a line belongs to exactly one job, so a per-job invoice is unchanged.
The breakdown is neither lost nor duplicated: `loadInvoiceBreakdown` reads it
back through `invoice_source_jobs → laundry_orders → job_charge_snapshots` and
renders it under the lines on screen and in the PDF, grouped into ISO weeks. A
second stored copy would be the one that goes stale. New `/billing` screen under
Money: quick filters defaulting to **last month**, the period in the URL, then a
customer list with jobs, pieces of laundry, value and a three-state invoice
status — *part invoiced* is a real answer, and reporting it as invoiced is how
the rest never gets billed. **No migration**; every column it needs existed.

**Priority 2 — the round is the operational unit, not the person** (`0031`).
Work is given to **Board 1**, and whoever is driving Board 1 today signs in as
it. **Drivers are kept**: a board is a round and a driver is a person, and when
a delivery goes astray the business still has to say who was holding it —
`daily_routes.operated_by_driver_id` is one field instead of the reassignment
sweep the client is asking to be rid of. **The half that is not labels is RLS**:
`current_driver_id()` scopes four policy families, and a board login without a
board equivalent signs in successfully and sees an empty application, which
reads as a broken app rather than a missing link — the failure already shipped
here once with an unlinked driver. See §24.

**Priority 3 — Runs is back, as an ordering screen** (no migration). Not the
run-management area the 2026-08-14 simplification removed: no run codes, no run
CRUD, `/routes/*` still unlinked and `nav.test.ts` still asserts it. Pick a day
and a board, drag the stops or use the arrows, Save order. **Ordering is by
stop**, because a customer with two jobs on one day is one visit and ordering
them apart would mean driving there twice; each position lists the jobs at it,
so for the ordinary case it reads exactly as the client describes. A stop the
round has already worked cannot move. My Runs sorts by that sequence and prints
the position — an order the round cannot see is a decision that was never made.

**Priority 4 — one item vocabulary, under the code the staff know** (`0032`).
See §25. Additive by construction, and the MYOB **importer is deliberately not
built**: §14 of the brief says the developer must inspect the real export rather
than assume its column names, and it is right.

**Three defects found by the tools rather than by review, each worth recording:**
- rebuilding `guard_laundry_order_transition` from 0016 silently dropped the
  billing hook 0017 added underneath it, so completing a job stopped setting
  `awaiting_review` and no finished job would ever have reached the billing
  queue — a revenue bug behind a green build. `job_billing.test.sql` caught it.
  **A `create or replace` must be rebuilt from the latest ancestor, not the one
  that introduced the feature you are changing.**
- 0025's *restrictive* write layer carves out the driver only, so a board could
  never complete its own delivery: zero rows, no error, job stuck at
  `out_for_delivery` for ever. Widened in 0031, and proved by removing the fix
  and watching the assertion that the write **landed** fail — `lives_ok` passed
  throughout, which is the shape of the bug.
- the reorder arrows were 34px wide against the 36px floor and the job-number
  link in a stop row was an 18px tap target. Found by *measuring* the gallery,
  not by looking at it. Both now 36×36 and 60×36.

621 unit tests (was 535) and **342 pgTAP assertions (was 306)**. `verify` green;
every migration applied to a fresh Postgres 16 with the whole pgTAP suite and the
seed on top of it. The gallery gained the run sequencing board in three states,
the bulk move, the period filter and the consolidated lines built by the real
rule; asserted light and dark at 320/360/390/768/1024/1440 — no console errors
and no overflow inside either new section.

**Applied to `laundrymart-syd` on 2026-08-20** — §11 has the full record: the
pre-flight that confirmed the live transition guard still carried 0017's billing
hook before it was rebuilt, zero constraint violations against live data, and
five behavioural probes against real rows in a rolled-back transaction (a
driver-only assignment refused, a cross-tenant board refused, the laundry's own
board accepted, Remove Assignment clearing the board, and the item trigger
overruling a wrong category). 647 invoices, 508 archived customers and 15
memberships untouched; five jobs keep their original driver.

**Merged to `Prod` on 2026-08-20** (`e3cb0a8`), so it is live on
`ats.coreit.com.au`. CI green on all three jobs — verify, gitleaks, and the DB
job against a fresh Postgres 16 with the whole pgTAP suite and the seed. The
migrations went on **before** the merge, so the schema led the code: the safe
order, and the same one the 2026-08-18 entry records. `Dev` is still the stale
branch the 2026-08-16 entry noted; this took the same route as the last seven
features.

**The screens have still not been opened with real rows in them.** No board
exists yet, so §24's cutover is the first thing to do.

### 2026-08-20 · The owner login was at an address nothing tells you about
Reported as "password and emails are not working for owner email address — says invalid details".
It was one fault with two faces, and neither was the account. **No migration; no schema, RLS,
capability or workflow change.**

- **`owner@roles.example.com` did not exist.** The owner test profile is provisioned at
  `super-admin@roles.example.com`, because `profileEmail()` derived the local part from the role
  *identifier* — while `ROLE_PRESETS` labels `super_admin` "Owner", the People picker offers it
  that way, and the profile is literally named "Test Owner". Every word the app puts in front of
  a person said Owner; the one string they had to type said super-admin. Typing `owner@` got
  "That email and password combination was not recognised", which was true and told them nothing.
  A profile may now carry its own `email` local part, and `super_admin` does.
- **The account was never the problem, and that was worth proving rather than assuming.** All
  eleven test logins verify against `RoleTest!2026` on the live project — checked with
  `encrypted_password = crypt(...)` — with well-formed `auth.identities`, `email_verified` true
  and `app_metadata.provider = email`. Both real owner logins (`darshan@`, `jay@`) are
  `super_admin` in both laundries and platform admins, and `jay@` signed in **successfully** at
  05:06 the same morning, two minutes before the two `invalid_credentials` failures in the auth
  log. Nothing was broken; an address simply did not exist.
- **`formerly` is why the rename is not a second owner.** Renaming a profile without it would
  leave the old login holding the same `super_admin` membership in the demo laundry, at an
  address nothing documents, with `--remove` cleaning up neither. The runner looks a profile up
  under its former address and renames that login in place, so its id — and its membership, its
  driver row, every `created_by` pointing at it — survives.
- **The magic link had never sent an email, and said it had, every time.** `sendMagicLink`
  swallowed every error and always answered "a sign-in link is on its way". The live project has
  **never issued one**: zero `auth.one_time_tokens`, zero `flow_state`, and
  `confirmation_sent_at`/`recovery_sent_at`/`invited_at` NULL on all thirteen logins since the
  project was created. So the second half of the report — "emails are not working" — was a
  deployment with no working mail sender wearing a success message. The anti-enumeration
  reasoning was right and is kept: **a failure true of every address says nothing about any
  address**, so `error_sending_email`, `email_provider_disabled`, both rate limits, a rejected
  redirect and any 5xx are now named plainly, while "no such login" still answers exactly as
  success does. `otp_disabled` is deliberately *not* named — it is what an unknown address comes
  back as, and is precisely the fact the form must not confirm.
- **The link form could also mint orphan logins.** `signInWithOtp` defaults to
  `shouldCreateUser: true`, so a mistyped address created a real `auth.users` row with no
  membership — a login that exists, receives mail and dead-ends on "not linked to a laundry yet".
  Access here is granted by an administrator inviting somebody (§10c), never by turning up at the
  login screen, so it is `false` now.
- The rule lives in `src/lib/auth/magic-link.ts` rather than in the action, for the reason §2
  gives: a `"use server"` module can export nothing but server actions, and a rule written inside
  one is unreachable from a unit test — the trap `plan.ts` and `order-items.ts` both record, and
  both of those shipped broken behind a green `verify`.
- 535 unit tests (was 525). `verify` green — typecheck, lint, tests and the production build.

**Applied to `laundrymart-syd` on 2026-08-20**, rehearsed first in a rolled-back transaction the
way §11 requires: `super-admin@roles.example.com` → `owner@roles.example.com`, same user id
`0289aa41-…`, `auth.identities.identity_data.email` updated with it (the `identities.email`
column is generated from it), password still verifying, membership still
`Harbour Commercial Laundry = super_admin`. All eleven role logins re-read afterwards: every one
confirmed, every password verifying, the driver still holding its `drivers` row, and none of them
a platform admin. Nothing else on the project was touched.

**Merged to `Prod` on 2026-08-20**, so it is live on `ats.coreit.com.au`. CI green on all three
jobs (verify, gitleaks, and the DB job — migrations, the whole pgTAP suite and the seed against a
fresh Postgres 16). **No migration in this one, and nothing to apply**: the ledger's last entry is
still `0030_member_directory`. The only live change was the login rename above, which was applied
before the merge — so the address existed before the code that documents it shipped, which is the
safe order. `Dev` is still the stale branch the 2026-08-16 entry recorded; this went the same
route the last six features took.

**Was still true then and is fixed now.** This entry closed with: *this deployment cannot send any
auth email — the magic link now says so instead of pretending, but saying so is not sending.* The
remedy it named was custom SMTP on the Supabase project. The 2026-08-24 entry took the other road
and moved auth mail onto **Resend**, the sender the invoices already used, so no SMTP is needed at
all. The reasoning here is untouched and still load-bearing: the anti-enumeration rule, the
refusal to create a login from the sign-in box, and the fact that a form which always claims
success teaches nobody anything.

### 2026-08-20 · Month end is a month-end button, and every customer can be priced
A review of "job completed → invoice pool → one press at month end" against the code. The
spine was already right — completion never bills, the pool is real, the dated run sweeps
approved jobs from frozen snapshots — and four things stood between it and being usable.
**No migration; no schema, RLS, capability or workflow change.**

- **The automatic pricer refused every real customer, and threw away the answer it had.**
  `priceJobCharges` computed the lines — `priceJobFromRateCard` reads the rate card *and* the
  laundry price list beneath it — and then returned "this customer has no rate card, so nothing
  can be priced automatically" before saving them. **508 of 508 live customers hold no rate
  card**, so the button was inert for every job in the business and hand-entry was the only
  path to a priced job. The tier beneath the card is the whole reason 0018 survived the rate-card
  adoption (§21), and the action was the one place that did not know. It now refuses on the fact
  that matters — *nothing came back priced*, whichever tier was asked — and the message names the
  screen that fixes it, the rate card or the price list depending on which is missing.
- **Nothing could be priced in bulk, which is what made month end a per-job errand.** Approving
  in bulk needs charges on every job, and the only way to put them there was to open each job.
  **Price Selected** is the queue's new verb. Review mode now carries two verbs over one
  selection, which is why an unpriced row became selectable — it was deliberately not, because a
  tick that could only half-fail is worse than no tick, and that reasoning ends the moment there
  is a verb that applies to exactly those rows. Approving an unpriced job is still refused, by
  `checkBillingTransition`, named job by job.
- **The month-end run defaulted to the month you are standing in.** The period fields read
  1st-of-this-month → today, so pressing it on 1 September billed September 1–1, found nothing,
  and reported "nothing to invoice" — which reads as *everything is billed*, not as *wrong
  month*. It defaults to the previous month now (`previousMonth` in `dates.ts`, tested at the
  year boundary and on a leap February, because an inline `getMonth() - 1` gets both wrong).
  The button and the card say "last month's invoices" so the default is not a surprise.
- **Issue had no bulk form, so Send Selected could not be reached.** Generating writes drafts,
  sending refuses a draft — correctly — and issuing was one invoice at a time. Forty invoices was
  forty presses before the bulk send was usable at all. **Issue Selected** is the missing rung;
  `lib/invoices/issue.ts` is now the single implementation, shared with the single button, so the
  Xero push and its never-block-the-money contract cannot drift between them. A Xero refusal is
  **not** an issue failure and is counted separately rather than hidden.
- **`update` matching nothing is not an error to PostgREST**, and in bulk that is the outcome
  most needing a name: an invoice already issued, already void, or belonging to another laundry
  would otherwise count as a success and the operator reads "issued 40" over a batch of 37.
  `issueOneInvoice` selects the updated row back and says "it is no longer a draft".
- **Four reads that feed a write now name their tenant** (§23): the billing queue, the issue
  list, the send list, and the price-list read inside `priceJobFromRateCard` — where `tenantId`
  is a **required argument**, so the typechecker stops the next call site forgetting. That last
  one matters more than it did yesterday: the default price list is the row with
  `customer_id is null`, and unfiltered a platform admin's session brings back two laundries'
  defaults and `priceListFor` takes whichever the plan returned first.
- `SendSelected` became `InvoiceSelection`, one component with the verb passed in, rather than a
  copy for the issue list — and picked up the shared checkbox skin on the way, since it still
  carried the bare 16px box the 2026-08-17 entry swept out of the other two billing components.
  Measured after: every control in the section is ≥36px and every checkbox sits in a 44px label.
- 525 unit tests (was 515). `verify` green. The gallery gained the issue and send lists and the
  two-verb queue; asserted light and dark at 320/360/390/768/1024/1440 — no console errors and
  no overflow inside the section. The 7px document overflow at 320 and 1024 is the pre-existing
  dispatch-planner fixture the 2026-08-16 entry already measured, unchanged by this.

**Not verified against a live project.** This container has no Supabase credentials, so no job
was priced and no invoice issued with real rows behind it. **Before trusting it: take one job in
on `ats.coreit.com.au`, complete it, press Price this job in Money › Awaiting invoice, approve
it, run last month, then Issue drafts and Send.** The pricing fix is the one to watch — it is
the first time the price-list tier has been reachable from a screen.

**Merged to `Prod` on 2026-08-20**, so it is live on `ats.coreit.com.au`. CI green on all three
jobs (verify, gitleaks, and the DB job — migrations, the whole pgTAP suite and the seed against a
fresh Postgres 16). No migration in this one: the database was already correct, and `Dev` is still
the 15-commits-behind branch the 2026-08-16 entry recorded — this went the same route the last
five features took.

### 2026-08-18 · Assign Driver refused every time, blaming a race that never happened
"Somebody else changed this job's driver a moment ago" on a job nobody else had touched. No
migration; no schema, RLS, capability or workflow change.

- **The message was wrong and so was the model behind it.** The UPDATE is filtered to
  `session.tenantId` as a race guard; it matched no row because the job belonged to a *different
  laundry* from the one the person was working in. Only a platform admin can be in that position:
  `is_member()` is true of every laundry for them (0019), so the job opened and read normally,
  while every write is scoped to the active one.
- **It had already written three kinds of wrong row, silently.** Live: two runs in Harbour created
  by the failed attempts — one of them crewed by **Mario Forte, who drives for Adelaide, at
  Adelaide's depot** — plus their stops; and `LJ00001`, a job raised in Adelaide against **a
  Harbour customer**, from a picker that offered both laundries' customers. The assignment guard
  (0016) never fired, because the job update failed before it.
- **The fix is that a read which feeds a write must name its tenant.** Every reader in
  `lib/runs/my-runs.ts` and `my-runs/actions.ts` now takes the tenant as a **required argument**
  rather than accepting an unfiltered client — so the typechecker, not a reviewer, is what stops
  the next call site forgetting. The same filter went on the jobs list, the job form's customers,
  sites, drivers and staff, the orders filter bar, the dispatch card, and the customer lookup in
  both `createOrder` and `updateOrder` (an edit posts the customer back, so it was the same door).
- **Two things now say what is true.** A job from another laundry shows "This job belongs to
  another laundry — switch laundry in the account menu", instead of a driver picker that cannot
  work; and if the action is posted anyway it names the business rather than inventing a race.
  One extra query, only on the failure path.
- **`/orders/:id` deliberately still opens a job from another laundry.** Looking is what that role
  is for; what it may not do is *act*. Reads across, writes within.
- **What is not swept is written down rather than left to be rediscovered** (§23): ~350 of 451
  `.from(...)` reads in `src/` still rely on RLS alone. Every one is correct for the other ten
  roles. Three options are recorded there, including the cheapest — stop using `platform_admin`
  as an everyday identity, since both holders also hold `super_admin` in both laundries.
- 515 unit tests, `verify` green. Reproduced from the live rows rather than assumed: the two
  orphan runs, their stops, and the cross-tenant customer on LJ00001 are all still there to look
  at, and none of them was deleted by this change.

**Merged to `Prod` on 2026-08-18** with the entry below, so both are live on `ats.coreit.com.au`.
No migration in this one: the database was already correct — it was the app that was reading
across two businesses.

### 2026-08-18 · People have names, and platform administrators are not staff
Found on the deployed app: the job's Reassign picker offered `8c2b996b… · Driver`, two addresses
listed twice each, and a third `Super Admin` nobody could identify. Three separate faults behind
one screenshot. One migration (`0030`), no new table, no new column, no new policy, no new
capability, and no row changed by the migration.

- **The name was never asked for and never shown.** Every screen that puts a person beside a job
  resolved `user_id` through the GoTrue admin API, which returns an *address* — so the best case
  was an email and the worst was eight characters of a UUID. `tenant_members()` reads the name out
  of `auth.users` in one query instead, and the invitation form now asks for a full name, required,
  because a picker cannot show what nobody was ever asked for. An existing person can be renamed on
  the People screen.
- **Eleven of the thirteen logins were the worst case, for a reason worth writing down.** The role
  profiles (§3a) were written into `auth.users` by hand SQL, leaving four token columns NULL —
  which GoTrue reads into non-nullable strings, so `getUserById` failed for exactly those eleven
  and succeeded for the two created through the API. That is why the two personal addresses
  resolved and every test profile did not. Repaired live (§11); the new read path does not go
  through GoTrue at all.
- **The duplicates were a tenancy bug in plain sight.** `memberships` was read through RLS with no
  `tenant_id` filter, and `is_member()` is true of *every* laundry for a platform admin (0019) — so
  their session listed each of their memberships once per laundry. `tenant_members(t)` is scoped by
  argument, and its proof asserts a platform admin reading one laundry at a time.
- **Platform administrators are out of every list a person is picked from** — the job assignment
  and completion pickers, the driver-login picker, and Administration → People. The owner's
  decision, and it holds for the signed-in platform administrator too: they are not offered to
  themselves. **They are deliberately still resolved by name**, because a job one of them created
  still has to say who created it. `staffMembers()` versus `memberNames()` is that line, and both
  are pure and tested.
- **Two consequences that had to be built rather than discovered later.** A job assigned to
  somebody the list no longer offers must not open showing "Nobody" — an unmatched `defaultValue`
  selects the placeholder and the next save silently clears the assignment, so `withCurrentHolder`
  adds the stored holder back, the way `receivedViaOptions()` already does for a legacy job.
  And a laundry with **no** pickable staff — which `Adelaide Towel Service` is today, both its
  members being platform administrators — would have rendered a `required` select with no options:
  a completion form that cannot be submitted and does not say why. It now says why and links to
  the People screen.
- **The activity log stopped printing UUIDs too.** It showed `af9fed7e…` in the Actor column, which
  is the one thing an audit log must not do.
- `src/lib/staff.ts` and `src/lib/members.ts` are deleted, not left beside the new module: they
  were two copies of the same admin-API lookup, and the second one existed because the first was
  private to one screen.
- 515 unit tests (was 496) and **306 pgTAP assertions (was 292)**. `verify` green; every migration
  applied to a fresh Postgres 16 with the whole pgTAP suite and the seed run on top of it. The
  gallery gained the empty-staff state and its staff fixture stopped being two email addresses;
  asserted light and dark at 320/360/390/768/1440 — no console errors and no new overflow.

**Applied to `laundrymart-syd` on 2026-08-18** (§11), rehearsed first and read back as a real
member: 13 people in the demo laundry, 11 of them named, 2 platform administrators flagged and
excluded, and Adelaide refused at 42501 to a member of the other laundry.

**Before trusting it: invite one real person into `Adelaide Towel Service`.** Its only two members
are platform administrators, so until then its People screen and its job pickers are empty by
design.

**Merged to `Prod` on 2026-08-18.** `0030` was applied to `laundrymart-syd` before the merge, so
the schema led the code rather than the other way round — the safe order for an additive read.

### 2026-08-17 · The billing screens reach the gallery, and two hand-rolled checkboxes with them
Closing the adoption properly. §10b requires a new module to land in `/design-preview`, and the
rate-card merge had not: its two client components were unreachable to look at, on pages that are
async server components reading Supabase. No migration, no schema, no capability.

- **Both are compose-locally-commit-once components**, which is the class that has shipped broken
  twice in this repo behind a green `verify` — the job form's items and the planner's whole board.
  `BillingQueue` (approve, generate and the empty state) and `JobChargesEditor` now render with
  fixtures. One queue fixture deliberately carries `chargeCount: 0`: that job cannot be approved,
  so the row must be unselectable with a reason beside it rather than offering a tick that would
  half-fail.
- **The gallery immediately earned it, which is the whole argument for §10b.** Both components
  hand-rolled `<input type="checkbox" className="size-4 rounded border">` at the call site — a
  bare **16px** tap target, where every other checkbox in the app is the shared `Checkbox`'s 18px
  box inside a `min-h-11` padded label. That is precisely the "one input skin — import it, never
  restyle an input at the call site" rule. Eleven of them, measured rather than noticed.
- **The shared component could not simply be dropped in**, and the comments say why: `Checkbox` is
  uncontrolled, and both of these hold their selection in React state. So they take its *skin* and
  its *padded-label hit area* instead. Measured after: every checkbox now has a **44px** hit area
  (36×44 in the queue, 103×44 on "GST applies").
- **Asserted at 320/360/375/390/430/768/820/1024/1280/1440, light and dark**: no overflow inside
  the section and no console errors anywhere. The 7px document overflow at 320 and 1024 is the
  pre-existing dispatch-planner fixture that the 2026-08-16 entry already measured, unchanged by
  this.
- 496 unit tests, `verify` green. Nothing behind the auth gate changed behaviour.

### 2026-08-17 · `anon` could have truncated every table; the grants and their source are gone
The last open security item from §11, closed. One migration (`0029`), no table, no column, no
policy, no row changed — and nothing granted to `authenticated` or `service_role` touched.

- **It was worse than the note said, in two ways.** The finding recorded "SELECT and INSERT"; it
  was actually **all seven privileges** — DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE,
  UPDATE — on **52 of 53** tables. And "inert, because RLS is on everywhere" was the wrong
  reassurance: **RLS filters rows, so it has nothing to say about TRUNCATE**, which empties the
  table whatever the policies are. What actually stood between the public anon key and a wiped
  database was PostgREST not exposing that verb, plus 0011 having revoked every function. That is
  one accident from being untrue, and it is not a property to rely on.
- **None of it came from this repo.** `0001` grants `anon` schema USAGE and nothing else. Every
  table privilege arrived from **Supabase's stock default privileges**, which grant `anon` and
  `authenticated` on each new table in `public`. So revoking today's grants is only half the fix:
  without rewriting the default privileges the next migration that adds a table reopens it — which
  is exactly what happened between 0011 closing the function half and now.
- **The local harness was reproducing a friendlier database than the real one**, which is the
  reason this hid for months. `pg-bootstrap.sql` had no such default ACLs, so `anon` held **0**
  table grants locally and any assertion about it passed vacuously. The shim now mirrors
  Supabase's default privileges: a local run went from 0 to **364** anon grants before 0029, and
  to 0 after. Both new pgTAP assertions were confirmed to **fail** without the migration.
- **Two proofs, not one.** `rls_coverage` now asserts that `anon` holds no table privilege *and*
  that a table created after the migrations arrives with none — the second is the regression that
  actually matters, since every previous table got its grant that way without any migration
  asking.
- **What is deliberately left alone:** `authenticated` and `service_role` keep everything;
  `usage on schema public` stays granted to `anon` (with nothing reachable, keeping it makes a
  future mistake read as "permission denied for table" rather than a confusing schema error); and
  the `storage`, `graphql` and `graphql_public` default ACLs are Supabase's own — `storage.objects`
  carries 0007's media policies and breaking it would take the driver's photo capture with it.
- **292 pgTAP assertions** (was 290), 496 unit tests, `verify` green.

**Applied to `laundrymart-syd` on 2026-08-17**, rehearsed first: 364 anon grants → 0,
`authenticated` unchanged at 364, `service_role` at 371, a real signed-in owner still reading,
`anon` refused at 42501, a brand-new table arriving with zero anon grants, and 647 invoices /
508 archived customers / 5 jobs untouched. **One residual is recorded in §11 rather than hidden:**
three default ACLs owned by `supabase_admin` still name `anon` and cannot be altered by
`postgres`. They are latent — no table in `public` is owned by that role — but they want
re-checking after any Supabase platform upgrade.

### 2026-08-17 · A driver could be created but not linked, so My Runs was empty
Found while setting up one trial driver in the real laundry, which had **no `drivers` rows at
all**. No migration, no schema, no capability.

- **`current_driver_id()` matches `drivers.user_id`, so an unlinked driver signs in to empty
  screens** — a login that works and shows nothing, which reads as a broken app rather than as a
  missing link.
- **The link was effectively unmakeable.** The Drivers screen asked for a raw UUID, hinted "paste
  from Administration → Users" — and the People screen has shown *emails and not ids* since it was
  rewritten to resolve them. Both the Login column and the Add-driver form now offer a picker of
  the tenant's unlinked members.
- **The picker is deliberately not filtered to the `driver` role.** A laundry whose owner drives a
  van, or a manager covering a run, is ordinary; refusing to link them would have the app insisting
  they cannot drive while they are out driving. Roles say what somebody may *do*; this link says
  *which driver they are*.
- `memberEmails` moved out of the People page into `src/lib/members.ts`. It keeps the rule §2 sets
  for the admin client: the caller passes ids it already got through RLS, and this asks for each
  one — it never lists users globally and filters afterwards.
- 496 unit tests, `verify` green. **One trial driver is live on `laundrymart-syd`** — Mario Forte,
  D001, Adelaide depot — with no login linked yet, because no invitation can be sent from this
  container.

### 2026-08-17 · One pricing model: the rate card adopted, the second one retired
Two rival answers to "what is this customer charged?" had both been live on the database since
15 August — `laundry_prices` (0018, with all the code) and the unmerged
`customer-pricing-invoicing` branch's rate card (0017, with none). The owner's decision was to
**adopt the branch**. One new migration (`0028`), no new table, no new role, nothing dropped from
the schema. §21 and §22 hold the design.

- **A job's money is now decided once, by a person, and frozen.** Completing a job sets
  `awaiting_review` and bills nobody; a reviewer prices it, approves it, and `frozen_at` makes the
  charge rows unwritable — including to `super_admin`. The monthly run bills what was *approved*,
  from `job_charge_snapshots`, so re-pricing a customer between approval and generation cannot
  move an invoice.
- **`laundry_prices` was not retired, and that is a deliberate departure from "retire it".**
  `priceJob` reads the rate card only, and **508 of 508 real customers hold no rate card** — so
  retiring the list would have priced every job at nothing, reported the lot as unpriced, and put
  508 negotiated agreements between the owner and their next invoice. The list is now the **tier
  beneath** the card: rate line wins outright, price list answers where the card is silent, and a
  kind of laundry neither covers is still *reported* rather than billed at zero. Precedence is per
  kind of laundry, not per customer — a card covering towels and silent on sheets is the ordinary
  case. 9 tests, 4 of which fail against the pricer without the tier.
- **The old batch pricer was deleted, not left beside the new one.** `buildLaundryCharges` and
  `describeUnpriced` priced a whole period's jobs at generation time; keeping them would have been
  precisely the "two answers, and the dead one looks live" this adoption exists to end.
  `priceListFor` and `defaultPriceList` stay — they are the list, not the pricer.
- **The role model is 0025's, not the branch's.** The branch predates the narrowing and gave
  `pricing.*` to sales and the whole ledger to finance. `pricing.*` and `billing.*` are instead
  **added to `JOB_TO_INVOICE`**, so they are subtracted from every other role — what a customer is
  charged is the first half of job→invoice. Four of the branch's own tests asserted the old model
  and were rewritten to the decision rather than satisfied.
- **`0028` fixes a hole that only a fresh database has, and CI is the only place it could be
  caught.** Two migrations are numbered 0017. Live they went on pricing-first, so
  `0017_archive_records` wrapped the policies the pricing migration had written — correct. On a
  fresh database `0017_archive_records.sql` sorts *first*, so the rewrite landed after the wrap and
  discarded `archived_at is null` from twelve permissive policies: **an archived invoice became
  readable again**. `archive_records.test.sql` failed with `not ok 10 - the invoice is hidden`.
  0028 restores the clause, on permissive policies only — 0025's restrictive ones AND on top and
  must not be touched — and asserts its own outcome. A rename would have fixed fresh databases and
  left any already-wrong deployment wrong, which is what forward-only is for.
- **A stray NUL byte was removed from `laundry-billing.ts`**, pre-existing and in `HEAD`. Harmless
  in behaviour — it sat inside a sentinel string that matches no customer either way — but it made
  the file read as *binary* to grep, ripgrep and every review tool, which is how it went unnoticed.
- **The generator's period edges were composed in UTC** on the branch (`${end}T23:59:59Z`) and now
  use `toInstant`, so a job finished at 9am Sydney on the 1st is not swept onto the previous
  month's invoice.
- 487 unit tests and **290 pgTAP assertions** (was 242). `verify` green; every migration applied to
  a fresh Postgres 16 with the whole pgTAP suite and the seed run on top of it.

**Not applied to `laundrymart-syd`: only `0028` is new, and it is a no-op there** — the live
policies already carry the clause, because the ordering was lucky. It still wants applying so the
ledger matches. **Nothing else in this entry touches the live schema**: `0017_customer_pricing_billing`
has been applied since 15 August; what changed today is that the code which uses it finally landed.

**Before trusting it: no invoice has yet been generated from an approved job.** Take one job in,
complete it, price and approve it in Money › Awaiting invoice, then run the month and read the
draft.

### 2026-08-17 · Billing reaches Xero: invoices, then the payments that settle them
The owner's billing design, built rather than redesigned: **the pre-agreed rate per service per
client already lives where it should** — `service_agreement_lines` for a contract and
`laundry_prices` for counter laundry — and `generateInvoices` already raises one invoice per
customer per month for the work completed in it. What was missing was the last hop: the invoice
never left this database. Two migrations (`0026`, `0027`), no new role, no new capability,
nothing dropped. See §20 for the system.

- **One Xero organisation per laundry.** `xero_connections` is keyed on `tenant_id`. A
  deployment-wide connection works exactly until a second real business arrives and then posts
  one laundry's receivables into another's books — and this deployment already runs two.
- **The first table in the schema `authenticated` may not touch at all.** A refresh token is a
  bearer credential for somebody's accounting system and no screen needs its value, so RLS is on
  with a policy that denies both directions outright *and* the table grants are revoked. The
  Settings screen reads `xero_connection_status()` instead — definer, role-checked inside,
  returning the organisation name, the timestamps and the bank account and never a token.
- **Neither push ever blocks the money.** `issueInvoice` issues and *then* pushes; a refusal
  leaves the invoice issued with `xero_push_error` set and a Retry beside it. The money record is
  this database's and Xero is a copy of it, so an outage must not roll back an invoice a customer
  has already been told about. Same contract for payments.
- **A payment carries an `Idempotency-Key` and the invoice does not, deliberately.** The
  payment's own id goes in the header, so a retry after a timeout — where the first attempt may
  in fact have landed — cannot post the money twice. The invoice path is idempotent a different
  way: `xero_invoice_id` turns a retry into an update. A duplicated invoice is visible and
  embarrassing; a duplicated payment quietly makes a customer look paid up.
- **Four "not yet" cases are skips, not failures** (`paymentGate`, pure and tested): already
  posted, the invoice never reached Xero, no bank account chosen, and a zero or negative amount
  (a refund is a credit note in Xero, not a payment). A laundry that has not connected is skipped
  too. Marking those red is how an integration teaches people to ignore its warnings.
- **Payments need a bank account and only the laundry knows which.** Xero refuses a payment
  without one, and guessing puts real money against the wrong ledger with nothing to notice it —
  so the settings screen offers their own accounts read back from Xero rather than a text box.
  `payment_account_code` is null until picked and payments are skipped while it is.
- **The mapping is pure and tested; the fetch is not.** `invoice-payload.ts` and
  `payment-payload.ts` hold the parts with rules in them — GST per line from
  `invoice_lines.taxable`, the PO as `Reference`, a zero-priced line kept rather than dropped,
  `numeric`-as-string coerced — because that is what can be wrong in a way a green build hides.
- 393 unit tests, `verify` green.

**Applied to `laundrymart-syd` on 2026-08-17** (§11), rehearsed first. Pre-flight turned up
`invoices.xero_invoice_id` **already live** from the unmerged pricing branch, which §11 records
as having converged on exactly this column — `add column if not exists` made that a no-op rather
than a 42701. Both roles were then proved out at the grant level with a real token row present.

**Nothing here has talked to Xero yet.** `XERO_CLIENT_ID`/`XERO_CLIENT_SECRET` are unset by the
owner's decision, so the app behaves exactly as it did before and the Settings screen says why.
**Before trusting it: set the two variables, register the callback on the Xero app, connect, pick
the bank account, then issue one invoice and take one payment and read them in Xero.**

**The void path was not built here** — it landed later the same day, once the owner asked for it.
See the 2026-08-17 pricing entry and §20.

### 2026-08-15 · Customer pricing, immutable job prices, and a billing lifecycle
The money half of a job. One migration (`0017`), two new tables, no table dropped and no
operational behaviour changed. §21 and §22 hold the design; the short version:

- **`billing_status` runs beside `status` and completion never bills.** The seven operational
  statuses the business asked for are untouched. Finishing a job sets `awaiting_review` in the
  transition guard and stops — asserted in pgTAP by completing a job and counting zero invoices.
- **Approval freezes the price.** `job_charge_snapshots` copies the rate card's numbers *and their
  provenance*; `frozen_at` makes the row unwritable, and the guard refuses an update and a delete
  even for `super_admin`. The test raises a rate line to $99 afterwards and asserts the approved
  job still reads $3.
- **The rate card is a service agreement version**, not a new pricing system —
  `customers.rate_card_agreement_id`, plus `service_agreement_lines.laundry_item_type` so a rate
  line can price the laundry that actually arrives at a counter. A rate card belonging to another
  customer is refused by trigger, tested *within* one tenant because RLS stops the cross-tenant
  case long before the guard and would prove nothing about it.
- **Generation and sending are completely separate**, and a job cannot be invoiced twice
  (`uq_invoice_source_jobs_once`, partial so **voiding releases the work**). Sending is one shared
  implementation for the single button and Send Selected, and is what moves jobs to `invoice_sent`.
- **Bulk operations are server-side**: `/invoices/awaiting` with Select → Approve Selected →
  Generate Selected, and Send Selected on the register. One request per press, partial success
  reported honestly, capped at 200 and refused rather than truncated past it.
- **Financial capabilities are enforced in RLS, not just React.** Nine capabilities; **dispatcher
  loses `invoices.read`/`invoices.write`** and keeps every operational one. 0006's billing read
  policy was `is_member` and nothing more, so a driver's session could read every invoice amount off
  PostgREST — the proof reads *as a driver and as a dispatcher* and counts zero rows.
  The money reports are filtered out of `/reports` for roles without `billing.read`, because a
  revenue report showing "$0" is a wrong answer that looks like a right one.
- **Xero is recorded by hand and nothing more.** Columns on customers and invoices, labelled on
  screen as reconciliation-only. No API contract was invented: authentication and invoice-state
  mapping were left unresolved by the previous checkpoint and still are.
- **A coherence bug in this work, found by writing the void path:** the billing guard as first
  written forbade `invoice_generated → approved`, which would have made voiding an invoice strand
  its jobs permanently. Fixed with an explicit rule — a job returns to `approved` exactly when no
  `invoice_source_jobs` row references it — rather than by working around the guard.
- **The compose-locally-commit-once rule earned its place again.** The charge editor's payload
  contract lives in `orders/job-charges.ts` with 12 tests against what the editor really emits, and
  the invoice grouping rule moved to `lib/domain/invoice-grouping.ts` when the writer's import of
  `recordAudit` → `lib/env` made it unreachable from a test — the same failure `plan.ts` records.
- 358 unit tests (was 286) and **164 pgTAP assertions (was 118)**. `verify` green; all seventeen
  migrations applied to a fresh Postgres 16, the whole pgTAP suite and the seed run against it.

**0017 is applied to `laundrymart-syd`** (2026-08-15) and verified there by rolled-back probe —
the backfill read back, fourteen guard probes against live rows, and the RLS claim proved by
reading the ledger *as* a demoted driver session (0 of 647 invoices, 0 of 5 rate lines). §11 has
the full record, including a pre-existing `anon` grant found on the way through.

**The screens themselves are still unopened.** The verification above is all database-level; no
authenticated page was rendered with real rows in it, and the billing screens have not been
screenshotted at the ten widths the design system asks for.

### 2026-08-14 · Confirm Load and Start Route could walk a moving run backwards
Found by asking what the day-level actions do to a run that has already left — the case the
empty-database tests never produced and the live data (Sam Okoye's 16 Aug run, `in_progress`)
does. Two defects, one helper, no migration.

- **`guard_route_transition` refuses a start without a load and a close without an unload, but
  it does not refuse a *backwards* move.** Nothing in the database stopped Confirm Load from
  setting a run that was out on the road back to `load_confirmed`. That matters because
  confirming again is a deliberate part of the design: a job assigned after the van has gone
  stays Assigned until the driver confirms it (§22). So the ordinary late-work flow walked the
  run backwards and offered the depot screen a "Start route" button for a van halfway round
  the suburbs. The load stamp is now filtered to runs still at the depot, and to a
  `load_confirmed_at` that is still null.
- **Start Route rewrote `started_at`.** The guard's `coalesce` only protects the column when the
  *client* leaves it null, and this one passed a value — so a second press moved the recorded
  departure to the second press. Now filtered to runs that have not started, and to runs whose
  load is confirmed (a run opened by a late assignment has none, and the guard would refuse it
  and take the whole statement, including the runs that should have started, with it).
- `/run`'s own Confirm Load carried the same unconditional write, guarded only by the screen
  not offering the button. The screen is not the boundary, so it is filtered too.
- `RUN_NOT_STARTED_STATUSES` exists as literals because the filter is evaluated in the
  database, where `runStage` cannot run. The unit test pins the two together from both
  directions, so a tenth run status cannot be added to one and forgotten in the other.
- 288 unit tests (was 286). Both defects were reproduced against a run loaded at 07:00 and
  departed at 07:30, and the fix shown to leave both timestamps alone.

### 2026-08-14 · Job → Driver → Delivery Date: the Runs mental model is gone
The operational simplification. The office now gives a job to a driver and a date; the driver
opens My Runs, confirms the load, starts the route and marks each job delivered. **Nobody
creates, opens or manages a run, and no run number appears on any screen.** One migration
(`0016`), no new table, no new role, no new capability, nothing dropped.

- **`assigned` is the seventh job status**, and it is a real one: `ready_for_delivery →
  assigned → out_for_delivery → completed`. A delivery job can no longer jump straight out —
  it needs a driver and a date first, and `chk_laundry_orders_assigned_has_driver` means a row
  cannot claim otherwise. `assigned → ready_for_delivery` is the one backwards edge and it is
  Remove Assignment: the trigger clears the four assignment columns *and* the stop, so a
  careless caller cannot leave half an assignment behind. A customer pickup never reaches
  either delivery state.
- **The assignment lives on the job** — `assigned_driver_id` + `assigned_delivery_date`, a
  DATE and never a timestamp a timezone could shift. 0015's `stop_id` chain survives as the
  operational placement, because the depot load, the run sheet and the inventory unload sweep
  are built on it, and `assignJobToDriver` finds-or-creates the run and the stop silently. Two
  copies of one fact is the bug 0015 was written to avoid, so the guard refuses every way they
  could disagree: another driver's run, another day's run, and **a job on a crewed run naming
  no driver** — which would be on somebody's route sheet and on nobody's My Runs.
- **My Runs is a list of jobs, not a tree of runs and stops.** No run cards, no RUN-001, no
  sequence numbers, no Show button and no Load Runs button — the date arrows are plain anchors
  and the date and driver controls submit themselves on change. Grouped To deliver / Out for
  delivery / Completed, with completed work staying on the day it was done so an earlier date
  still shows what happened on it.
- **Confirm Load replaced the vehicle inspection, and is emphatically not one**: no checklist,
  no pass/fail, no defect capture, no vehicle status. It records that the day's assigned
  laundry is on the van. Start Route then sends out **only load-confirmed jobs** — work
  assigned after the load stays Assigned, because it is not on the van and sweeping it out
  would record a departure that did not happen. That is why load confirmation is tracked per
  job as well as per run.
- **Inspection is out of the workflow; none of its data was touched.** `submitInspection`,
  `inspection-checklist.tsx` and `checklist.ts` are deleted and `/run` lost its first stage.
  `vehicle_inspections`, `daily_routes.inspection_id`, the two inspection route statuses and
  the `inspection_failed` notification kind all stay, so historical runs still read correctly.
- **Received Via defaults to Pickup by driver** on a new job; an existing job still answers
  with its own stored value, so an edit cannot re-record how the laundry arrived. **Pickup Time
  is gone** from the form, the Zod schema, every write and the detail page — the column stays
  nullable with its history in it, because a destructive migration to delete a field nobody
  reads is the wrong trade. Pickup Date stays, optional and unasterisked.
- **"Re-deliver" is "Deliver to customer"** everywhere it faces a person. Internal identifiers
  (`delivery_required`, `expected_delivery_date`) are untouched.
- **`laundry_orders` now has two foreign keys to `drivers`**, so every `drivers(...)` embed on
  it must be disambiguated by constraint name. `/orders/:id` had a bare one and would have died
  at request time with PGRST201 — compile-clean, test-clean, dead in production, exactly the
  failure the 2026-08-05 changelog records. Both call sites are now explicit.
- **The office cannot bypass the driver.** "Mark out for delivery" moved from `orders.status`
  to `orders.manage` and is labelled "Send out (override)"; `advanceOrder` refuses
  `status=assigned` outright (it would create an Assigned job with no assignment) and routes
  `assigned → ready_for_delivery` to Remove Assignment.
- Nav: the **Runs area is gone**; Drivers and Vehicles moved to a new **Fleet** area. The
  dashboard's "Runs today" panel is now a job-status board, "Plan my day" is gone, and the
  getting-started checklist ends at "add a driver" and "take in your first job". The
  `routesToday` badge and its per-request query went with the row. `/help` rewritten around the
  new vocabulary.
- 286 unit tests (was 266) and **118 pgTAP assertions (was 102)**. `verify` green; migrations
  applied to a fresh Postgres 16 and the whole pgTAP suite plus the seed run against it. My
  Runs screenshotted light and dark and asserted at 320/360/375/390/430/768/820/1024/1280/1440
  — no horizontal overflow and no sub-36px target in it.

**Not verified against a live project.** This container has no Supabase credentials, so the
authenticated screens were checked by migration-against-real-Postgres, pgTAP, unit tests,
build, typecheck, lint and the component gallery — not by being opened with real rows in them.

### 2026-08-14 · The job number was drawn and thrown away; `no-unused-vars` now on
Found by taking a real job in on the deployed app, which is the only way it could have been
found. The two fixes below cleared the way to the insert, and the insert then failed with
`null value in column "order_number" of relation "laundry_orders" violates not-null
constraint`. No migration.

- **`createOrder` called `next_number()` and never used the result.** `order_number` is
  `not null` with no default and no trigger, so every job creation died on the constraint. The
  fix is one line. Every other `next_number` call site — runs, stops, batches, invoices, credit
  notes, contracts, customers — was swept and all seven write their number correctly; this was
  the only one.
- **Nothing could have caught it, so `@typescript-eslint/no-unused-vars` is now an error.**
  `eslint-config-next` does not enable it, and `.insert()` on the untyped Supabase client takes
  any object, so a missing required column is invisible to `tsc`. A value fetched and dropped on
  the floor is the shape of a real bug, not a tidiness question — re-breaking the line proves
  the rule now reports it. `_`-prefixed names stay allowed for deliberate skips.
  The plugin is *reused* from `eslint-config-next` rather than depended on directly, so §10a's
  pins stay the single source; the config throws rather than silently skipping if that
  registration ever moves.
- **17 dead imports cleared** to get there, across 8 files, plus a vestigial `searchParams` on
  `/customers/new` left over from the flash-cookie migration. No behaviour change in any of them.
- 266 unit tests, unchanged. **Verified against the live app** for the first time in this
  sequence — the failure above is what the deployed build actually returned.

### 2026-08-14 · The planner had never applied a plan: the board and the action disagreed
Swept the other three compose-locally-commit-once payloads after the job-form outage below.
One of them was broken the same way and just as completely. No migration.

- **`/routes/planner` "Apply plan" was refused every single time.** The board posted
  `{columns:[{id,…}]}` with **no date on it at all**; `planSchema` read
  `{date, columns:[{routeId,…}]}`. So `date: Invalid input: expected string, received undefined`
  came back on every attempt and no plan was ever committed. The server side was right
  throughout — `applyDispatchPlan` has always read `column.routeId` — so the fix is entirely
  in the producer: `PlannerBoard` takes the day as a prop and `toPlan` emits `routeId` and
  `date`.
- **`toPlan` now returns `DispatchPlan`**, the type inferred from the action's own schema, so
  this particular disagreement is a compile error from here on. It caught the `/design-preview`
  call site the moment it was introduced.
- **The two survivors are sound, and are now pinned rather than assumed.** The contract
  wizard's `lines` and the offline outbox's records both parse cleanly against the shapes their
  producers really build — `/api/sync` had used `.nullish()` throughout from the start, which
  is precisely what the job form's schema lacked.
- **All three payload contracts moved out of `"use server"`**: `orders/order-items.ts`,
  `agreements/wizard-lines.ts` and the planner's existing pure `plan.ts`. Such a module can
  export nothing but server actions, so each contract had been unreachable from a unit test —
  and two of the three were broken in production behind a green `verify`. Each now has tests
  written against the payload its producer actually emits.
- **`plan.ts` restates the ISO-date rule instead of importing `requiredDate`.** It is in the
  *client* bundle via `planner-board`, and `lib/actions` reaches for `next/headers`. That import
  typechecked, linted and tested clean and failed only at `next build` — worth remembering
  before moving anything else into a module a client component imports.
- 266 unit tests (was 254). Board re-rendered at 1440 in `/design-preview`: correct payload
  keys, no console errors, no horizontal overflow, and the dirty/Apply-plan gate still
  correct after a crew change.

### 2026-08-14 · No job could be saved: "add at least one laundry item", on a job that had one
The Jobs module was unusable from the day it shipped. Every create and every edit was refused
with **"Please add at least one laundry item."** — including the one in the screenshot, with
2332 towels on it — and the refusal also dropped the customer, so each attempt cost the counter
the search as well. No migration; no schema, RLS, capability or workflow change.

- **One `null` failed the whole laundry list.** The form posts its items as JSON, and spells
  every unanswered field `null` (`JSON.stringify` drops `undefined` keys, so it cannot spell it
  any other way). `optionalText` only ever mapped `""` → absent, and `z.string().optional()`
  accepts `undefined` but **refuses `null`** — so an item with no *Item notes* failed to parse,
  `z.array(itemSchema)` failed with it, and the caller was handed an empty list. `optionalText`,
  `optionalUuid` and `optionalDate` now share one `absent()` preprocessor that reads both
  spellings. The blast radius was every laundry row: only a job where *every* item had both a
  custom description and a note typed in could ever have been saved.
- **An unreadable list no longer poses as an empty one.** `parseOrderItems` returns the reason
  it could not read the payload instead of `[]`, so a parse fault can never again surface as a
  sentence about adding an item. That distinction is the whole reason this went unnoticed: the
  message named a problem the operator could see was untrue, and named nothing they could act on.
- **The parser moved out of `"use server"`** into `orders/order-items.ts`. A `"use server"`
  module can export nothing but server actions, so the parser was unreachable from a unit test
  — which is exactly why `verify` stayed green over a module nobody could use. It is now
  covered by 8 tests written against the payload `JobForm` actually builds; 4 of them fail
  against the old preprocessor.
- **A rejected save keeps the customer.** `fail()` redirects, so the browser's copy of the form
  is gone — the customer, found by search, was being thrown away on every validation message.
  Both actions now return through `?customer=<id>`, the door the quick-create already uses, and
  `JobForm` adopts a changed `defaultCustomerId` during render (no effect) so it works whether
  or not React kept the component mounted across the redirect. The one deliberate exception is
  the customer itself being unusable — carrying that id back would re-open the form still
  claiming a selection the database will not stand behind.
- **The picker can no longer show "nothing selected" while posting a customer.**
  `loadJobFormData(ensureCustomerId?)` fetches that one row when the capped 500-name list did
  not carry them — a customer past the 500th by name, or one since put on hold under an
  existing job. If they are genuinely gone, the form says so instead of rendering an untouched
  search box over a hidden field that still points at them. `truncated` is now measured against
  what the search box covers, so the appended row cannot make a capped list look complete.
- 254 unit tests (was 245). `verify` green. **Not verified against a live project** — this
  container has no Supabase credentials, so the fix is proven by the payload-level tests, the
  typecheck, the lint and the build rather than by taking a job in at a real counter.

### 2026-08-14 · My Runs: a driver's day, and putting a job on it
The counter's Jobs and the driver's Runs were two islands — a job could be marked "out for
delivery" with nothing anywhere recording whose van it went out on. This joins them, adds the
operational screen a driver actually works from, and gives dispatch somewhere to hand work
out. **One migration, one new column, no new table, no new role and no new capability.**

- **`laundry_orders.stop_id` is the whole data model** (`0015`). Job → Stop → Run → Driver,
  and deliberately no `driver_id` on the job: a second copy of the answer is a second thing to
  keep in step, and the failure mode is the one the brief names — the job says John, the run
  says Mark, and nothing says which is true. Reassigning is one UPDATE of one column.
- **Assignment is a relationship, not a status.** Nothing here adds to the six statuses of
  0014, and assigning touches no laundry, no customer and no price. Eligibility —
  delivery work, ready to leave, not already on a run, stop belongs to the same customer — is
  stated in `src/lib/domain/run-assignment.ts` for the screen and enforced by
  `guard_laundry_order_assignment` for everything else. A **customer pickup is refused
  outright**, in the queue, in the form and in the database.
- **Runs and stops are found before they are created.** Assigning six jobs for one customer to
  one morning produces one run, one stop and six jobs under it. A driver with two open runs on
  a date is *asked* rather than guessed at — a morning van and an afternoon van are different
  promises to the customer. Multiple runs per driver per day were always supported by the
  schema; `/run` merely hid the second one behind a `maybeSingle()`.
- **`/my-runs`** — date arrows and a native date picker, a driver selector for `routes.write`
  only, a summary with a progress bar, one card per run, stops in their existing `sequence`,
  and the laundry grouped under each stop with phone and navigation links. The run controls
  post to the very actions `/run` posts to (`confirmLoad` → `startRun` → `markReturning` →
  `unloadRun` → `closeRun`), which gained a `return_to` and nothing else, so the load-before-
  start rule and the unload sweep cannot drift between the two screens.
- **`/my-runs/jobs/:id`** is the driver's read-only job view. It is a kindness on top of three
  real boundaries, not a substitute for one: `/orders/:id/edit` is still `orders.write`,
  `cancelOrder` is still `orders.manage`, and since 0015 RLS refuses the read outright unless
  the job is on one of the driver's own stops.
- **Delivery completion has one implementation.** `lib/orders/complete.ts` is called both by
  the counter's `completeOrder` and by the driver's `markJobDelivered`; what differs is the
  guard in front. The driver's branch is *resource*-based — `run.execute` plus "this job is on
  a stop of a run whose driver is you", re-derived from the database on every call — so no new
  capability was invented and posting somebody else's order id is refused, not merely hidden.
  Starting a run moves its ready jobs to `out_for_delivery`, which is a statement of fact;
  **closing a run never marks anything delivered.**
- **Adelaide, beside Sydney rather than instead of it.** `OPERATIONS_TIMEZONE` and the
  `getAdelaide*` helpers live in the existing `timezone.ts` on the existing offset lookup. The
  global `BUSINESS_TIMEZONE` was left alone on purpose: flipping it would silently re-date
  every invoice period and every stored `received_at`. 14 tests cover the day boundary in both
  directions, both changeovers (23-hour and 25-hour days) and the fact that the machine's own
  timezone cannot move the answer.
- **Jobs screen integration only where it earns it**: a "Delivery run" card on `/orders/:id`,
  a Run column and a "Ready for delivery — unassigned" filter on the list. The embed is
  disambiguated by constraint name (`jobs!laundry_orders_stop_id_fkey`) — this repo has been
  bitten once by an ambiguous embed that was compile-clean and dead in production.
- 245 unit tests (was 204) and 102 pgTAP assertions (was 83). `/design-preview` gained the
  module; screenshotted light and dark and asserted at 320/360/375/390/430/768/820/1024/1280/
  1440 — no horizontal overflow and no sub-36px target anywhere in it.

**Not verified against a live project.** This container has no Supabase credentials, so the
authenticated screens were checked by migration-against-real-Postgres, pgTAP, unit tests,
build, typecheck, lint and the component gallery — not by being opened with real rows in them.

### 2026-08-13 · Enterprise framework: adopted the gaps, not the directory
Tooling only — nothing under `src/` or `supabase/` was touched, no migration, no test change.
Installed a selected subset of `ysm-prog/enterprise-claude-framework` v1.5.0 into `.claude/`:
the eight specialist skills this repo had no guidance for (accessibility, UX, frontend
architecture, performance, QA, devops, business analysis, principal architect), the
`principal-architect` agent, four workflow commands (`/bug-fix`, `/incident-response`,
`/dependency-upgrade`, `/refactoring`) and the nine standards those files reference.
- **Not a wholesale copy, on the framework's own advice.** Where this repo already has a
  specific entry point — `security-auditor` for security, `migration-author` + `rls-test` +
  `migrations-check` for the database, `code-reviewer` for a diff, `ship-check`/`/ship` for
  release, `multi-tenant-feature` for a new module — the framework's generic equivalent was
  left out. Two entry points for one job invites picking the weaker one. `.claude/FRAMEWORK.md`
  is the manifest: what was taken, what was skipped, and what supersedes each skipped item.
- **The framework's `.claude/CLAUDE.md` was deliberately not installed.** It is auto-loaded
  context restating principles this file already carries, and it routes to commands this repo
  does not have. The installed skills name the standards they need at the point of use instead.
- **`code-reviewer.md` was the one file-level collision** and ours was kept, unmodified — it
  knows the tenancy rules and the CI gates; the framework's does not.
- `.claude/VERSION` records 1.5.0 so a future sync can diff the framework changelog forward.
  Every `.claude/…` path referenced by an installed file resolves; there are no dangling links.

### 2026-08-13 · Electro Services: full UI/UX redesign
A visual, usability and responsiveness pass over the whole application. **No schema, server
action, RLS policy, capability, query or business rule changed** — no migration, and the 204
unit tests pass untouched. What moved is the design system and the shell; every screen inherits
it. See §10b for the system itself.

- **Branding is Electro Services** everywhere it faces a person: page titles and the metadata
  template, the PWA manifest and icon, the rail, the phone header, login, the landing page, the
  offline page and the test-email copy. Technical identifiers are deliberately untouched — the
  package name, the `laundrymart-offline` IndexedDB name and the `laundrymart-shell-v1` cache
  key. Renaming the first would orphan a driver's queued stops on their phone.
- **The rail is no longer a console.** Light surface on its own `--sidebar-*` tokens, Lucide
  icon per area, count pills, and a **collapsible desktop rail** whose state is a cookie read in
  the layout — so it paints at the right width on the first frame instead of snapping after
  hydration. On a phone it is a real slide-out drawer with a focus trap, Escape and a scrim,
  replacing a `Menu` button that pushed an absolutely-positioned block into the page.
- **Identity moved to the header** (`UserMenu`). It used to sit in the rail footer, which meant
  it vanished on a phone and again on a collapsed rail. Global search gained an icon and the
  placeholder the brief asked for, and collapses to an icon below `sm`.
- **Type is Inter, and monospace is out of ordinary business content.** 74 `font-mono`, 70
  `text-[12.5px]`, and every `uppercase tracking-[…]` label across 28 files swept to sentence-case
  sans at 14–15px. 9px and 10px label tokens raised to 11px and 12px so the sweep could not leave
  anything unreadable behind.
- **Corners and controls.** The `--radius-*` scale, zeroed since Plantline, is restored; a base
  rule rounds native controls so the ~120 hand-rolled ones cannot stay square, and 183 class
  strings were rounded at the call site. Inputs are 44px.
- **The Jobs form is the screen the brief was written against.** The customer picker no longer
  opens with a scrolling list of twelve customers — one search box, results floating only once
  you type, and a selected-customer card in place of the search. Sections are now named groups
  (Customer, Order received, Laundry details, Delivery, Instructions, Job management), the page
  is capped at ~1040px, and the action row sticks to the bottom of a phone viewport.
- **Four real defects found by screenshotting rather than by reading:**
  - an `sr-only` label inside the planner's horizontal scroller stretched the document 227px
    on a 390px screen (absolutely-positioned children escape an ancestor's overflow clip
    unless something inside it is their containing block — the column now carries `relative`);
  - `bg-danger text-white` failed contrast in dark mode, where the danger colour is lifted to a
    light red — hence the `--on-status` token;
  - `DataTable` drew its own frame inside a `Card` that had already drawn one, a doubled
    hairline a pixel apart — hence `bare`;
  - `role="dialog"` sat on the full-screen wrapper in both overlays, making the scrim part of
    the dialog; it is on the panel now.
- **Also fixed while in there:** both email fields on the sign-in page rendered `id="email"`, so
  the magic-link label pointed at the password form's input (`Input` now takes an `id`).
- The joined KPI strip (`gap-px` over `bg-border` with `flush` cells) is gone — it left an empty
  grey cell whenever the count did not fill the row, and square corners among rounded cards.
  `Stat` lost its `flush` prop with it.
- `Overlay` is new and is exercised in `/design-preview`; 12 behaviour assertions pass at 390px
  and 1440px (bottom sheet vs centred dialog, focus trap, scroll lock and restore, Escape).
  Verified light and dark at 390 / 820 / 1440 with no console errors and no horizontal overflow.

**Not verified against a live project.** This container has no Supabase credentials, so the
authenticated screens were checked by build, typecheck, lint, tests and the component gallery
rather than by being opened. Everything behind the auth gate inherits the swept components, but
the data-dependent screens have not been seen with real rows in them.

### 2026-08-13 · Job creation form: no received time, re-deliver by default
Targeted change to the create/edit form only — no migration, no new component, no change to
the Jobs list, detail page, status workflow, priority or permissions.
- **Received time is no longer asked for.** It was a field that was never wrong and always in
  the way: the counter is standing there as they fill it in. The form posts only
  `received_date`; `receivedInstant()` (in `src/lib/domain/laundry-orders.ts`) composes
  `received_at` server-side — the clock time now for a new job, and **the job's existing time
  of day on an edit**, so correcting a received date does not move an 8am drop-off to
  whenever the correction was made. `received_time` is out of the Zod schema, so nothing
  the form no longer sends is still required. `received_at` keeps its column and its data.
- **Received via offers the two real answers**, drop-off and driver pickup. `RECEIVED_VIA`
  stays the full column set (0014 allows `other`) and the Zod enum still accepts it:
  `receivedViaOptions()` adds a job's own stored value back to the list when it is not one of
  the two, so editing a legacy job cannot silently rewrite how it arrived.
- **The delivery fork now defaults to Re-deliver**, and reads "Re-deliver" / "Customer pickup".
  `initialDeliveryRequired()` is the rule: a new job starts at `delivery_required = true`, an
  existing one answers with its own value. The column default in 0014 stays `false` — the
  action always writes the field explicitly, so no historical row and no migration is touched.
- "Washing instructions" is now labelled **Machine instructions**, still writing
  `special_instructions`; per-item **Item notes** is untouched and remains a different field.
- Priority, the assignee (blank, never the creator), the customer picker and its phone
  display, both quantity types and every delivery/collection field are unchanged. 204 unit
  tests (was 195). Rendered at 1280 and 834 to confirm the layout.
### 2026-08-13 · Jobs: laundry order management, drop-off to hand-back
The counter's own module — take laundry in, itemise it, track it through the plant, and
deliver it back or hand it over. New area "Jobs" in the rail, one migration (`0014`), no
change to any existing screen except the three integration points below.

- **`/jobs` was already taken.** `public.jobs` is the routing module's *stop* — a visit on a
  driver's run, labelled "Stops" since the simplification. What this module needed is the
  customer's laundry as one tracked thing, which is a different record with a different life.
  So the schema calls it a `laundry_order`, the route is `/orders`, and the operator-facing
  word is **Job** — the arrangement Contracts (`/agreements`) and Linen (`/inventory`) already
  use. `/help` now defines Job, Stop, Overdue and Bulk lot so the two cannot be confused, and
  the rail carries both rows.
- **Six statuses, and the database is what enforces them.** `new → in_progress →
  ready_for_delivery → {out_for_delivery → completed | completed} → ·`, plus `cancelled` from
  any live state. `guard_laundry_order_transition` refuses the rest, including the two that
  are only wrong for one workflow: a customer pickup never goes out on a van, and a delivery
  job cannot be completed off the shelf. The same table is stated once in
  `src/lib/domain/laundry-orders.ts` so the buttons, the action and the trigger agree — the
  action gives a sentence, the trigger is the boundary.
- **Overdue is a calculation, not a status.** `due_date` is a generated column — the delivery
  date, or the collection date for a pickup — so the list column, the filters, the summary
  card, the rail badge and the row rule all read one definition, and a job clears the flag by
  being finished rather than by anything writing to it at midnight.
- **The business timezone is now explicit** (`src/lib/domain/timezone.ts`, 22 tests). Dates
  come from `<input type="date">` and times from `<input type="time">`, both zoneless; the
  column is a `timestamptz`. Composing them on the server in `Australia/Sydney` is what keeps
  an 11:30pm receipt on the day the counter saw it rather than on UTC's tomorrow. Reads the
  offset out of `Intl` in two passes, so the October changeover is the platform's problem.
- **Child rows are replaced in one transaction.** `save_laundry_order_items()` (SECURITY
  INVOKER, so RLS still decides which job you can touch) deletes and re-inserts inside one
  function body. Over PostgREST the same edit is two requests with a window where the job has
  no laundry on it and nothing to roll back.
- **Capabilities, not new roles**: `orders.read` / `.write` / `.status` / `.manage`, mirroring
  the `routes.read`/`.write`/`.status` split. The counter (`customer_service`) takes jobs in,
  the floor (`warehouse_operator`) advances them without being able to edit what was agreed,
  finance reads them, managers cancel and backdate. A driver holds none — their world is
  their own run. The rail is 4–11 rows by role (was 4–10).
- **Three integration points and nothing else touched**: a Jobs section on the customer's
  detail page (read through `customer_id`; nothing copied onto the customer), an overdue count
  beside the other four rail badges, and `ConfirmSubmit` gaining an optional-reason flag so
  cancelling can ask for a reason without demanding one. The customer quick-create is the
  existing `createCustomer` reused through `return_to`, so adding a customer mid-job comes
  back with them selected instead of restarting the form.
- **The delivery address is snapshotted on purpose** — the one piece of customer data this
  module duplicates. A job has to answer "where was this taken?", so a customer who moves next
  year must not rewrite where last year's linen went.
- 195 unit tests (was 145) and 83 pgTAP assertions (was 56). `/design-preview` gained the
  module, rendered light and dark before this landed.

### 2026-08-05 · Simplification audit: navigation, search, help, responsive tables
Full-application UX/code review in `docs/SIMPLIFICATION-AUDIT.md` (13-part deliverable:
executive summary, UX and code audits, architecture review, navigation and workflow
redesigns, screen-by-screen, performance, accessibility, mobile, refactoring plan,
roadmap, priority matrix). No migrations.
- **The rail was a table of contents for the database** — 22 destinations under six
  headings named after internal concepts. Now ten areas in the operator's words, no
  headings, with each area's screens as a tab strip. See §6. **A driver had no rail row
  for `/dashboard`**, the page the auth gate redirects everyone to: the row required
  `reports.read`, which drivers do not hold. Rail size by role is now 4–10 (was up to 22).
- **`/search`** — the context bar's box submitted to the customers list, so an invoice
  number typed into the only search field in the app returned "no customers match those
  filters". It now searches customers, contracts, invoices, stops, item types, drivers and
  vehicles, each group gated exactly like its own screen. Plain `ilike`, no index, no
  migration; `pg_trgm` is the escape hatch if the row counts grow.
- **`/help`** — glossary (plain word, trade word, what it means), a four-step walkthrough
  of a normal day, and two lists: what is safe to try and what cannot be undone. Rail row
  carries no capability, so no role can be refused a definition.
- **Every table stacks into labelled cards below `sm`** — one change in `DataTable`, no
  call site touched. Its scroll box is now focusable and named (WCAG 2.1.1). The dashboard
  had hand-rolled a *second* table, which is why it had none of this; it is folded in via
  a new `rowClassName` prop, and now leads with the customer and issue rather than the
  internal job number.
- **People**: the four roles a small laundry uses lead the picker (`COMMON_ROLES`), the
  other seven grouped after them, each described in the owner's words (`ROLE_SUMMARY`
  moved to `lib/roles.ts`). No schema or capability change.
- `/admin` was a menu page whose only content was four links — retired to a redirect.
  Tap targets to 36px throughout; error `Notice`s announce as `alert`, not `status`;
  `CONTROL` (the input skin) shared from `ui.tsx` so the filter bar stops drifting from
  every other input. Copy pass over 11 page headers. `/design-preview` now renders the
  real nav map and the real `DataTable` rather than drifting fixtures.
- **A customer with two active contracts was billed for one of them.** `generateInvoices`
  looped per contract but de-duplicated on customer + period, so contract two found
  contract one's invoice and was skipped as "already billed" — every period, silently,
  since the feature shipped. Now one invoice per customer carrying every contract's
  charges, which is the only correct shape: the weighed collections and the damaged linen
  are recorded against the customer, so one invoice per contract would have billed both
  twice. Header fields two contracts disagree on fall back to the customer's own value
  (payment terms) or to nothing (purchase order) rather than picking a winner. The pure
  part moved to `src/lib/domain/invoicing.ts`. No migration — the schema already allowed
  it; only the loop was wrong. 115 unit tests (was 88; 15 for the navigation resolver,
  12 for the invoicing rules).
- Merged Phase C (notifications) from `Prod` on the way through. The two met in the
  navigation: C's notification settings screen is now a tab under Settings, and its
  `/notifications` list stays off the map because the bell is its entry point.

### 2026-08-05 · Simplification Phase C: the app speaks up on its own
Per `docs/SIMPLIFICATION-ROADMAP.md` Phase C and AD-3/AD-4 of the design spec. Answers F4 —
*"there is no notification anywhere that the user didn't just cause"*. This is the redesign's
one migration, and it lands with the code that uses it.

Built against `Prod` (Phase A) while Phase B was in flight, and merged into `Dev` on top of
it — nothing in C depends on B, because C adds an event layer beside the existing screens
rather than changing the forms B rewrites. The two met in three files: the `/api/sync`
imports, the `/design-preview` section list, and this changelog.

**The migration (`0013_notifications`).** AD-3 and AD-4 share one migration on purpose: Phase C
and Phase D (simple mode) both need a per-tenant switch, and a settings table would be a second
join on every page render.
- **`tenants.settings jsonb not null default '{}'`** — notification preferences now,
  `ui_mode` later. Shape validated by Zod at the read site, not by the database.
- **`notifications`** — `audience` is a capability string from `src/lib/roles.ts`, so the bell
  targets by exactly what the nav and page guards already use. No enum and no FK on it: a
  check constraint listing the capabilities would need migrating every time one is added, and
  a typo'd capability shows a notification to nobody rather than to the wrong person.
- **Idempotency is `unique (tenant_id, kind, subject_id, occurred_on) nulls not distinct`.**
  `subject_id` is nullable, and under a plain unique index every NULL is distinct — the
  subject-less kinds (`sync_failed`) would be exactly the ones that spam. Chosen over a
  `coalesce()` sentinel index because PostgREST's `on_conflict=` names columns only, so an
  expression index is unusable from supabase-js. Needs Postgres 15+.
- `href` is NOT NULL and constrained to a plain same-site path (mirrors `returnTo()`): every
  notification links to its fix, and the bell must not become an open redirect.
- `read_at` is the only state; nothing is deleted. `apply_tenant_policy` supplies RLS, the
  tenant index and the `updated_at` trigger. No function grants — `anon` stays revoked.
- Proof: `supabase/tests/notifications_scope.test.sql` (9 assertions — cross-tenant read, the
  `with check` tenant-hop, both idempotency cases, the href guard, and `anon` proven out by
  privilege *and* by message, since 42501 alone means nothing here).
- Numbering: `Prod` is at 0012, but the unmerged `claude/warehouse-inventory-flow-psooyq`
  branch holds a second `0012_return_count.sql`. That one gets renumbered, not this one.

**The writers (C2).** Server actions raise their own events in the transaction that caused
them — a failed inspection, a vehicle taken off the road, stock written off as damaged, and a
rejected offline batch (`duplicate` is the replay path working, so only outright rejections
count, and it is one notification per batch rather than per stop). The time-based pair —
invoice past terms, run still at the depot past its window — is a swept check on a Vercel cron.
A run with no `planned_start_time` is never called late: nothing in the schema promises when it
should leave, and inventing a cutoff would manufacture an alert out of an absence — the same
call §10b already records for the turnaround KPI.

**The bell (C3).** Context-bar server component, head-only unread count resolved in the `(app)`
layout beside the four nav badges; `/notifications` lists them, newest first, with a
show-read-too view because nothing is ever deleted. Each row is a **form, not a link** —
Next prefetches links on hover and in the viewport, and the destination marks the row read on
the way through, so links would empty the bell for anyone who merely scrolled past. The
destination is read back from the row rather than from the posted form, and 0013 constrains it
to a same-site path, so the bell cannot become an open redirect. Read/unread is carried by
weight and a marker, never by colour — colour still means status.

**Customer emails (C3), off until switched on.** Delivery confirmation with the proof of
service captured at the stop, sent from both delivery writers so a drop-off recorded on a
phone in a car park behaves like one typed at a desk; and the overdue chase on the owner's
schedule — **first at 7 days past terms, weekly, three at most, friendly in tone** (their
decision, 2026-08-05). Signed media URLs get a 7-day life for the inbox rather than the
on-screen 5 minutes. Reminder idempotency rides the audit log, not the notifications table,
because a reminder recurs and each occurrence either did or did not leave the building; the
marker is written only on success, so a bounced reminder is retried rather than counted as
delivered. No PDF and no payment link on the chase: the invoice was already emailed with one
attached, and nothing in the schema holds a payment URL to link to.

**Settings (C4).** `/admin/notifications`, `admin.write`, stored in `tenants.settings` and
merged rather than overwritten so Phase D's `ui_mode` survives a save. In-app on by default,
customer email off. **Staff email is deliberately not offered** — a switch that looks like it
sends mail but does not is worse than no switch.

**C0 — the Resend path is still unproven against the provider.** It could not be exercised
here: this container's network policy answers 403 to `CONNECT api.resend.com`, so no live send
was possible at any point. What shipped instead is a **"Send a test email" action** on the
settings page (`admin.write`, sends only to the signed-in user's own address, audited) to be
run from the deployed app, plus a note pointing at emailing one real invoice for the full path
including the PDF. **Do not switch the customer emails on until both have been run once.**
### 2026-08-05 · Simplification Phase B: wizards, one-click planning, in-run problems
Per `docs/SIMPLIFICATION-ROADMAP.md` Phase B / design spec P-3, P-4, P-5, AD-2. No
migrations.
- **Contract creation is a 3-step wizard** (`agreements/agreement-wizard.tsx`, replaces the
  19-field form on `/agreements/new`; the full `AgreementForm` remains for editing on the
  detail page). Client-held step state using the `Stage` idiom, one post to `createAgreement`
  at the end — steps hide rather than unmount, so a single form carries every field, and no
  input uses `required` (a hidden required field would fail native validation unfocusable).
  Step 2's common case is one checkbox: "deliver on the next service day" posts
  `delivery_follows` and the action copies the pickup pattern. Step 3's item rows post as
  JSON in one hidden `lines` field (the planner's compose-locally-commit-once shape);
  `createAgreement` now inserts them. Per-kg, included allowances, minimum charge and levies
  sit behind "Advanced pricing". A live plain-English summary says only what the entered
  numbers can stand behind (per-kg lines get a sentence, never an invented figure).
- **Customer quick-create** (P-4): four required fields — business name, phone, billing
  email, site address — where `site_address` becomes the first `customer_locations` row, so
  a new customer is immediately routable. `/customers/new` restructured to essentials +
  collapsed `<details>` disclosures (`FormDisclosure`), status now defaulting to active.
  Embedded in wizard step 1 via the HTML `form` attribute (fields inside another form's
  markup, associated to a sibling form element — no nesting); `createCustomer` honours
  `return_to` and comes back with `?customer=<id>` preselected.
- **"Plan my day"** on the dashboard (B3): one click runs the shared `instantiateRoutes`
  (extracted from `generateDailyRoutes`), pre-assigns each template's usual driver/vehicle,
  then lands on `/routes/planner` only if a run is crewless or a stop is on no run —
  otherwise it lands on today's runs and says nothing needs a decision.
- **"Something's wrong at this stop"** on `/run` (P-5, F11): inline reason + note + optional
  photo on the capture card, through the offline outbox (new `exception` record kind, new
  `exception` media scope). The driver never leaves the run screen. See §8 for the
  `[photo:…]` notes marker; the job page shows the photo via the usual signed URLs, and the
  dashboard/problems lists strip the marker. Exception reasons moved to
  `jobs/exception-reasons.ts`, shared by the office form, the run capture and `/api/sync`.
- **Toasts can carry the fix** (B4): `fail()`/`done()` take an optional `{ href, label }`,
  rendered as a link in `FlashToast`; the template re-validates it as a plain same-site
  path. Wired where an action fails on a missing prerequisite: no weekly run for the
  day/weekday → set one up; invoice email with no billing email → the customer's edit form;
  generate invoices with no covering contracts → the contracts list.
- `/design-preview` gained the wizard (live, with fixtures), the quick-create, the exception
  capture (a `preview` prop keeps it out of the real outbox) and the linked-toast sample;
  all screenshotted light and dark. 88 unit tests (was 81; pack/parse for exception notes).

### 2026-08-05 · Simplification Phase A: flash toasts, operator language, guided setup
Per `docs/SIMPLIFICATION-ROADMAP.md` / `docs/SIMPLIFICATION-DESIGN.md` (the BA + design
review of first-time operability). No migrations.
- **Flash messages moved out of the URL.** `fail()`/`done()` now set a one-shot cookie and
  redirect clean; a new `(app)/template.tsx` + `FlashToast` render it (success auto-dismisses
  in 5 s, errors stick). Kills the stale-message-on-refresh/bookmark class, and incidentally
  the broken `?selected=…?error=…` double-query URLs the old string-append produced. All 267
  call sites became `return fail(...)`; the dead `<FlashMessages>` plumbing came out of every
  `(app)` page (the dashboard keeps one for the auth gate's render-time `?error=forbidden`).
- **Operator language.** Nav and titles: Sites, Contracts, Problems, Stops, Weekly runs,
  Today's runs, Plan the day, People, "Create this month's invoices", "Adjust stock". Routes
  and schema unchanged; trade terms kept as eyebrows where useful.
- **Getting-started checklist on the dashboard** (site → customer → contract → weekly run →
  plan today), row-count driven, using `Stage` — extracted from the run screen into `ui.tsx`
  as the app-wide guidance idiom. A tenant with no customers sees only the checklist.
- **People screen shows emails, not UUID prefixes** — resolved per-membership via the admin
  client (tenant's membership rows first, never list-and-filter); degrades to short ids
  without a service key. Supabase/RLS jargon rewritten out of the page copy.
- **`ConfirmSubmit`** inline confirm strip (consequence sentence + optional required reason)
  on void invoice and close run. **Inspection checklist now starts unchecked** with a
  deliberate "All checks OK" fast path — an attestation, not a pre-signed form.
- Hints/defaults pass on the customer and contract forms (start date defaults to today);
  empty states gained next-step actions; `/design-preview` gained a Guidance section.

### 2026-08-05 · A run could be stranded; the inspection no longer gates the start
- **`inspection_pending` was a dead end.** The office status control listed no transition out
  of it, so once a dispatcher requested an inspection the only remaining button was "Cancel
  run" — and the database refused `in_progress` without an `inspection_id`, which only a
  driver on `/run` can create. A run whose driver inspected on paper, or whose login was not
  linked to a driver record, could not be started by anyone. `0012` drops the inspection check
  (the inspection is still recorded and shown); load-before-start and unload-before-close stay,
  because those protect data rather than process.
- **`routes.status` split out of `routes.write`.** Advancing a run that is already out on the
  road is a floor decision, not a planning one. It now also goes to `driver` (RLS keeps them to
  their own run) and `customer_service`. Planning and assignment stay on `routes.write`.
- **Every non-terminal state now has a forward move**, including "Confirm load" from the
  office, and `setRouteStatus` stamps the timestamps each state implies. Previously the office
  could set `unloading` without `unloaded_at` and then be refused at "Close run" — a second
  dead end, reached from the opposite direction.
- The unload inventory sweep moved to `src/lib/routes/unload.ts` and is shared by the driver's
  unload and the office one, so marking a run unloaded from a desk cannot strand stock in
  `in_transit` on a vehicle that is back at the depot.
- Recording an inspection no longer walks a moving run's status backwards to
  `inspection_complete` — reachable now that the inspection can arrive late.

### 2026-08-05 · Dispatch planner and the billing two-pane (stage 3 complete)
- **`/routes/planner`** — the pack's day board. See §17. New nav entry gated on `routes.write`,
  since a board you cannot apply is worse than no board.
- **`/invoices` rebuilt as the two-pane.** The old page made you open a detail page and come
  back for every invoice in a chase list; selection is now a query parameter and the work
  happens beside the list.
- `returnTo()` added to `lib/actions.ts`; `issueInvoice`, `recordPayment` and `emailInvoice`
  honour it. Those three also stopped passing a query string to `revalidatePath`, which
  matches on route and silently did nothing with one attached.
- `/design-preview` gained both screens (the planner board is the real client component), and
  they were rendered in light and dark before this landed.

### 2026-08-05 · Three broken embeds fixed; the design is now reviewable
- **`/routes/daily`, the run sheet and the vehicle report were broken.** All three embedded
  `vehicles(registration)` from `daily_routes`, which has two FKs to vehicles — ambiguous, so
  PostgREST rejects it with PGRST201 at request time. Compile-clean, test-clean, dead in
  production. Disambiguated by constraint name; see the warning under §10a. Pre-existing.
- **`/design-preview`** — a static component gallery, no data, 404s in production. Rendering
  it found a doubled hairline in the KPI row (`Stat` gained a `flush` variant) and a sidebar
  with no edge in dark mode (the rail gained a `border-r`). Neither was catchable by `verify`.

### 2026-08-05 · Adopt the Plantline design language (stages 1–3a of 4)
- **Theme and typography.** Tokens, IBM Plex, flat square chrome, `--action` split from
  `--primary` so colour keeps meaning status. See §10a.
- **Shell.** Near-black 212px rail with grouped flat nav, real count badges (routes today,
  exceptions, batches, unpaid) and the user block; 52px context bar with a search that
  actually submits to the customers list.
- **Dashboard rebuilt as the control tower.** Exception-first: "Needs a decision" merges
  exception jobs, linen short at collection, invoices past terms and vehicles off the road —
  no new exceptions table, since a second record of a problem is a second thing to keep in
  step. Plus a plant-stage strip and a runs-today rail. Money surfaces sit behind
  `invoices.read`, because the pack states drivers and floor staff see no dollar figures.
- Not built: the pack's average-turnaround KPI. Nothing records a promised turnaround per
  customer, so the slot shows ready-to-dispatch instead of an invented number.
- Still to come: dispatch planner, billing two-pane, then the Phase-1 modules (customer
  portal, public tracking, Xero, bag scan).
- **Merged Next 16 / Tailwind 4 / Zod 4 from `Dev`.** The theme moved out of the deleted
  `tailwind.config.ts` into the `@theme` block of `globals.css`.

### 2026-08-05 · CI DB job runs Postgres on the runner
The DB job installed `postgresql-16-pgtap` on the runner while Postgres ran in a `services:`
container, so `create extension pgtap` failed with "extension pgtap is not available" — a
server-side extension's `.control` file has to live in the postmaster's own filesystem, and
apt on the host cannot reach into the container. Dropped the service container and start
Postgres 16 on the runner instead (cluster port read from `pg_lsclusters`, so a second
cluster on 5433 does not break it). Migrations, the pgTAP suite and the seed all verified
against this layout.

### 2026-08-05 · Deploy to Supabase; close two REST-surface holes
- **Live project.** `laundrymart-syd` in Sydney, all migrations applied, demo data seeded.
- **`next_number()` was a cross-tenant integrity hole (`0010`).** SECURITY DEFINER, tenant id
  as a plain argument, and reachable at `/rest/v1/rpc/next_number` by anyone holding the anon
  key. No data disclosure, but §11 requires gap-free invoice numbers and this let an outsider
  punch permanent holes in a finance record. Now checks membership.
- **Every `public` function was callable without a login (`0011`).** The `grant execute … to
  anon` boilerplate was only half the story — Postgres also grants EXECUTE to PUBLIC at
  creation, so revoking the anon grant alone changed nothing. Both are now revoked, default
  privileges follow, and `rls_coverage` asserts it. Watch the trap: the 0010 membership check
  raises 42501, the same SQLSTATE as "permission denied", so a probe asserting only on the
  error code passes while the grant is still open.
- `search_path` pinned on the seven functions that lacked it. Security advisors: 18 warnings
  → 5, all remaining ones being SECURITY DEFINER helpers that `authenticated` legitimately
  needs (each is internally scoped to `auth.uid()`, so it only reveals facts about the caller).
- **Sign-in failures are now readable.** The three Supabase clients read `process.env.X!`
  directly, so a missing variable built a client against `undefined` and surfaced much later
  as "credentials not recognised". All three go through the validated `env` object, and the
  underlying auth error goes to the server log (never the credentials, and the user-facing
  message stays vague so the form cannot enumerate accounts).

### 2026-08-05 · Dependency merge into Prod
Merged every open Dependabot branch: Next 16, Tailwind 4, Zod 4, vitest 4, lefthook 2,
@supabase/ssr 0.12, @types/node 26, actions/checkout+setup-node v7. Migrated Tailwind to
CSS-first config, `next lint` to the ESLint CLI with flat config, and `middleware` to the
`proxy` convention. Held TypeScript at 6 and ESLint at 9 (lint stack does not support 7/10).
Fixed three real `set-state-in-effect` violations the new react-hooks rules exposed, and
pointed CI and Vercel at the `Prod`/`Dev` branches they actually use.

### 2026-08-05 · Proof of service, invoice delivery, warehouse, per-kg billing
- **Per-kg invoicing.** `per_kg` agreement lines billed nothing at all — the generator
  returned quantity 0 while the agreement UI happily offered the model, so a configured
  customer was silently under-billed every period. Weight now comes from the period's actual
  pickups (`allocateWeightCharges`), with the included allowance applied per collection.
  Agreement-level `percentage` lines had the same hole and now charge against the same base as
  the levies, so nothing compounds.
- **Photos and signatures.** New private `run-media` bucket keyed by tenant, `/api/media`
  upload endpoint, on-device downscaling, canvas signature capture, and signed-URL display on
  the job page. Works offline through the existing outbox. `Permissions-Policy` relaxed from
  `camera=()` to `camera=(self)` — it would otherwise have blocked the feature.
- **Invoice PDF + email.** Server-rendered tax invoice (`/api/invoices/:id/pdf`) and a Resend
  send action that attaches it. Drafts and voids refuse to send; the address is stamped on the
  invoice; failures are audited, not just surfaced.
- **Warehouse (§7.16).** Production batches through washing → drying → folding → packing →
  ready for dispatch, each stage a real `move_inventory()` call, with mid-process rejects to
  repair or damaged. Manifest freezes when the batch leaves receiving.
- Added `vitest.config.ts` (the `@/` alias, and `jsx: automatic` — without it a `.tsx` module
  under test renders nothing at all). Superseded by `vitest.config.mts` in the
  dependency merge above.

### 2026-08-05 · Initial build
Full MVP against the master spec: multi-tenant spine with RLS + pgTAP proofs, depots,
customers, service agreements with pattern/holiday engine, items, fleet, route templates and
daily routes, jobs with pickups and deliveries, offline driver run, inventory ledger,
invoicing with generation from agreements, seven reports, and administration.

### (init) · Skeleton scaffolded — multi-tenant spine, RLS proof, CI, .claude baseline.

### 2026-08-16 · A login per role, so a capability change can be signed in as
`0025` narrowed the job→invoice flow to two roles, and the only way to check what the other nine
now see was to read `roles.ts`. There were two logins on the whole deployment, both
`super_admin` (in fact both `platform_admin` since 0019). **No migration, no schema, no RLS
policy, no capability and no application code changed** — this is tooling.

- **`npm run seed:roles`** creates one login per role in the demo laundry, resets the password of
  any that already exist, and prints the lot. See §3a. Chosen over adding users to
  `supabase/seed.sql` because that file writes `auth.users` rows directly and gives no password
  — the accounts would exist and nobody could sign in as one.
- **The list lives in `scripts/role-profiles.mjs` and the vitest suite imports that same file**,
  rather than the script carrying its own array. `role-profiles.test.ts` pins it against `ROLES`,
  so a role added to `roles.ts` with no test profile fails a test. Verified by deleting the
  `sales` profile: two assertions fail.
- **Plain JavaScript with a `.d.mts` beside it**, because the runner is bare Node — no build
  step, no `tsx` dependency — while `tsc --noEmit` and vitest still read it typed.
- **`platform_admin` is behind `--platform-admin`.** "All the roles" would otherwise put a test
  login above the tenancy boundary and into `Adelaide Towel Service`, which is the opposite of
  the point of testing on the demo tenant.
- 393 unit tests (was 386; 7 for the profile list). `verify` green. The default
  `--tenant "Harbour Commercial Laundry"` was checked against the live project: the name is
  unique, so the resolver cannot be ambiguous, and the laundry has an active depot for the
  driver record to sit in.

**The eleven profiles are live on `laundrymart-syd`** (2026-08-16), in `Harbour Commercial
Laundry` and nowhere else. Rehearsed and applied the way §11 requires, and verified after:
`is_member(Harbour)` true and `is_member(Adelaide)` **false** for every one of them,
`current_driver_id()` resolving for the driver, the auditor seeing exactly one laundry and zero
platform admins, and 0025 proved through the API in the same probe — the warehouse operator's
UPDATE on `laundry_orders` touched **0 rows** where the office manager's touched 1.

**Provisioned by SQL, not by the script — so the script's own Auth round trip is still
unproven.** This container has no service-role key, so `auth.users` + `auth.identities` were
written directly in the shape GoTrue writes them (bcrypt through `extensions.crypt`, confirmed
`email_confirmed_at`, one email identity each), and the hash was verified against the password
in the rehearsal. What that leaves untested is `createUser`/`updateUserById`, the rerun path, and
**the sign-in itself** — a password grant against `/auth/v1/token` was attempted and the
container's network policy answered 403 to `CONNECT …supabase.co`, the same wall the Resend path
hit on 2026-08-05. Everything GoTrue reads is in place and the hash verifies; that it *accepts*
them is the one claim resting on the shape being right rather than on having been seen.
**Run `npm run seed:roles -- --dry-run` once from a machine that has the key**: it should report
"reset password" for all eleven and create nothing, which is the same statement as the script
agreeing with what is already there.

### 2026-08-16 · Job to invoice belongs to the Owner and the Office manager
The owner's decision: taking a job in, moving it through the plant and billing it is one flow,
and it answers to two people. `orders.*` and `invoices.*` are now held by `super_admin` and
`operations_manager` alone. One migration (`0025`), no new table, no new role, no new
capability, nothing dropped.

- **Named as a block, not omitted role by role.** `JOB_TO_INVOICE` is subtracted from every
  other role, because six of the eleven derive their capabilities from `TENANT_ALL` — so the
  next capability added to `orders.*` would otherwise reopen the flow to all of them silently.
  The same lesson 0019 recorded when it split `TENANT_ALL` out of `ALL`.
- **What each role lost**, stated because none of it is obvious from the diff:
  `warehouse_operator` loses `orders.status` (the floor still runs every warehouse stage and
  all of stock; it no longer walks the customer's job along behind it); `customer_service`
  loses `orders.write`, which was that role's whole point — a laundry wanting counter staff to
  book jobs gives them the Office role now; `dispatcher` loses both blocks and keeps customers,
  routes, stops and fleet; `finance` loses `invoices.*` and keeps `purchases.*`; `auditor`,
  `branch_manager` and `regional_manager` lose the chain entirely.
- **`purchases.*` no longer derives from `invoices.*`.** That pin was added the same day and
  was right while both sides of the ledger answered to the same people. Deriving it now would
  have taken supplier bills and the chart of accounts off finance as a side effect of a
  decision about *customer* billing, so the holders are named per role and pinned literally.
- **The database enforces it too, and that is the half that matters.** `roles.ts` drives the
  screens; every one of these tables is published on `/rest/v1/…`, so the floor's own login
  could have PATCHed a job's status straight past the screen that refuses. 0025 adds
  restrictive write policies — which AND with the existing permissive ones rather than
  replacing them, sidestepping the §11 divergence entirely.
- **SELECT is deliberately not restricted.** A driver must read the job they are delivering;
  that is what My Runs is. So the app decides who is *shown* the flow and the database decides
  who may *change* it. Locking reads down as well would cost the driver their run screen, and
  should be asked for explicitly.
- **ROLE_SUMMARY rewritten for the six affected roles** — a picker still describing a
  dispatcher as "Customers, runs, stops, drivers, trucks and invoices" when they can no longer
  open an invoice is worse than no description at all.
- 386 unit tests (was 379) and **242 pgTAP assertions (was 226)**, including a proof that the
  floor, the counter and finance are each refused through the API while the two roles that own
  the flow are not. Every migration applied to a fresh Postgres 16.

**Applied to `laundrymart-syd` on 2026-08-16**, rehearsed first the way §11 requires. Pre-flight:
no restrictive policy existed anywhere in the schema, all nine tables were present and all nine
carried `tenant_id`. The rehearsal ran the whole migration plus probes in an aborted
transaction, with the decisive one being a rehearsal `warehouse_operator` in the real tenant
whose UPDATE touched **0 rows**. After the apply: 27 restrictive policies across 9 tables, the
5 jobs and 647 invoices untouched, the 508 archived customers untouched, and a rolled-back
probe showing both real logins still writing (they are `platform_admin`, which `has_role()`
admits) while a warehouse operator is refused outright.

### 2026-08-16 · Every delivery failed: nothing ever loads the van
Found on the deployed app, by a driver standing at a customer with a signature pad. Recording
the drop returned **`only 0 of that item are in transit, so 12 cannot be moved out`** — the
guard in `move_inventory()` doing its job over a hole in the model. No migration.

- **The load half of the load/unload pair was never built.** `lib/routes/unload.ts` sweeps
  `in_transit → at_depot` when a van comes back; `confirmLoad` stamps `load_confirmed_at`,
  marks the jobs riding on the run, and **moves no stock**. So the only writer of `in_transit`
  is a *pickup* — the dirty linen going the other way — and a delivery of clean linen drew from
  a pool that was structurally always empty. Confirmed against the live project: every pool on
  the deployment was `at_depot` or `at_customer`, **not one row was `in_transit`**.
- **A delivery now takes the linen from the van when the van has it, and from the run's depot
  otherwise.** Both are true statements about where it was a moment ago, and the second is the
  one that matches what the app actually knows: the load step captures no quantities, because
  the counts are taken at the door. Preferring the van keeps the old behaviour intact for
  anything that did get there, so this only ever adds a path that used to fail.
- **A short van falls back whole rather than splitting.** Five aboard and twelve going out
  takes all twelve from the depot, so one delivery line stays one ledger row and the movement
  history stays reconcilable; the five are swept back by the unload.
- **Both delivery paths go through one helper**, for the reason `unload.ts` is shared: the
  online action and the offline outbox each carried their own copy of the same move, so fixing
  one would have left the other broken — and the offline one is what a driver in a car park
  actually posts through. Wiring `/api/sync` to it exposed that its job query never selected
  `depot_id`, which the typechecker caught.
- **The refusal now names the item and says where the stock is.** "only 0 of that item are in
  transit" describes a state the operator never saw and cannot act on; the message now reads
  "There are only 5 on the van and 3 at the depot for Table Cloth — White…".
- 379 unit tests (was 369; 10 for the source rule and its message). Reproduced against the live
  project in a rolled-back transaction: the old call failed with the screenshot's exact
  sentence, the new source succeeded.

**Not built, deliberately: a real load manifest.** Recording the depot hop when it happens
needs a screen that captures what goes on the van, which is a feature and not a bug fix.

### 2026-08-16 · The YSM Hub design language: paper, ink, teal
A visual re-skin so this app and `ysm-prog/ysm-hub` read as one company's software. **No schema,
server action, RLS policy, capability, query, route or business rule changed** — no migration,
and the 332 unit tests pass untouched. Five files: `globals.css`, `layout.tsx`, one line of
`app-nav.tsx`, the PWA icon and the manifest. See §10b for the system.

- **The whole re-skin fits in the token layer, and that is the point.** `src/` was audited first
  and carries **zero** literal Tailwind palette classes and zero hard-coded hex outside the
  email templates (standalone HTML for inboxes) and the signature canvas. So swapping
  `@layer base` re-skinned every screen — including the authenticated ones that cannot be opened
  here — with no call site touched. The 2026-08-13 rule that nothing hard-codes a colour at a
  call site is what made this a one-file change instead of a 28-file sweep.
- **The palette is YSM's exact bytes, not its mood.** Every hex in their stylesheet was
  converted to HSL and pinned to one decimal, because integer percentages drift 1–2 per channel
  — the first pass rendered the page `#f4f2eb` against YSM's `#f4f1ea`. Verified in the browser:
  `body` computes `rgb(244, 241, 234)`.
- **Geometry moved without touching a call site.** YSM works from four corners (3/6/8/12px).
  `rounded-lg` (104 uses — `Button`, `CONTROL`, the base control rule) → 6px, `rounded-xl`
  (29 uses — `Card`, `DataTable`, `Stat`, `EmptyState`) → 12px. The two load-bearing names were
  aimed at YSM's real numbers rather than the scale being rewritten around them.
- **The dark theme is deliberately not YSM's.** Their stylesheet contrast-checked its dark
  `--ink-3`/`--ink-4` and never its dark accent — `#00898f` is 4.4:1 on the dark page and 4.0:1
  on a dark card, under the 4.5:1 floor their light theme holds itself to — and their semantic
  four stay at light values that are unreadable on `#141412`. Every dark colour keeps YSM's hue
  exactly and moves only lightness until it clears AA three ways: on the page, on a card, and as
  a fill under `--on-status`. Measured as rendered, both themes: page 15.7/15.8:1, primary
  button 6.5/8.3:1, muted-on-card 5.7/4.8:1, all four status fills 5.5–8.7:1.
- **Same fonts, self-hosted.** Instrument Sans, Instrument Serif and JetBrains Mono through
  `next/font` rather than YSM's `<link>` to `fonts.googleapis.com`. That link is the one thing
  in their system that could not be copied: it is fine at a shop counter and wrong in a van, and
  `/run` has to render with no signal. `em` is bound to Instrument Serif italic — YSM's accent
  word in a heading — which was safe to bind globally because the app contained no `<em>` at all.
- **Mono is where this app knowingly diverges.** YSM spends it on eyebrows, table headers and
  badges; adopting that would reverse the 2026-08-13 sweep of 74 `font-mono` and every uppercase
  tracked label across 28 files, done because counter staff and drivers read the result as a
  developer console. Same fonts and same palette, different label voice. The one place mono came
  *back* is `BrandMark`, which is where YSM spends it too — a letter in a tile is a mark.
- **Comfort metrics held**: 15px body and 44px controls, against YSM's 14px/36px. YSM re-declares
  its whole type scale under `@media (pointer: coarse)`, so keeping the touch sizing on a
  counter tablet and a driver's phone follows its reasoning rather than contradicting it.
- 332 unit tests (unchanged — this branch adds no logic to test), `verify` green.
  `/design-preview` asserted light and dark at 320/360/375/390/430/768/1024/1440: no console
  errors anywhere. **The pre-existing dispatch-planner overflow was measured against a
  stash-and-rebuild baseline rather than assumed**: 16px at 320 and 1024 before, 7px after, same
  135/33 overflowing elements and the same 16px smallest tap target — so the re-skin introduced
  none and slightly reduced it.

**Not verified against a live project.** This container has no Supabase credentials, so the
authenticated screens were checked through the component gallery, the token probes and the
build — not by being opened with real rows in them. The re-skin is entirely presentational, so
the risk is cosmetic, but **the rail's active ink pill is not visible in `/design-preview`**
(its pathname matches no nav area) and was verified by token rather than by eye.

### 2026-08-16 · A role above the laundry: platform administrators
Every role until now was a *membership* — a person, a laundry, and what they may do there.
`super_admin` is the top of that ladder and is still bounded by one business, which is correct
and is the whole reason `is_member()` is the isolation boundary. What was missing is the person
who runs the **deployment**: creates a laundry in the first place, holds the settings that apply
to all of them, and answers "what are we running?". One migration (`0019`), one new role, one
new area, nothing dropped.

- **The widening is two functions, not fifty policies.** `is_member()` and `has_role()` each
  gained `or public.is_platform_admin()`. Every privileged surface in the schema already funnels
  through those two, so the change reaches all of them at once, retroactively, and reaches
  policies not written yet. Rewriting policies instead would have been actively dangerous for
  the reason 0017 already recorded: this repo's `invoices` policies carry 0006's inline
  `has_role`, the hosted project's were replaced with `can_read_billing`/`can_write_billing` by
  a branch that has not landed, and re-stating either shape silently drops the other's role
  gate. Touching the helper underneath both leaves each exactly as it is.
- **`platform_admins` is the first table in the schema with no `tenant_id`**, and
  `apply_tenant_policy` is deliberately not used on it — that helper's entire job is to attach a
  tenancy predicate and there is no tenancy here. Its policy is `is_platform_admin()` in both
  directions, so an operations manager cannot even see that the list exists. A membership row
  per laundry was the alternative and only restates the problem: a laundry created tomorrow
  would need one too.
- **The last one cannot be removed, and that rule is in the database.** Delete the final row and
  the policy hides the table from everybody left, so no screen could put it back — only the
  service role could. `guard_last_platform_admin` refuses it; the action's own check is just the
  readable sentence in front of it. The same shape as the People screen's last-administrator
  guard, one level up and with no way back.
- **`platform.read`/`platform.write` are held by this role alone**, and every tenant role is now
  built from `TENANT_ALL` rather than `ALL` — so a capability added to the platform block cannot
  leak into `super_admin` by default. `rolesWith("platform.write")` returning exactly
  `["platform_admin"]` is asserted, as is the Platform rail row being invisible to all eleven
  membership roles.
- **`MEMBERSHIP_ROLES` split out of `ROLES`.** The column's check constraint does not accept
  `platform_admin`, so the People picker and — the one that matters — the Zod enums in
  `inviteMember` and `updateMembership` validate against the eleven. Offering the twelfth would
  have been a choice the insert refuses. A unit test pins the eleven against the constraint.
- **A platform admin had no session at all** until this landed: `requireSession()` read a
  membership and redirected to `?error=no-membership` when there was none. It now resolves them
  against `platform_admins` and an active-laundry cookie, with a switcher in the account menu.
  Same cookie fixes a pre-existing bug §11 records — the membership query was `.limit(1)` with
  **no ordering**, so a person belonging to two laundries landed in an arbitrary one that could
  differ between requests. It is ordered now, and theirs to choose.
- **Release is read-only, deliberately.** `platform_migrations()` reads the Supabase ledger
  (which PostgREST does not publish, so a definer function is the only way in) and there is no
  counterpart that applies anything. Migrations are applied by CI and the Supabase console:
  reviewed, version-controlled, revertible. A browser button running DDL against a database
  holding 508 real customers is a different risk, and "what schema are we on?" does not require
  taking it. **This is narrower than the brief asked for** — see the note below.
- 341 unit tests (was 325) and **179 pgTAP assertions (was 156)**. `verify` green; every
  migration applied to a fresh Postgres 16 and the whole suite run against it. The eleven
  existing proofs pass **unchanged**, which is the check that mattered — with no platform admin
  rows every added predicate is `or false`, so the tenancy boundary is provably where it was.
  The new proof asserts both directions: a platform admin crossing laundries, and an ordinary
  member seeing exactly what they did before *while one exists*.

**Applied to `laundrymart-syd` on 2026-08-16**, rehearsed first the way §11 requires. Three
pre-flight probes ran before anything was committed: no function was `anon`-executable (the
migration's own assertion would otherwise have aborted it), the live `is_member`/`has_role`/
`is_driver_only` bodies matched this repo's 0001 **byte for byte** (so `create or replace` was
not silently reverting an unmerged branch), and neither new table existed. Then the whole
migration plus probes ran inside a transaction that was aborted — including the decisive one: a
third laundry created in the rehearsal was **invisible** to an ordinary member (0 rows, 0
customers, `is_member` false) and visible to a platform admin. After the real apply, `anon` was
shown to read 0 rows from `platform_admins` *with a row present*, so the standard Supabase
`anon` SELECT grant is refused by the policy rather than merely unused — the same proof 0018
required.

**Bootstrapped 2026-08-16: `darshan@` and `jay@ctnorwood.com.au` are the two platform
administrators.** Two rather than one deliberately — the delete guard refuses the last row, so a
single administrator could never be replaced without the service role. Verified as each of them:
`is_platform_admin` true, both laundries visible, `platform_admins` and `platform_settings`
readable, `platform_migrations()` returning all 26 ledger entries. Also verified by rolled-back
probe that a signed-in user who is neither a member nor a platform admin still sees 0 tenants,
0 customers and 0 platform admins, that removing one administrator while two exist is allowed,
and that removing the last is refused with `Cannot remove the last platform administrator`.

**Consequence worth knowing: both logins now resolve as `platform_admin`, not `super_admin`.**
`requireSession()` checks `platform_admins` before memberships, so their `super_admin`
memberships in both tenants are no longer what drives their role — they hold every capability
including the platform block, and land on `Adelaide Towel Service` by default (first by name)
rather than on whichever tenant the old unordered `.limit(1)` happened to return. Their
memberships are untouched and still there; removing their platform row returns them to
`super_admin` exactly as before.

**Two things the brief asked for that this does not do.** Applying migrations from the browser
is not built, for the reason above. And a platform admin still works *inside one laundry at a
time*, switching between them — there is no cross-tenant list view, because every screen in the
app is written against one `tenant_id` and making them span laundries is a much larger change
than the role itself.

### 2026-08-16 · The counter's laundry is billed: monthly invoices, at each customer's price
The Jobs module has recorded what a customer handed over since 0014 and carried **no money at
all** — `laundry_order_items` has a quantity and no price, and the monthly run billed contracts
only. So a customer who simply drops laundry at the counter was never billed by the app, and a
customer with a contract was billed for the pattern but not for the extra bag they brought in.
One migration (`0018` — renumbered on the way in, because `Prod`'s archive work had taken
0017), no new role, no new capability, nothing dropped.

- **A price list, per customer, with the tenant's own list behind it.** `laundry_prices` holds
  one row per kind of laundry either for a customer or for the tenant (`customer_id is null`).
  One table rather than two: two would have doubled every read and left "which one wins" to be
  re-decided at each call site. Its own table rather than a column on `items`, for the reason
  0014 already gave for the item vocabulary — `items` is the linen *the laundry owns and rents
  out*, and a counter hand must not have to create a stock record before they can take in a bag
  of sheets. The unique index is `nulls not distinct`, because under the default rule the
  default list — the row every unpriced customer falls back to — is precisely the one that
  could have been duplicated, and which copy answered would have depended on the plan.
- **A missing price is reported, never billed at nothing.** `buildLaundryCharges` returns the
  lines it could price *and* the items it could not, each with the reason and the job number,
  and the run says so in a toast that sticks with a link to the price list. This is the whole
  safety property: a silently missing line looks exactly like laundry that was never taken in.
  The form obeys the same rule — **blank clears the row, it does not store zero** — which is why
  the parser lives in `prices/price-form.ts` with tests rather than inside the action.
- **A bulk lot is billed on what was actually measured**: by the bag when a bag rate is set and
  the bags were counted, otherwise on the counter's estimate at the piece rate. 0014 allows a
  lot recorded as a note and nothing else; that one cannot be priced and says which job it is.
- **Contracts are no longer a precondition of the monthly run.** It used to refuse the whole
  period with "No active contracts cover that period", which would now hold back every
  counter-only customer. The run is one invoice per customer as before, carrying contract
  charges, replacement charges and laundry lines together.
- **A job is billed exactly once**, marked by `invoice_lines.laundry_order_id`: the run skips
  any job already on an invoice that is not void, so a job completed near a period boundary
  cannot be billed by two runs, and voiding an invoice makes its work billable again.
- **Two screens, both gated on `invoices.read`/`invoices.write`** — the same capability as the
  invoices the prices produce, and the same four roles 0018 lets touch the table. Invoices
  gained a "Laundry prices" tab; a customer's own list is a button on their record. The counter
  can read prices and cannot change them, which is asserted against the database rather than
  trusted to the screen.
- **The save is read → update / insert / delete, not an upsert.** Inferring a `nulls not
  distinct` index through PostgREST's `on_conflict=` is the sort of thing that works in testing
  and surprises in production; diffing also means a save never has a window with no prices in it.
- 325 unit tests (was 297; 19 for the billing rules, 9 for the form parser) and **131 pgTAP
  assertions (was 118)**. `verify` green; every migration applied to a fresh Postgres 16 with
  the whole pgTAP suite and the seed run against it. The price table was added to
  `/design-preview` and asserted light and dark at 320/360/375/390/430/768/1024/1440 — no
  console errors and nothing in it overflows (the 16px at 320 and 1024 is the pre-existing
  dispatch-planner fixture, unchanged by this branch).

**Not verified against a live project.** This container has no Supabase credentials, so no
invoice has been generated with real jobs on it. **Before trusting it: apply 0018, set your
usual prices at Invoices › Laundry prices, then run one month and read the draft.**
### 2026-08-16 · Hide the real records, and put them back
`Adelaide Towel Service` holds 508 real customers and 646 real invoices on the live project,
and they needed to be out of sight for now without being lost. So: **an archive, not a
delete.** One migration (`0017`), one screen, no new table, no new role and no new capability.

- **The hiding is a policy, not a filter.** Nineteen tables gain `archived_at`, and every
  policy already on them gains `and archived_at is null`. A filter added to the fifty-odd
  queries that read customers, jobs and invoices is a filter somebody forgets on the
  fifty-first, and it would do nothing at all about a session talking to PostgREST directly.
  In the policy it is true everywhere, retroactively, including in code not written yet.
- **The policy rewrite reads the catalogue rather than restating the policies.** This repo's
  `invoices` still carries 0006's inline `is_member`/`has_role`; the live project's was
  replaced with `can_read_billing`/`can_write_billing` by a branch that has not landed (§11).
  Writing new policies would have silently dropped whichever shape was not in front of me and
  handed somebody another tenant's invoices. `apply_archive_policy()` pulls each policy's
  expression back out with `pg_get_expr` and wraps it, so every tenancy, role and
  driver-scoping predicate keeps applying exactly as it did — verified against the live shape
  and the repo shape both.
- **`with check` carries the clause too, and that is what makes restore a database function.**
  Once a row is archived nobody signed in can see it, so nobody signed in can clear the flag
  either — an invisible row cannot be updated back into view. Hence
  `set_records_archived(t, archive)`: SECURITY DEFINER, with the membership and role check
  written the way 0010 wrote `next_number()`'s, and called on the caller's **RLS-bound**
  client so `auth.uid()` is a real person. Calling it on the admin client would have left the
  tenant id as whatever the caller passed.
- **The one reader policies do not apply to is the service-role client**, so the overdue-invoice
  sweep filters `archived_at` by hand. Without it a tenant that hid its records would still be
  chased about them, and the notification would link to an invoice nobody can open.
- **Configuration is not business records.** Sites, linen types, vehicles, drivers, people,
  public holidays, route templates and inventory pools are all left alone: an operator who
  hides last year's customers must come back to an app that still knows how they work. The
  boundary is asserted from both directions in `archive.test.ts`.
- **The screen has to prove the records still exist**, or an archive looks exactly like a
  delete. `/admin/data` (Settings → Your records, `admin.write`) reads
  `archived_record_counts()` — which can see the hidden rows precisely because they are hidden
  — and says how many of each are waiting. `ConfirmSubmit` states the consequence, and its
  eyebrow reads "This can be undone" rather than the default "Cannot be undone", because here
  that is the fact that matters.
- **Known boundary, stated rather than papered over:** `daily_routes` is not archived, only
  the stops on it. Runs carry no customer and no screen links to one (§6), so nothing surfaces
  — except that the late-run sweep could still raise a notification about an emptied run. The
  live tenant has no runs at all, so this is theoretical today.
- 304 unit tests (was 297) and **143 pgTAP assertions (was 118)**. `verify` green; every
  migration applied to a fresh Postgres 16 with the whole pgTAP suite and the seed on top of
  it — the existing nine proofs pass unchanged, which is the check that mattered, since the
  rewrite touched policies they own.

**Applied to `laundrymart-syd`, and the real records are archived as of 2026-08-16.** Rehearsed
first the way §11 requires: the whole migration plus an archive, a read-back as
`darshan@ctnorwood.com.au` and a restore, all inside one transaction that was then aborted —
which is how the numbers below were known before anything was committed. Then applied for real
and re-verified. **1,154 rows are hidden** (508 customers, 646 invoices); a signed-in user now
sees 4 customers and 1 invoice, all of them the demo tenant's, and 0 rows of Adelaide Towel
Service reachable through any query. Every hidden row is still on disk with its `archived_at`
stamp — `CUST00001` reads back intact.

**Merged into `Prod` the same day** (`f52116a`, CI green on all three jobs), so the undo is
self-service: Settings → Your records → *Restore my records*. Before that merge the archive
could only be reversed with a direct `set_records_archived(tenant, false)`, which is still the
fallback if the screen is ever unreachable.

Merged into `Prod` rather than `Dev` despite §5's stated order, because `Dev` had fallen 15
commits behind `Prod` and `ats.coreit.com.au` builds from `Prod` — the same route the previous
three features took. `Dev` is still stale and wants a catch-up merge before it is trusted as a
staging branch again.

Two new security advisors, both intentional and both the shape §11 already accepts:
`set_records_archived` and `archived_record_counts` are SECURITY DEFINER and callable by
`authenticated`. That is the entire design — an archived row is invisible, so only a
definer-rights function can count or restore one — and each checks membership (and, for the
write, an admin role) against `auth.uid()` before doing anything. The advisor total is now 12:
these two, the eight pre-existing definer helpers (three of which,
`can_read_billing`/`can_read_pricing`/`can_write_billing`, arrived with the unmerged billing
branch), and the auth leaked-password toggle.

### 2026-08-15 · An owner can add their own people (roadmap Phase D)
The People screen could only re-role somebody who had *already* signed in, and said so:
"Accounts are set up by your system administrator for now." For an owner running a three-person
laundry that meant they could not add their own counter staff or their own driver at all — the
one setup step the app made impossible. **No migration**; no schema, RLS, capability or
workflow change.

- **Invite by email (D5).** Email + role + site on `/admin/users`. `inviteUserByEmail()` creates
  the login on the service-role client — **Supabase sends the mail, so this needs none of the
  Resend configuration** §10 calls optional and the 2026-08-05 entry records as still unproven.
  The membership row deliberately goes in through the caller's own RLS-bound client, so which
  tenant a person joins stays the database's decision and not a server action's. An address that
  already has a login (another tenant on the same deployment, or somebody being invited back) is
  resolved with `generateLink({type:"magiclink"})`, which returns the user and sends nothing —
  a second invitation mail would only invalidate a link they may still be holding. An address
  already on the list is **refused, not upserted**: someone typing it means to add a person, not
  to silently re-role the one who is there.
- **`/auth/invite` is the one client-rendered screen in the app, and it has to be.** Supabase
  bounces an accepted invitation back with the session in the URL **fragment** — never sent to
  the server — and `inviteUserByEmail` cannot use the PKCE `?code=` flow the magic link uses,
  because the browser that sent the invitation is not the browser that opens it, so no code
  verifier is waiting. Pointing the invite at the existing `/auth/callback` would have compiled,
  built and dead-ended every invitee on "Sign-in link was invalid or expired." The page handles
  all three shapes a link can arrive in (fragment, `?token_hash=`, `?code=`), signs the person
  in, offers a password, and strips the tokens out of the address bar. Skipping the password is
  safe and says so: the invitation has already signed them in.
- **`src/lib/supabase/client.ts` is the fourth Supabase client and the only browser one.** It
  reads `process.env.NEXT_PUBLIC_*` directly rather than `lib/env` — deliberately against the
  rule the 2026-08-05 entry set for the other three — because `lib/env` validates
  `SUPABASE_SERVICE_ROLE_KEY`, which must not enter the client bundle and is rightly absent
  there. A missing variable is still caught, by an explicit throw.
- **Access can be taken away, and that opened a lockout `updateMembership` never had.** It
  refused to change *your own* role, which was enough while nobody could remove anybody: with
  two administrators, each can now demote or remove the other, and the second to act would strand
  the tenant with no reachable People screen. Both actions now refuse the last `admin.write`
  holder, counted through the caller's own RLS-bound client and against `rolesWith("admin.write")`
  rather than a hand-written list. A failed count reads as "not stranded", so a transient error
  refuses nothing. Removal deletes the membership only: the login survives, and every row they
  wrote still points at them.
- **Three role presets (D1), and they are presentation.** Owner (`super_admin`), Office
  (`operations_manager`), Driver lead the picker; the other eight follow under "Specialist".
  Each preset carries a *role*, never a capability list — a preset owning capabilities would be
  a second answer to "what can this person do" and the two would drift. The label pairs both
  words ("Owner (Super Admin)") because the members list and the activity log show the stored
  role, and a picker saying only "Owner" would leave an administrator unable to match their
  choice to the row it made. Replaces the four-role `COMMON_ROLES`.
- **D2 (simple mode) is deliberately not built.** It was written against a rail of 22 rows; the
  2026-08-05 audit collapsed that to eleven areas and 2026-08-14 removed the Runs area. Folding
  the remaining eleven into eight now costs a tenant-wide `ui_mode` toggle and mislabels rows for
  narrow roles — a dispatcher would get a "Settings" row containing only Drivers and Vehicles,
  and merging Jobs with Stops contradicts §6. The `ui_mode` slot in `tenants.settings` stays
  reserved. **Re-decided and closed on 2026-08-16** — see §19. D3 (global search) and D4
  (consolidated invoicing) shipped on 2026-08-05.
- 297 unit tests (was 288; 9 for the presets and the derived capability lookup). `verify` green.
  `/auth/invite` is outside the auth gate, so unlike the rest of this phase it could be rendered:
  screenshotted light and dark in both its states and asserted at 320/360/375/390/430/768/1024/
  1440 — no horizontal overflow, no console errors, and one sub-36px target found and fixed.

**Not verified against a live project.** This container has no Supabase credentials, so the
invitation round trip — the mail, the redirect, the fragment, the password — has not been run
end to end. **Before trusting it: add `<origin>/auth/invite` to the Supabase project's allowed
redirect URLs, then invite one real address and follow the link.** Everything else was checked
by typecheck, lint, 297 unit tests, the production build and the rendered page.

## 23. Open: tenant filtering for platform admins
`0019` gave platform admins read access to every laundry by widening `is_member()`, and left
every screen written against "RLS scopes me to one tenant" — which is true for the other ten
roles and false for them. Writes were always filtered to the active laundry, so the failure mode
is not a leak: it is a session that can *see* two businesses, *write* to one, and mix them.

Fixed on 2026-08-18: the jobs list and job form (customers, sites, drivers, staff), both job
write actions, the whole assignment path (`lib/runs/my-runs.ts` and `my-runs/actions.ts` — every
read there now takes a tenant as a **required argument**, so a new call site cannot forget), the
dispatch card, and the orders filter bar.

Fixed on 2026-08-20: the four reads behind the billing bulk actions — the awaiting-invoice queue,
the issue list, the send list, and the laundry price list inside `priceJobFromRateCard` (where the
tenant is a **required argument**, the same convention as `lib/runs/my-runs.ts`). The price list
mattered most: its default row is the one with `customer_id is null`, so unfiltered it returns two
laundries' defaults and the pricer takes whichever came back first.

**Not yet swept:** roughly 345 of the 451 `.from(...)` reads in `src/` still rely on RLS alone —
customers, contracts, invoices, inventory, warehouse, reports, search. For ten of the eleven roles
every one of them is correct. For a platform admin each is a list that may span two businesses.
The candidates are (a) finish the sweep by hand, (b) a `from()` wrapper that appends the filter
for tenant-scoped tables, or (c) stop using `platform_admin` as an everyday working identity —
both holders also hold `super_admin` memberships in both laundries, and dropping the platform row
makes RLS correct for them everywhere at once, at the cost of the Platform area.

## 24. Boards: the round as the operational unit
A job is given to a **Board** — a standing delivery round with its own login — and a date. The
person driving that round changes constantly (leave, sickness, cover, turnover), and re-pointing
every open job at a different employee each time is administration the work does not need.

- **Drivers are kept and are not renamed.** A board is a round; a driver is a person. Who drove
  a round on a day is `daily_routes.operated_by_driver_id`, stamped when the load is confirmed —
  one field rather than a reassignment sweep. Collapsing the two would lose exactly the audit
  trail the client's own cover scenario needs.
- **The substance is RLS, not labels.** `current_board_id()` is the board counterpart of
  `current_driver_id()`, and three policy families read it. A `board` membership with no `boards`
  row leaves it null, every board-scoped policy then matches nothing, and the result is a login
  that works with empty screens — which reads as a broken app. `/boards` calls that state out
  rather than leaving a blank cell, and `boards_scope.test.sql` asserts both halves: a board
  **sees its own** run, stops and laundry, and sees none of another's.
- **`board` is the twelfth membership role and holds a driver's exact capabilities**, pinned by a
  test so the two cannot drift without somebody deciding they should. It deliberately does not
  hold `routes.write`: the client's rule is that a board sees the sequence the office set and
  cannot change it.
- **`lib/runs/assign.ts` is the assignment write, shared** by the job page's Assign and the Runs
  screen's bulk Move — the same reason `lib/orders/complete.ts` exists. What stays in the actions
  is what a person is told, which differs between one job and forty.
- **Cutover:** the owner creates and names their boards (the migration seeds none — a laundry
  with three rounds should not be handed four), links a login to each, and reassigns open jobs.
  **Do not auto-create a board per driver**: it manufactures junk boards named after people,
  which is the model this is leaving.

**Cutover status, 2026-08-20.** Boards exist. `Adelaide Towel Service` carries **Board 1–4** at
the Adelaide depot with **no login on any of them** — none exists, and this deployment cannot send
an invitation *at the time* (auth mail moved onto Resend on 2026-08-24 — until then no invitation
could be sent at all), so `/boards` showed all four as unlinked and their My Runs was empty by
design until a login was made and linked. `Harbour Commercial Laundry`
carries **Board 1**, linked to the `board@roles.example.com` test profile, with `RUN00002` as its
run and LJ00004/LJ00005 on it.

**The empty-screen failure was checked for and did not happen**: signed in as that board, RLS
returns 1 board, 1 run, 2 stops, 3 jobs and 4 customers — and **0 invoices**, so the billing gate
holds for the twelfth role too.

**Cutover completed, 2026-08-24: all five boards have logins.** Adelaide's four rounds are linked
to `board1@`…`board4@ats.example.com`, one login per board, `board` membership in Adelaide and
nowhere else. Boards linked went **1 of 5 → 5 of 5**, so `LJ00003` and `LJ00004` — assigned since
20 August — are no longer sitting on rounds nobody can sign in as, and My Runs answers for them.
- **Written by SQL, in GoTrue's own shape**, for the reason §3a records: this deployment still
  cannot send an invitation, so `inviteUserByEmail` is not available and the accounts were made
  directly. Checked column by column against the `board@roles.example.com` profile — `aud`/`role`,
  confirmed, all eight token columns `''` rather than NULL (the 2026-08-18 trap that made eleven
  logins unresolvable), `email_change_confirm_status` 0, `app_meta`, a bcrypt `$2a$` hash that
  verifies against the shared password, exactly one email identity, and **not** a platform admin.
- **`@ats.example.com`, not a real domain.** RFC 2606 reserves it, so a stray notification or
  overdue chase aimed at a board account can never leave the building — the same reasoning §3a
  gives for `@roles.example.com`. These are not test profiles, though: they are the real laundry's
  operational logins, and `npm run seed:roles -- --remove` does not touch them.
- **The shared password is a bootstrap and wants replacing.** It is deliberately in no committed
  file. **The way to do it now exists**: auth mail goes through Resend as of 2026-08-24, so press
  *Email sign-in link* beside each board on `/admin/users` (§10c) and let each round set its own.
  No SMTP, and no second invitation flow to build.

**What is left of the cutover is the real laundry's, not the code's**: invite one person who is
not a platform admin into Adelaide (its only two members are, and are filtered out of every picker
by design), and enter Adelaide's own laundry prices — it still holds none, so `LJ00002` was priced
by hand.

## 25. The item master, and MYOB
`items` is the one item vocabulary: what the laundry rents out *and* what arrives in a customer's
bag, under the code the business already uses (0032). Staff type TOW001.

- **This overrides 0014's decision, deliberately.** 0014 kept `laundry_order_items.item_type` as
  its own nine-value list so a counter hand would not have to create a stock record before taking
  in a bag of sheets. That was right for a counter with no item list; the client has one, and the
  speed concern is answered by a code-first type-ahead instead.
- **Additive by construction.** `item_type` stays `not null`; an item carries a
  `laundry_category`, and `sync_laundry_item_type()` derives `item_type` from it. So a row can
  never name an item and a category that disagree, and every pre-0032 job, price tier, report and
  filter keeps working untouched. The trigger is in the database because
  `save_laundry_order_items()` inserts directly and so would any import.
- **Pricing gained one tier of specificity and kept its shape.** Within the rate card, a line for
  the exact item beats a line for its category; within the price list, the same. The card still
  beats the list however specific the list is, because somebody negotiated it. `priceListFor`
  excludes per-item rows, so a rate agreed for TOW001 can never answer for every kind of towel.
- **The MYOB importer is not built, and that is the correct state.** The client's own note says
  the developer should inspect the real export rather than assume its field names; guessing is
  how the dropped-column bug in the bills import happened. `MYOB_KINDS` still lists eight kinds
  and items is not one. The columns are here and waiting for the file.
- **Categories are set on the demo laundry only, because the real one has no items.**
  `Adelaide Towel Service` holds **zero** `items` rows — its item master is exactly what the
  unbuilt MYOB import would fill. Harbour's five laundry items carry a category; its laundry bag
  does not, on purpose, because a container the laundry lends is not laundry a customer hands in.
- **An item now carries where its money lands** (0037): `income_account_id` points at a row in
  the chart of accounts, and `xero_item_code` is the item's code in Xero. Both nullable and both
  null, so an item nobody has coded behaves exactly as it did before. The Owner can add to the
  chart itself now — `/accounts` had been read-only since the MYOB import, and its empty state
  said so, which left a laundry wanting one more revenue code with nowhere to put it.
- **The open question is above this work, not inside it.** This app posts invoices and payments
  to **Xero** (§20) while MYOB is a one-off migration source (`docs/IMPORT-MYOB.md`). An item
  code is only worth carrying if it reconciles to the ledger that receives the invoice. Staying
  on MYOB, moving to Xero, or running both are three different builds of the sync half — and
  none of them changes the item master, the codes on job items, or the search, which is why
  those were built first.

## 26. Closed: the counter takes laundry in again
Raised by the 2026-08-24 business analysis, put to the owner, and **decided the same day**:
`customer_service` holds `orders.read/write/status` again. `0034` is the half of it that lives in
the database. Kept as a section rather than deleted, because the reasoning is what stops it being
undone by accident and the trap in it applies to the next role change too.

**The problem.** 0025 made job→invoice one flow answering to the Owner and the Office manager, and
`customer_service` — the role literally named for the counter — lost `orders.*` with everybody
else. So a laundry that wanted a counter hand taking jobs in had to make that person **Office
manager**: 12 rail areas and 31 screens, including the whole ledger, the plant and the activity
log, handed to the least-trained person in the building to do the one job their role is named for.
It is roughly 7 rail rows and 11 screens now — a two-thirds cut for exactly the person the
accessibility work is for, using the mechanism the repo already blesses.

**The trap, which is the part worth keeping.** `roles.ts` drives the nav and the page guards and
is **not** the boundary. `0025_main_flow_owner_office` hard-codes `super_admin` and
`operations_manager` into **restrictive** write policies on nine tables, carved out only for a
driver and (since 0031) a board — and a restrictive policy ANDs with the permissive one. A
`roles.ts`-only change would have let the counter open the form, press Save, and write **zero rows
with no error at all**: the exact silent failure 0031 records for boards, where `lives_ok` passed
throughout. It took `roles.ts` **plus** 0034 **plus** a pgTAP assertion that the write *landed*
rather than merely did not raise. Anyone widening a role on these tables again needs all three.

**What deliberately did not move.** Only three of 0025's nine tables were widened —
`laundry_orders` and its items and activity. `invoices`, `invoice_lines`, `payments`,
`credit_notes`, `credit_note_lines` and `laundry_prices` are untouched, and 0034 asserts by name
that the counter did not reach them. `orders.manage` was not granted: cancelling a job, backdating
a receipt and editing a completed one are the supervisor's set. DELETE on `laundry_orders` was not
granted either — nothing in the app deletes one — while DELETE on `laundry_order_items` was,
because `save_laundry_order_items()` is SECURITY INVOKER and replaces the child set by deleting
and re-inserting, so without it the counter could take a job in and never correct what is on it.

## 27. Account codes on an invoice
The business keeps its books against a chart of 268 accounts — 24 of them income
accounts — and every sale has to be coded to one: towels to `4-1100 Towels - Black`,
a delivery to `4-2000 Delivery Fees Collected`. The chart has been in `gl_accounts`
since 0021 and no invoice has ever carried a code, so the bookkeeper re-codes every
line by hand. `0036` closes that.

- **Three ways to fill one line, not three kinds of line.** The client's ask was a
  line added *by item or by code*, with anything in neither list written as free
  text. Whichever route is taken the row that lands is the same — a description, a
  quantity, a price, a GST flag — and may additionally name an item, an account, or
  both. So there is no `line_kind` column and a line written by the month-end
  roll-up is the same shape as one typed at a desk. The mode switch is an entry
  affordance: with three pickers on screen at once the form asks four questions and
  none of them says which to answer.
- **`items.income_account_id` is the only bridge, and it is a decision.** MYOB keeps
  the same fact under the same words ("Income Account for Tracking Sales"), so an
  item carries its account and every line naming that item is coded by itself —
  typed, generated by the per-job run, or rolled up by the month end.
  `lib/invoices/account-coding.ts` is the one implementation both writers share.
  **A per-charge-type map was considered and left out**: it would be a second place
  a laundry has to keep in step with its own books, this app has no way to check its
  answers, and the first wrong entry would mis-post every invoice after it.
- **An uncoded line is legal, and counted.** A free-text line with no account is
  precisely what the client asked to be able to write, so the app makes the gap
  visible instead of refusing the work: `uncodedLineCount` drives a notice on the
  invoice, on a sent one too — that is when somebody is reconciling it. The same
  call the pricer makes about laundry nobody has priced.
- **Two columns for one fact, and the trigger refuses every way they could
  disagree.** `gl_account_id` is what a report joins on; `account_code` is the
  snapshot that survives a chart being tidied, because an invoice is a record of
  what a customer was told. `sync_invoice_line_account()` derives the text from the
  id — the code is never posted from a browser — and refuses a heading and another
  laundry's account. `on delete set null` clears the link and **leaves the code**,
  which is the whole point of keeping it.
- **The picker offers income accounts and does not insist on them.** A sale belongs
  on one, and offering all 268 makes the right answer harder to find; but a
  bookkeeper offsetting a recharge against an expense account is doing their job, so
  "search every account" is one checkbox away and an exact code always wins the
  ranking. The only hard rule is structural: nothing can be coded to one of the six
  MYOB classification headings, which carry a synthetic code and no meaning.
  `searchAccounts` puts revenue a whole tier ahead of the rest rather than nudging
  it — this chart holds `5-1000 Towel Purchases`, whose name *starts with* "towel"
  where `4-1000 Sales of Towels` merely contains it.
- **Xero has been ready for this since 0026 and was never fed.** `buildInvoicePayload`
  has mapped `account_code` to `AccountCode` from the day it was written and nothing
  selected the column, so every pushed line has landed in Xero's default sales
  account. One word in one `select`.
- **The composer defaults to the mode that produces a coded line with the least
  work**, which is not simply "item": `Adelaide Towel Service` holds 268 accounts and
  **zero items** today, so falling to free text would make the default route the one
  that produces uncoded lines, for the one laundry with a chart to code to.
- **What is not built: an importer for this file.** The uploaded workbook is an
  `.xlsx` whose headers are `Code | Name | Type | Tax code | Level | Current balance ($)`,
  while `readAccounts` (0023) expects a **CSV** with `Tax Code`, `Linked` and
  `Current Balance`. Guessing at the mapping is the discipline §25 records the bills
  import learning the hard way, and it is moot today: all 268 rows are already live
  and match the workbook exactly, so there is nothing to import.
## 28. Run sequencing: locked, edited, saved
The client's rule, in one sentence: **management determines the order of the run, drivers
execute it.** The Runs screen has ordered a board's day since 2026-08-20; what 0036 adds is the
authority, the lock and the concurrency.

**`docs/REQUIREMENTS-RUN-SEQUENCING.md` is the client-facing statement of this feature** — the
master specification of 2026-08-25 restated as requirements and reconciled against what was
built, with the verification evidence, the six places the delivered system departs from the
original wording, and the known limits. This section stays the engineering rationale; that
document is what to hand somebody asking what the feature does.

- **`routes.sequence`, not `routes.write`.** Planning a day and deciding the order of the calls
  turned out to be two decisions. `routes.write` is held by the dispatcher, the branch manager
  and the regional manager; the requirement names two roles, so ordering got its own capability
  (§3) and its own database gate, `can_write_run_sequence()`.
- **Locked is the resting state, and editing is never persisted.** Opening a run shows 🔒 with no
  handle, no arrow and no Save on screen — not a disabled control, which still invites a press.
  Adjust Run is the only way in; it writes nothing, so **Cancel Changes has nothing to undo** and
  a manager who abandons a tab leaves no run "checked out". Save & Lock Run commits the whole
  order at once and the board returns to locked in the same render, because the component adopts
  the server's new order during render (the job form's `defaultCustomerId` pattern).
  `sequence_locked` is therefore the *standing statement* that this order is management's, read
  by the guard trigger — not a mutex, and nothing in the app flips it.
- **The screen is not the boundary, and this is the part that was actually broken.** `jobs` is
  published on `/rest/v1/jobs` under one permissive `for all` policy, so a driver could PATCH
  the sequence of the run they were standing in. Verified by probe against a 0001–0035 database:
  `UPDATE 1`, a real row changed. §4 has the guards.
- **Concurrency is a version, not a timestamp.** `daily_routes.sequence_version` is compared and
  swapped inside the transaction that writes the positions, so a page open for twenty minutes
  cannot silently overwrite a newer sequence. Deliberately not `updated_at`: that column moves
  for status changes and load confirmation, which would refuse saves over edits that never
  touched the order. The day's token is the **highest** version across the board+date's runs and
  the swap matches `<= expected`, so a run opened after the last save joins the day's token
  rather than deadlocking against a neighbour that has already been ordered.
- **One statement, so the run is never numbered twice.** `apply_run_sequence()` re-resolves the
  run from (tenant, board, date) — it does not trust a posted run id — checks the posted set is
  exactly this run's stops, swaps the version and writes 1..n. SECURITY **INVOKER**, so RLS and
  both guards still apply and a direct RPC call from a driver is refused by the same rule that
  refuses the PATCH. Same shape and same reason as `save_laundry_order_items()`.
- **A gap closes; a management decision does not reopen.** `compact_run_sequence()` is
  SECURITY DEFINER because the roles that legitimately empty a stop (a dispatcher reassigning,
  the counter moving a job) are wider than the roles that may order a run. Admitting them is
  safe **by construction rather than by trust**: the function computes the new positions from
  the order already stored and takes no order from its caller, so the most it can do is renumber
  1,3,7 as 1,2,3. That is also why it is allowed past the worked-stop rule — it preserves
  relative order, which is what that rule protects.
- **A new job is appended, never resorted.** `findOrCreateStop` already placed a new stop at
  `max(sequence) + 1`, and the guard is UPDATE-only precisely so that keeps working for the
  roles that assign work and do not order runs. Asserted in pgTAP against a locked, manually
  ordered run.
- **`applyDispatchPlan` moved to the same capability.** The (unlinked) dispatch planner writes
  `jobs.sequence` too, so leaving it on `routes.write` would have made the boundary a fiction —
  a dispatcher refused on Runs could reorder the same day there. Two screens that write one fact
  answer to one authority.
- **The audit row carries both orders in full.** "What was it before?" is the question an audit
  log gets asked about a run that went wrong, and a movement count cannot answer it. Board, run
  date, run ids, previous and new sequence, actor, role and the resulting version.

## 21. Customer pricing and job billing
**Two lifecycles on one job, and they meet at exactly one point.** The operational status says
where the laundry is; `billing_status` says where the money is. Finishing the work sets
`awaiting_review` and **never generates an invoice** — that stamp is made by
`guard_laundry_order_transition`, not by a screen, so no client can bill by completing.

```
operational  new → in_progress → ready_for_delivery → assigned → out_for_delivery → completed
financial    pending → awaiting_review → approved → invoice_generated → invoice_sent → paid
```

- **Current price editable, historical price immutable.** A customer's rate card is
  `customers.rate_card_agreement_id` → a *version* of a service agreement, which is the pricing
  model 0003 already had — no `rate_cards` table was invented. Approval copies today's rates into
  `job_charge_snapshots` and stamps `frozen_at`; `guard_job_charge_snapshot` then refuses every
  update and delete, **including from `super_admin`**. Changing a rate tomorrow cannot move an
  invoice from yesterday, and `job_billing.test.sql` asserts exactly that sentence.
- **The vocabulary bridge is one nullable column.** `service_agreement_lines.item_id` names
  `public.items` (linen the laundry rents out); a counter job's laundry is
  `laundry_order_items.item_type`. 0017 adds `service_agreement_lines.laundry_item_type` so a rate
  line can price what actually arrives in a bag. A line without it is invisible to the job pricer,
  which is correct — it prices a monthly rental, not the bag in front of you.
- **The contract minimum is never applied per job.** A minimum is a promise about a *period*;
  applied per job it would bill a customer with fifteen jobs fifteen minimums. The fuel levy *is*
  on the snapshot, because a levy is genuinely per delivery. The recurring engine still applies the
  minimum to the period, the only unit it means anything on.
- **Laundry the rate card cannot price is reported, never billed at zero.** `priceJob` returns it in
  `unpriced` for a person to decide about — a zero line reads as a decision somebody took.
- **The price list is a tier, not a fallback of last resort, and the *action* has to know that too.**
  `priceJob` has read both since the adoption; `priceJobCharges` refused outright whenever the
  customer held no rate card and discarded the list-priced lines it had already computed — inert
  for all 508 live customers, who hold none. `priceAndSaveJob` in `lib/orders/job-billing.ts` is now
  the one implementation, shared by the job page's Price button and the queue's **Price Selected**,
  and it refuses on *nothing came back priced* rather than on the absence of a card.
  `pricingSourceLabel` names which tier actually answered, because both can price parts of one job.
- **A completed job is a billable source**, and `customers.billing_method` decides the shape at
  generation time: `invoice_per_job` → one invoice each; `*_consolidated` → one invoice carrying
  all of them; `manual` → only ever by explicit selection. Whether August is fifteen invoices or one
  is a column, not a redesign. The rule is pure in `lib/domain/invoice-grouping.ts` — it lives there
  rather than beside the writer because `lib/invoices/from-jobs.ts` reaches `lib/env` and would be
  unreachable from a unit test, the same trap `plan.ts` documents.
- **Generating never sends.** `generateInvoicesForJobs` writes drafts and tells nobody;
  `lib/invoices/send.ts` is the deliberate act, carries its own capability, and is what moves each
  job to `invoice_sent`. Both the single Send and Send Selected go through it.
- **A job cannot be invoiced twice**, enforced by `uq_invoice_source_jobs_once` — a partial unique
  index on `(tenant_id, order_id)`. Partial on purpose: **voiding releases the jobs**, because a
  wrong invoice has to be undoable without stranding the work. That is the only way back out of an
  invoiced billing state, and the guard checks the *link rows* rather than trusting the caller.
- **`invoices.source_job_id` and `invoice_source_jobs` are two records of one fact**, the 0016
  arrangement again: the pointer is set only for a single-job invoice, and
  `guard_invoice_source_job` refuses any way the two could disagree.
- **Bulk means one request, not a loop of server actions.** `/invoices/awaiting` posts a whole
  selection to one action which reads it in one query; partial success reports both numbers and
  names the reason. Capped at 200 and **refused** rather than truncated past that. The full set is
  **price → approve → generate → issue → send**, and every rung has a bulk form: without Issue
  Selected the bulk send was unreachable, since a draft is rightly refused by the send path.
  Review mode carries *two* verbs over one selection (Price and Approve), which is why an unpriced
  row is selectable there — approving one is still refused by name.
- **Xero is recorded, not integrated.** `customers.xero_contact_id/_name` and
  `invoices.xero_invoice_id/_number/_status/_synced_at` are typed in by a person so the two systems
  can be reconciled. There is no Xero client in this codebase, authentication and invoice-state
  mapping are unresolved from the previous checkpoint, and the screens say so.

## 22. Financial capabilities, and why RLS carries them
`pricing.read/write`, `billing.read/write`, `invoices.approve/send/bulk` join `invoices.read/write`
in `roles.ts`. Split finer than the rest because the question is not "who opens the invoices
screen" but "who may see a price at all".

**The one role that lost something: `dispatcher` no longer holds `invoices.read`/`invoices.write`.**
Driver, warehouse operator, customer service and dispatcher hold no financial capability, keep every
operational one, and `nav.test.ts` asserts both. Sales hold `pricing.*` and not the ledger — which
is the entire reason pricing is split from billing. Auditor reads all three and writes none.

**Enforced in the database, not only in React.** 0017 replaces the read policies on `invoices`,
`invoice_lines`, `payments`, `credit_notes`, `credit_note_lines` and `service_agreement_lines`, and
writes new ones for `job_charge_snapshots` and `invoice_source_jobs`, all through
`can_read_pricing()` / `can_read_billing()` / `can_write_billing()`. Two traps worth keeping:

- **A `for all` policy's USING half grants SELECT too.** Narrowing only `<t>_read` would have left
  the hole open through `<t>_write`, so both were replaced and `dispatcher` came out of the write set.
- **0006's read policy was `is_member` and nothing more**, so since My Runs gave drivers a reason to
  hold a session, a driver could read every invoice amount straight off PostgREST. `job_billing.test.sql`
  proves the fix by *reading as a driver and as a dispatcher* and counting zero, rather than by
  inspecting policy text.

The agreement **header** stays readable, and this file used to say "to `agreements.read`" — which is
not what the policy does. `service_agreements` carries 0003's `for all … using is_member(tenant_id)`
and nothing more, so **any member of the laundry reads every contract header**, capability or not.
The decision behind it is sound and unchanged — when a customer is served and on what pattern is
operational information, and only the priced lines moved behind `can_read_pricing()` — so the
wording is what was wrong, not the database. Corrected here on 2026-08-24 rather than narrowed,
which was the owner's call: a header carries no price and no amount. **`audit_logs` was the other
half of that finding and did *not* survive it** — see 0035. It was tenant-wide on the same shape
since 0001, and an activity log's entire job is to say who did what, so "everybody" was the wrong
audience for it.

Consequence worth remembering: the money **reports** are filtered out of `/reports` for a role
without `billing.read`, because a revenue report rendering "$0" is a wrong answer that looks right.
