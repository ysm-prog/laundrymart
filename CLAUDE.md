# LaundryMart — Project State & Change Management

## 0. Update protocol
This is the canonical shipped state. MEMORY.md holds the live session delta (auto-loaded).
After any change to `src/` or `supabase/`, in the SAME commit: update the affected section
below and add a Changelog entry (newest on top). The Stop hook warns on drift.

## 1. Overview
Commercial Laundry Management System — customers, service agreements, depot-aware routing,
an offline driver run, inventory and billing. Next.js 15 (App Router) + Supabase
(Postgres/RLS/Auth) + Vercel, AU (Sydney).

The master spec names a .NET 9 Web API; this build follows the supplied skeleton instead
(Next.js + Supabase, Server Actions in place of REST). The domain model is unchanged.

## 2. Architecture
- RLS-bound client `createClient()` (safe) vs service-role `createAdminClient()` (bypasses
  RLS — always filter `tenant_id`).
- Auth via `getClaims()` (local JWT verify, no network); `requireSession()` is memoised per
  request. `requireCapability()` guards pages; `assertCapability()` guards actions.
- Functions pinned to `syd1` to co-locate with the Sydney DB (vercel.json).
- Server Actions only for writes. They derive `tenant_id` from the session and redirect with
  `?error=` / `?ok=`. The one exception is `/api/sync`, which exists because the offline
  outbox needs a batch endpoint it can replay.
- Pure domain logic lives in `src/lib/domain/` with no database access: the service calendar,
  pricing, ABN validation and date helpers. Unit-tested; shared by preview, route generation
  and invoicing so they cannot diverge.

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

Roles and capabilities are declared once in `src/lib/roles.ts` and drive the nav, page guards
and action guards.

## 4. Business rules enforced in the database
- Run cannot start without `inspection_id` and `load_confirmed_at`; cannot close before
  `unloaded_at` (`guard_route_transition`).
- Items on an active agreement cannot be soft-deleted (`guard_item_soft_delete`).
- Customer / agreement / job / invoice / credit-note numbers come from `next_number()`.
- `move_inventory()` is the single entry point for stock changes: it upserts both pools and
  writes the ledger row in one transaction.
- `recalculate_invoice()` keeps invoice totals consistent with lines and payments.

## 5. Branch & deploy
Feature branch → PR → main. Vercel build runs the verify gate; CI runs verify, gitleaks and
the DB job (migrations + pgTAP + seed). Never force-push main.

## 6. Routes
`/` landing · `/login` · `/offline` · `/api/sync`
`(app)`: `/dashboard` · `/customers[/new|/:id|/:id/edit]` · `/agreements[/new|/:id]` ·
`/items[/:id]` · `/drivers` · `/vehicles` · `/routes/templates[/:id]` ·
`/routes/daily[/:id|/:id/sheet]` · `/jobs[/:id]` ·
`/operations/{pickups,deliveries,exceptions}` · `/run` · `/inventory` · `/invoices[/:id]` ·
`/reports` · `/admin[/depots|/users|/holidays|/audit]`

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

Proofs in `supabase/tests/`: `rls_isolation`, `rls_coverage`, `driver_scope`,
`business_rules` (30 assertions). Demo data in `supabase/seed.sql` — not applied by
migrations.

## 8. Offline
`src/lib/offline/queue.ts` (IndexedDB outbox, client-generated refs) +
`src/components/offline-capture.tsx` (capture UI, flush on save / `online` / SW message) +
`public/sw.js` (shell cache, never intercepts writes) + `/api/sync` (idempotent batch insert
keyed on `client_ref`, unique per tenant).

## 9. Environment
See `.env.example`; validated fail-fast in `src/lib/env.ts`.

## 18. Changelog
### 2026-08-05 · Initial build
Full MVP against the master spec: multi-tenant spine with RLS + pgTAP proofs, depots,
customers, service agreements with pattern/holiday engine, items, fleet, route templates and
daily routes, jobs with pickups and deliveries, offline driver run, inventory ledger,
invoicing with generation from agreements, seven reports, and administration.

### (init) · Skeleton scaffolded — multi-tenant spine, RLS proof, CI, .claude baseline.
