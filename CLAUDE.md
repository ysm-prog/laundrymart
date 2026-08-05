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
- Server Actions only for writes. They derive `tenant_id` from the session and redirect with
  `?error=` / `?ok=`. The one exception is `/api/sync`, which exists because the offline
  outbox needs a batch endpoint it can replay.
- Pure domain logic lives in `src/lib/domain/` with no database access: the service calendar,
  pricing, ABN validation and date helpers. Unit-tested; shared by preview, route generation
  and invoicing so they cannot diverge.
- Invoice PDFs render server-side with `@react-pdf/renderer` (`src/lib/pdf/`), streamed from
  `/api/invoices/:id/pdf` and attached to the Resend email. `serverExternalPackages` keeps the
  renderer out of the client bundle.

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

Roles and capabilities are declared once in `src/lib/roles.ts` and drive the nav, page guards
and action guards. `routes.write` (plan and assign) is separate from `routes.status` (advance
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
- A production batch cannot start with an empty manifest, cannot be completed except from
  `ready_for_dispatch`, and cannot be reopened once finished (`guard_batch_transition`). Its
  manifest freezes when it leaves receiving — only `rejected_quantity` and notes stay writable
  (`guard_batch_line_change`), because everything else drove a stock movement.

## 5. Branch & deploy
Feature branch → `Dev` → `Prod`. CI (`Prod`/`Dev`) runs verify, gitleaks and the DB job
(migrations + pgTAP + seed); the Vercel build runs the same verify gate and only those two
branches deploy. Never force-push `Prod`.

## 6. Routes
`/` landing · `/login` · `/offline` · `/api/sync` · `/api/media` · `/api/invoices/:id/pdf`
`(app)`: `/dashboard` · `/customers[/new|/:id|/:id/edit]` · `/agreements[/new|/:id]` ·
`/items[/:id]` · `/drivers` · `/vehicles` · `/routes/templates[/:id]` ·
`/routes/daily[/:id|/:id/sheet]` · `/jobs[/:id]` ·
`/operations/{pickups,deliveries,exceptions}` · `/run` · `/warehouse[/:id]` · `/inventory` ·
`/invoices[/:id]` · `/reports` · `/admin[/depots|/users|/holidays|/audit]`

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

Proofs in `supabase/tests/`: `rls_isolation`, `rls_coverage`, `driver_scope`,
`business_rules`, `media_scope`, `warehouse_rules` (47 assertions). Demo data in
`supabase/seed.sql` — not applied by migrations.

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

## 10. Environment
See `.env.example`; validated fail-fast in `src/lib/env.ts`. Email delivery
(`RESEND_API_KEY`, `INVOICE_FROM_EMAIL`) is optional — without it the app runs and the send
action says so rather than the deployment refusing to boot.

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
production_batches→auth.users.

## 11. Hosted project
`laundrymart-syd` · ref `xujhwljrmogenhvqpkrf` · ap-southeast-2 (Sydney) · org `ysm-prog`.
Deployed on Vercel at `ats.coreit.com.au`. All 12 migrations applied; demo tenant seeded
(`Harbour Commercial Laundry`); two `super_admin` logins, one also linked to the seeded driver.
Sign-in verified end to end 2026-08-05.

Two things the hosted project does differently from local Postgres, both handled in the SQL:
- `storage.objects` belongs to `supabase_storage_admin`, so `alter table … enable row level
  security` fails with "must be owner". RLS is already on there; 0007 guards the ALTER and
  only runs it against the local shim. Creating *policies* on the table is separately granted
  to `postgres` and works.
- PostgREST publishes `public` as RPC. Anything executable by `anon` is an unauthenticated
  endpoint — see the warning under §7.

## 18. Changelog
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
