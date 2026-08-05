# LaundryMart

A commercial laundry management system: customers and service agreements, depot-aware
route planning, a guided offline driver run, inventory across every state, and billing
that matches what actually happened in the field.

This is a logistics and operations platform, not a consumer laundry app.

## What's built

| Area | Status |
|---|---|
| Auth, roles and capabilities | Supabase Auth (password + magic link), 11 roles, capability-gated nav and pages |
| Depots | CRUD, timezone, contacts; every operational entity is depot-scoped |
| Customers | Sequential numbers, ABN check-digit validation, multiple sites and contacts, history |
| Service agreements | Weekly / alternate-weekly / monthly-nth / custom patterns, four holiday rules, versioning, priced lines |
| Items | Categories, rental / wash-only / replacement pricing, weights, reorder levels, delete protection |
| Fleet | Vehicles (capacity, maintenance, trailers, fuel logs) and drivers linked to logins |
| Route templates | Stops with drag-and-drop sequencing (keyboard equivalent included), duplicate, archive |
| Daily routes | Generated from templates per date, driver/vehicle assignment, run states, printable route sheet |
| Jobs | The operational unit; pickups and deliveries as child transactions, exceptions |
| Driver run | Inspection → load → start → stops → return → unload → close, offline-first |
| Inventory | 12 states, movement ledger, replenishment alerts, manual adjustments |
| Invoicing | Recurring generation from agreements, manual invoices, payments, credit notes, void, print/PDF |
| Reports | Daily operations, revenue, receivables, driver productivity, vehicle utilisation, inventory, contract compliance |
| Administration | Depots, users and roles, public holidays, audit log |

Deliberately **not** built, per the spec's MVP boundary: AI features, GPS tracking, the full
warehouse production workflow, and the customer portal. The schema already models the
warehouse states, so that work is additive rather than a rewrite.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript · TailwindCSS · Zod · Supabase
(Postgres + RLS + Auth) · Vercel, pinned to `syd1`.

> The master spec names a .NET 9 Web API. This repo is built on the supplied project
> skeleton, which is Next.js + Supabase end to end. Server Actions and row-level security
> take the place of the Web API and its application-layer authorisation; the domain model
> is exactly the one the spec describes.

## Getting started

```bash
npm install
cp .env.example .env.local        # point at a Sydney Supabase project
npx lefthook install              # local pre-commit gate
npm run dev                       # http://localhost:3000
```

Apply the schema and prove tenant isolation locally (needs Postgres + pgTAP):

```bash
npm run db:test
```

Load demo data into a scratch database:

```bash
psql -f supabase/seed.sql
```

Ship:

```bash
npm run verify                    # typecheck · lint · test · build
```

## How it fits together

**The database is the boundary.** Every tenant table has row-level security with a matching
`with check`, so a bug in the app cannot leak another laundry's data. Drivers are scoped
further: `daily_routes` and `jobs` are filtered to the driver's own record, and pickups and
deliveries inherit that scope through their parent. Four pgTAP suites prove it in CI —
including one that fails the build if any table with a `tenant_id` ships without a policy.

**Business rules that must not be skippable live in Postgres.** A run cannot move to
`in_progress` without a recorded inspection and a confirmed load; it cannot close before it
is unloaded; an item cannot be archived while it is priced on an active agreement; customer
and invoice numbers come from a sequence function rather than the application. Triggers
raise, and the server action surfaces the message.

**Domain logic is pure and tested.** The service calendar (patterns plus holiday rules) and
the pricing rules (precedence, minimum-charge top-up, non-compounding surcharges) are plain
functions with no database access, covered by unit tests. The calendar preview, route
generation and the invoice generator all share them, so those three cannot drift apart.

**The driver app is offline-first.** Captured stops are written to an IndexedDB outbox before
any network call, then replayed against `/api/sync`. Each record carries a client-generated
ref that is unique per tenant in the database, so replaying a queue is idempotent — a phone
that syncs twice inserts once. A service worker keeps the run screen reachable with no signal.

## Layout

```
src/app/(app)/     authenticated screens, one folder per module plus its server actions
src/app/api/sync/  offline batch sync endpoint
src/lib/domain/    pure business logic (service calendar, pricing, ABN, dates) + tests
src/lib/           auth context, roles/capabilities, Supabase clients, audit, formatting
src/components/    UI primitives, forms, nav, drag-and-drop sequencer, offline capture
supabase/          migrations (0001–0006), pgTAP proofs, demo seed
```

## Conventions

- Server Actions only — no REST routes for CRUD. Actions derive `tenant_id` from the session,
  never from the form, and redirect back with `?error=` / `?ok=`.
- Reads go through the RLS-bound client. The service-role client bypasses RLS and must always
  filter `tenant_id` from the session.
- `getClaims()` for auth, never `getUser()` per navigation.
- Every new tenant table ships with an RLS policy **and** a pgTAP proof.
- Money is `numeric(12,2)`; dates that are calendar facts are handled in UTC.

## Before going live

- Point `.env.local` at a **Sydney** Supabase project and enable asymmetric JWT signing keys
  so `getClaims()` verifies locally instead of calling the auth server on every navigation.
- Set the security contact in `SECURITY.md` and the owner in `.github/CODEOWNERS`.
- Load the real public holiday calendar for every state you operate in — an empty calendar
  means every holiday is treated as a normal service day.
- Invoice PDFs currently use the browser's print dialog on a print-styled page. Swap in
  server-side rendering if you need attachments emailed automatically.
