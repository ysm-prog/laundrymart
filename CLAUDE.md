# Electro Services — Project State & Change Management
> Customer-facing name since 2026-08-13. The repository, package and storage keys
> stay `laundrymart`; renaming those would orphan queued offline data on drivers' phones.

## 0. Update protocol
This is the canonical shipped state. MEMORY.md holds the live session delta (auto-loaded).
After any change to `src/` or `supabase/`, in the SAME commit: update the affected section
below and add a Changelog entry (newest on top). The Stop hook warns on drift.

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
- **The assignment model is `Job → Driver → Delivery Date`, and it lives on the job.**
  `laundry_orders.assigned_driver_id` + `assigned_delivery_date` (0016) are the user-facing
  truth and what My Runs queries. `stop_id → jobs.route_id → daily_routes` (0015) survives as
  the *operational placement* — the depot load, the run sheet and the inventory unload sweep are
  all built on it — and is resolved by the server action, never chosen by a person. No run code
  appears in any office or driver screen. Two copies of one fact is normally the bug 0015 was
  written to avoid, which is why the guard trigger refuses every way they could contradict.
- Pure domain logic lives in `src/lib/domain/` with no database access: the service calendar,
  pricing, recurring invoicing (`invoicing.ts` — one contract's charges, and the
  `consolidate()` rule for header fields two contracts disagree on), ABN validation, date
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
  `drivers.id` via `current_driver_id()`.
- `pickups` / `deliveries` / `*_lines` / `vehicle_inspections`: scoped through the parent's
  own RLS, so a driver never reaches another driver's paperwork.
- `laundry_orders` (+ its items and activity, through the parent): tenant-wide for office
  roles; for a **driver-only** member, narrowed by 0015/0016 to jobs **assigned to them** or
  sitting on a stop of one of their own runs. My Runs is the first screen to give a driver a reason to read the table, and
  a tenant-wide policy would have handed them every customer's laundry through PostgREST at
  the same moment. No non-driver role's predicate changed.
- `invoices` and friends: readable by any member, writable only by
  super_admin / operations_manager / finance / dispatcher.
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

Roles and capabilities are declared once in `src/lib/roles.ts` and drive the nav, page guards
and action guards. `ROLE_PRESETS` names three of the eleven in an owner's words — Owner
(`super_admin`), Office (`operations_manager`), Driver — and is **presentation only**: a preset
carries a `role`, never a capability list, so there is exactly one answer to "what can this
person do". `rolesWith(capability)` is derived, and is what the People screen uses to refuse the
change that would leave a tenant with nobody holding `admin.write`. `orders.*` follows the same split as routes: `write` creates and edits a
laundry job, `status` walks it through the workflow (the plant floor advances work it does not
plan, so `warehouse_operator` holds `status` without `write`), and `manage` is the supervisor's
set — cancel a job, backdate a receipt, edit one already completed. `driver` holds none of
them: counter jobs are not stops on a run. `routes.write` (plan and assign) is separate from `routes.status` (advance
a run that is already out): the latter also goes to `driver` — RLS confines them to their own
run — and to `customer_service`, so a stuck run is not waiting on a dispatcher.

## 4. Business rules enforced in the database
- Run cannot start without `load_confirmed_at`; cannot close before `unloaded_at`
  (`guard_route_transition`). The vehicle inspection is recorded and surfaced but is **not**
  a gate — 0012 dropped that check, because only a driver on `/run` can create an inspection
  and a run without one had no legal transition out of `inspection_pending`.
- Items on an active agreement cannot be soft-deleted (`guard_item_soft_delete`).
- Customer / agreement / job / invoice / credit-note numbers come from `next_number()`.
- `move_inventory()` is the single entry point for stock changes: it upserts both pools and
  writes the ledger row in one transaction.
- `recalculate_invoice()` keeps invoice totals consistent with lines and payments.
- **Recurring invoicing is one invoice per customer per period**, carrying every contract
  they hold. Not a preference: the weighed collections and the damaged/missing linen are
  recorded against the *customer*, so one invoice per contract would bill the same
  kilograms and the same lost towels once per contract. Each contract's minimum, levy and
  surcharges are still computed against its own services only; every line keeps its
  `agreement_id` (null for replacement charges, which belong to no contract).
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
- **A job is assigned to a Driver and a Delivery Date, and the two records of that cannot
  disagree** (`guard_laundry_order_assignment`, 0016). Eligibility first: a customer pickup is
  refused outright, so is a job still in the plant and a completed or cancelled one, the driver
  must be an active driver of the same tenant, and the stop has to belong to the same tenant
  *and* the same customer. Then coherence: the stop's run must name the same driver and the
  same date, and — the case worth naming — **a job on a crewed run must name a driver**, since
  otherwise it sits on somebody's route sheet and on nobody's My Runs. Three check constraints
  hold the rest: `assigned` requires both columns, both columns require a non-ready status, and
  a driver without a date is refused. The guard fires only when the stop or the assignment
  changes, so completing an assigned job never re-runs eligibility.
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
`(app)`: `/dashboard` · `/my-runs[/jobs/:id]` · `/customers[/new|/:id|/:id/edit]` · `/agreements[/new|/:id]` ·
`/orders[/new|/:id|/:id/edit]` ·
`/items[/:id]` · `/drivers` · `/vehicles` · `/routes/templates[/:id]` ·
`/routes/daily[/:id|/:id/sheet]` · `/routes/planner` · `/jobs[/:id]` ·
`/operations/{pickups,deliveries,exceptions}` · `/run` · `/warehouse[/:id]` · `/inventory` ·
`/invoices[/:id]` · `/reports` · `/search` · `/help` · `/notifications` ·
`/admin` (redirects) `[/depots|/users|/holidays|/audit|/notifications|/data]`

**There is no user-facing Runs module.** `/routes/daily`, `/routes/planner` and
`/routes/templates` still exist, still work and still hold their history, but **no rail row
points at them** and no office or driver screen links to one. Nobody creates, opens or manages
a run: a job is given straight to a driver and a date, and the `daily_routes` row underneath is
found-or-created by `assignJobToDriver`. `nav.test.ts` asserts, for every role, that no
navigation href starts with `/routes/`. Drivers and Vehicles were tabs under the old Runs area
and are not run management, so they moved to their own **Fleet** area rather than vanishing
with it.

**"My Runs" (`/my-runs`) is the driver's whole workspace**: the jobs assigned to them for a
date they choose, grouped To deliver / Out for delivery / Completed, with Confirm Load and
Start Route in front of them. Gated on `routes.read` so a manager can open it for a driver.
`/run` survives as the second tab ("At the depot") because it owns the offline outbox, the
service worker and the unload inventory sweep, and is the one screen that must work with no
signal.

**Navigation is data** (`src/lib/nav.ts`): eleven areas, each with optional `children`
rendered as a tab strip (`SectionNav` in the layout, not per page). An area is visible
when any screen inside it is, and `navigationFor()` resolves its href *and capability*
together to the first screen the role can open — so a row never links somewhere the auth
gate would bounce. `sectionFor()` (longest match wins) decides which rail row highlights
and which tabs show, so detail routes stay inside their area. `capability` is optional:
omitted means every signed-in member, which is what `/dashboard` and `/help` need since no
single capability is held by all eleven roles. **"Jobs" (`/orders`) and "Stops" (`/jobs`) are two different things and both keep their rail
row**: a stop is a visit on a driver's run, a job is a customer's laundry from counter to
hand-back. The route path is `/orders` because 0004 already took `/jobs` — the same
label-is-not-the-route arrangement as Contracts (`/agreements`) and Linen (`/inventory`), and
`/help` defines both words. `/notifications` (the bell's list) is
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
- `0017_archive_records` — `archived_at` + a partial index on the nineteen customer/job/
  invoice record tables, and `archived_at is null` appended to every policy already on them.
  Adds no table, drops nothing, and changes no row until somebody asks. The three functions
  are `archivable_tables()` (the list, stated once and read by both the DDL loop and the
  stamper), `set_records_archived(t, archive)` and `archived_record_counts(t)`.
- `0013_notifications` — `tenants.settings jsonb` (AD-3) and the `notifications` table
  (AD-4). Beware the numbering drift: the unmerged branch
  `claude/warehouse-inventory-flow-psooyq` carries its own `0012_return_count.sql`, which
  has to be renumbered when it lands.

Proofs in `supabase/tests/`: `rls_isolation`, `rls_coverage`, `driver_scope`,
`business_rules`, `media_scope`, `warehouse_rules`, `notifications_scope`, `laundry_orders`,
`run_assignment`, `archive_records` (143 assertions). Demo data in `supabase/seed.sql` — not
applied by migrations.

**Do not re-add `grant execute on all functions in schema public to anon`.** That
boilerplate in 0002–0009 is what exposed every SECURITY DEFINER helper on
`/rest/v1/rpc/…` without a login; 0011 revokes it and `rls_coverage` asserts it stays
revoked.

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
action says so rather than the deployment refusing to boot. `CRON_SECRET` is optional on the
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
**Electro Services.** Replaced the Plantline language (flat, square, near-black chrome,
monospace labels) in the 2026-08-13 redesign — it read as a developer console to the counter
staff, drivers and managers who use it. Tokens live in the `@layer base` block of
`globals.css`; nothing hard-codes a colour, radius or shadow at a call site.

- **One brand colour, used for intent.** `--primary` (blue `#2145c4`; lifted to `#7ba4f5` on
  dark) marks the primary action and the place you are — buttons, active nav, focus ring.
  `--action` is a separate token pointed at the same value, because the whole app spells the
  solid button `bg-action`; the seam stays if the two ever need to diverge.
- **Status keeps its own family** (`--success`, `--warning`, `--danger`, `--info`) and is
  **always paired with a written label** — a badge never carries meaning by colour alone.
  Text on a solid status fill uses `--on-status`, never a literal white: the dark theme lifts
  every status colour to clear AA on a dark surface, which leaves them far too light for white.
- **Soft, not flat.** The `--radius-*` scale is real again (4–24px, `rounded-lg` = 10px is the
  default control corner) and `--shadow-*` is a light layered set. A base rule gives
  `button`/`select`/`textarea`/`input` the system radius, so the ~120 controls hand-rolled when
  the language was square cannot come out square; a `rounded-*` utility still wins.
- **Comfortable, not dense.** 15px body, 44px (`min-h-11`) inputs and touch-first buttons, 40px
  standard buttons, nothing tappable below 36px. Page titles 26–28px, section 16px, body 14–15px.

Inter + JetBrains Mono via `next/font` (self-hosted; the driver app must render without signal).
**Mono is bound but deliberately rare** — genuine machine text only, never a date, total or job
number. `Eyebrow` in `ui.tsx` is the supporting-label voice: 12px sentence case, *not* the old
9px mono uppercase.

The strong border colour is named `--color-strong`, **not** `--color-border-strong`: the latter
would spell the utility `border-border-strong` and silently do nothing.

The sidebar is a light surface driven by its own `--sidebar-*` tokens (it used to be near-black
with literal hex). Tokenised separately so the rail can be themed without touching the page
surfaces beside it.

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
`/admin/users` invites by email. `inviteUserByEmail()` on the service-role client creates the
login (Supabase sends the mail, so this needs no Resend configuration); the **membership** row
goes in through the caller's own RLS-bound client, so which tenant somebody joins is still the
database's decision. An address that already has a login is resolved with
`generateLink({type:"magiclink"})`, which returns the user without sending anything.

**The invite lands on `/auth/invite`, not `/auth/callback`.** Supabase bounces an accepted
invitation back with the session in the URL **fragment**, which never reaches the server, and
`inviteUserByEmail` cannot use the PKCE `?code=` flow because the browser that sent the
invitation is not the one that opens it — there is no code verifier waiting. So `/auth/invite`
is **the one client-rendered screen in the app**, and `src/lib/supabase/client.ts` is the one
browser Supabase client (it reads `process.env.NEXT_PUBLIC_*` directly, because `lib/env`
validates the service-role key and must not enter the client bundle). It handles all three
shapes a link can arrive in — fragment, `?token_hash=`, `?code=` — and strips the tokens out of
the address bar once the session is stored.

**Deployment note:** the Supabase project must list `<origin>/auth/invite` under its allowed
redirect URLs, or invitations fall back to the project's Site URL. The origin is read off the
request, so a preview deployment invites into itself.

Removing access deletes the membership and nothing else: the login survives (it may be their
access to another tenant), and every row they wrote still points at them. Both removal and a
role change refuse the last `admin.write` holder — with two administrators each could otherwise
demote the other and lock the tenant out of its own People screen.

## 11. Hosted project
`laundrymart-syd` · ref `xujhwljrmogenhvqpkrf` · ap-southeast-2 (Sydney) · org `ysm-prog`.
Deployed on Vercel at `ats.coreit.com.au`. All migrations through `0017_archive_records`
applied (0014 on 2026-08-13, 0015 and 0016 on 2026-08-14, 0017 on 2026-08-16), each verified by
rolled-back probe rather than trusted.

**There are two tenants and only one of them is real.** `Adelaide Towel Service`
(`20000000-…-000000000001`) is the business: 508 customers and 646 invoices, no laundry jobs
yet. `Harbour Commercial Laundry` (`10000000-…`) is the demo seed. Both logins
(`darshan@`, `jay@ctnorwood.com.au`) are `super_admin` of **both**, and `requireSession()`
picks a membership with `.limit(1)` and **no ordering** — so which of the two a person lands in
is effectively arbitrary. Pre-existing, and worth fixing before anything depends on the split.

**The real tenant's records are archived as of 2026-08-16** (§18): 1,154 rows hidden, nothing
deleted, restored by `set_records_archived('20000000-…-000000000001', false)`.

The live project also carries real supplier data from the unmerged purchases branch — 1,515
supplier bills, 192 suppliers, 268 GL accounts, 636 import-activation rows. **No screen in this
build reads any of it**, so it is already invisible in the deployed app and 0017 leaves it
alone. If those screens ever land, that data needs its own decision. For **0016** that was: the three existing jobs backfilled from the run
chain and read back (LJ00004/5 `ready_for_delivery → assigned` under Sam Okoye for 16 Aug,
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
  survive. Pane actions post a `return_to` and come back to the pane — `returnTo()` in
  `lib/actions.ts` only honours a plain same-site path, since an absolute one would make every
  action an open redirect. `/invoices/:id` stays as the printable record and the place lines
  are edited and invoices voided.

## 18. Changelog
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
  reserved. D3 (global search) and D4 (consolidated invoicing) shipped on 2026-08-05.
- 297 unit tests (was 288; 9 for the presets and the derived capability lookup). `verify` green.
  `/auth/invite` is outside the auth gate, so unlike the rest of this phase it could be rendered:
  screenshotted light and dark in both its states and asserted at 320/360/375/390/430/768/1024/
  1440 — no horizontal overflow, no console errors, and one sub-36px target found and fixed.

**Not verified against a live project.** This container has no Supabase credentials, so the
invitation round trip — the mail, the redirect, the fragment, the password — has not been run
end to end. **Before trusting it: add `<origin>/auth/invite` to the Supabase project's allowed
redirect URLs, then invite one real address and follow the link.** Everything else was checked
by typecheck, lint, 297 unit tests, the production build and the rendered page.

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
