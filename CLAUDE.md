# LaundryMart — Project State & Change Management

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
- Pure domain logic lives in `src/lib/domain/` with no database access: the service calendar,
  pricing, recurring invoicing (`invoicing.ts` — one contract's charges, and the
  `consolidate()` rule for header fields two contracts disagree on), ABN validation, date
  helpers, the laundry-job workflow (`laundry-orders.ts`) and the business-timezone
  conversion (`timezone.ts`). Unit-tested; shared by preview, route generation, invoicing and
  the jobs module so they cannot diverge.
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
- `invoices` and friends: readable by any member, writable only by
  super_admin / operations_manager / finance / dispatcher.
- `storage.objects` in the `run-media` bucket: the object key starts with the tenant id, and
  the policies read it back through `media_tenant()` → `is_member()`. The path is the boundary,
  so it is always written from the session and never from the request.
- `notifications`: RLS scopes them to the tenant, as everywhere. The `audience` capability on
  each row narrows them further to the people who can act on it — but that is a UI filter
  applied in `src/lib/notifications/query.ts`, layered on top of RLS and never instead of it.

Roles and capabilities are declared once in `src/lib/roles.ts` and drive the nav, page guards
and action guards. `orders.*` follows the same split as routes: `write` creates and edits a
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
- **A laundry job's six statuses are enforced by `guard_laundry_order_transition`**, not just
  by the screen: no skipping the middle, no going backwards, `completed`/`cancelled` terminal,
  a customer pickup never reaches `out_for_delivery`, and a delivery job cannot be completed
  off the shelf. The trigger stamps `completed_at`/`cancelled_at`, so no client can record a
  finished job with no finishing time. Overdue is **not** among the statuses — it is
  `due_date < today and status not in (completed, cancelled)`, computed every time it is
  asked, where `due_date` is a generated column (delivery date, or collection date for a
  pickup job). A job's laundry list is replaced through `save_laundry_order_items()`, one
  transaction, because a delete-then-insert over PostgREST has a window with no items in it.
- A production batch cannot start with an empty manifest, cannot be completed except from
  `ready_for_dispatch`, and cannot be reopened once finished (`guard_batch_transition`). Its
  manifest freezes when it leaves receiving — only `rejected_quantity` and notes stay writable
  (`guard_batch_line_change`), because everything else drove a stock movement.

## 5. Branch & deploy
Feature branch → `Dev` → `Prod`. CI (`Prod`/`Dev`) runs verify, gitleaks and the DB job
(migrations + pgTAP + seed); the Vercel build runs the same verify gate and only those two
branches deploy. Never force-push `Prod`.

## 6. Routes
`/` landing · `/login` · `/offline` · `/api/sync` · `/api/media` · `/api/invoices/:id/pdf` ·
`/api/notifications/sweep` (cron, bearer-token authed, no session)
`(app)`: `/dashboard` · `/customers[/new|/:id|/:id/edit]` · `/agreements[/new|/:id]` ·
`/orders[/new|/:id|/:id/edit]` ·
`/items[/:id]` · `/drivers` · `/vehicles` · `/routes/templates[/:id]` ·
`/routes/daily[/:id|/:id/sheet]` · `/routes/planner` · `/jobs[/:id]` ·
`/operations/{pickups,deliveries,exceptions}` · `/run` · `/warehouse[/:id]` · `/inventory` ·
`/invoices[/:id]` · `/reports` · `/search` · `/help` · `/notifications` ·
`/admin` (redirects) `[/depots|/users|/holidays|/audit|/notifications]`

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
- `0013_notifications` — `tenants.settings jsonb` (AD-3) and the `notifications` table
  (AD-4). Beware the numbering drift: the unmerged branch
  `claude/warehouse-inventory-flow-psooyq` carries its own `0012_return_count.sql`, which
  has to be renumbered when it lands.

Proofs in `supabase/tests/`: `rls_isolation`, `rls_coverage`, `driver_scope`,
`business_rules`, `media_scope`, `warehouse_rules`, `notifications_scope`, `laundry_orders`
(83 assertions). Demo data in `supabase/seed.sql` — not applied by migrations.

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

## 10b. Design system
From the Plantline concept pack (`Logistics SaaS Product Design` handoff). Two rules carry it:

- **Colour means status only.** Teal `--primary` = on track, amber = warning, red = late,
  green = resolved. The solid call-to-action is therefore **near-black `--action`**, not teal —
  a teal button would read as a status. Never use `bg-primary` for a button.
- **Flat.** Hairline `--border` everywhere, `--strong` for inputs and frames, one faint shadow,
  and radius 0. The whole `--radius-*` and `--shadow-*` scale is zeroed in the `@theme` block
  of `globals.css`, so `rounded-*` classes are inert rather than scattered edits. Tailwind v4
  cannot theme `rounded-full` (it is a static utility), so the handful of pills were made
  square at the call site instead — do not reintroduce it.

IBM Plex Sans + Mono via `next/font` (self-hosted; the driver app must render without signal),
bound to `--font-sans`/`--font-mono` in `@theme`. Mono is structural — every number,
identifier, date and uppercase label. `Eyebrow` in `ui.tsx` is the label voice;
`text-3xs`/`text-2xs` are the 9px/10px steps.

The strong border colour is named `--color-strong`, **not** `--color-border-strong`: the
latter would spell the utility `border-border-strong` and silently do nothing.

The sidebar rail keeps literal hex colours: it is the one surface that stays near-black in
both themes, so it must not follow the surface tokens — and it needs its own `border-r`,
because in dark mode the page background is that same near-black and the edge vanishes.

Guidance idiom: `Stage` in `ui.tsx` (the run screen's numbered-step pattern, also the
dashboard's getting-started checklist — exactly one step actionable at a time);
`ConfirmSubmit` for final actions (inline consequence strip + optional reason, no modals);
`FlashToast` for action feedback. UI labels use operator language (Sites, Contracts, Problems,
Stops, Collections, Weekly runs, Today's runs, In the plant, Stock, Item types, People,
Activity log) while routes and schema keep the domain names —
`docs/SIMPLIFICATION-DESIGN.md` holds the rename map, `docs/SIMPLIFICATION-AUDIT.md` the
full audit and what remains open. `/help` is the in-product glossary that maps each label
back to its trade term.

`CONTROL` in `ui.tsx` is the one input skin — import it, never restyle an input at the call
site. `DataTable` is the one table: below `sm` it stacks each row into a labelled card, so a
new screen gets a working phone layout for free and a hand-rolled `<table>` silently does not.
Anything tappable carries `min-h-9` (36px).

`/design-preview` is a static component gallery: no data, 404s in production, outside the auth
gate so it can be rendered from a build box. It exists because every real screen is an async
server component reading Supabase, so none render without a live project — which is how a
doubled hairline and an invisible dark-mode sidebar edge both survived a green `verify`.
Screenshot it with Playwright (`/opt/pw-browsers/chromium`) against `next start`.

**PostgREST embeds fail at runtime, not compile time.** Where two tables have more than one FK
between them the embed is ambiguous and errors with PGRST201. `daily_routes` has two to
`vehicles` (`vehicle_id`, `trailer_id`), so those must be written
`vehicles!daily_routes_vehicle_id_fkey(...)`. Current ambiguous pairs: daily_routes→vehicles,
daily_routes→auth.users, drivers→auth.users, inventory_movements→inventory_pools,
production_batches→auth.users, **laundry_orders→auth.users** (four FKs: `assigned_to`,
`created_by`, `delivered_by`, `collected_by` — which is why staff names are resolved through
`src/lib/staff.ts` rather than embedded).

## 11. Hosted project
`laundrymart-syd` · ref `xujhwljrmogenhvqpkrf` · ap-southeast-2 (Sydney) · org `ysm-prog`.
Deployed on Vercel at `ats.coreit.com.au`. All migrations through `0014_laundry_orders`
applied (0014 on 2026-08-13, verified by rolled-back probe: the full workflow, the three
guards, `anon` reading nothing, and no new security advisor). Note the live project also
carries `0012_return_count`, `purchases`, `supplier_payments` and `import_helpers` from
branches not yet merged here, so `supabase/migrations/` is not a complete picture of it.
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
  not the boundary. The load meter averages the customer's own recent weighed collections and
  says how many stops it actually covers; there is no promised weight per stop in the schema,
  so it never implies one.
- `/invoices` is the register + working pane. The left list is a chase queue, the right pane
  is issue / send / take payment, and selection lives in `?selected=` so filters and page
  survive. Pane actions post a `return_to` and come back to the pane — `returnTo()` in
  `lib/actions.ts` only honours a plain same-site path, since an absolute one would make every
  action an open redirect. `/invoices/:id` stays as the printable record and the place lines
  are edited and invoices voided.

## 18. Changelog
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
