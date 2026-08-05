# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**Status:** MVP plus the four post-MVP items — `npm run verify` and `npm run db:test` both
pass (60 unit tests, 45 pgTAP assertions).

**Not yet done / next up**
1. Connect a real Sydney Supabase project: `.env.local`, asymmetric JWT signing keys, then
   push `supabase/migrations/` and create the first tenant + membership rows. Still the only
   thing blocking a live run-through — everything below was built against local Postgres.
2. Verify the storage policies on the hosted project. 0007 creates the bucket and attaches
   policies to `storage.objects`; locally that runs against the shim in `pg-bootstrap.sql`.
   The SQL is what Supabase expects, but it has not been executed against real Supabase
   storage, and policy ownership on `storage.objects` is the usual place that bites.
3. Send one real invoice email end to end. The provider path is untested against Resend
   itself — no API key here. The PDF render and the template are covered by unit tests.
4. Photo retention. Nothing prunes `run-media`, so it grows forever. Decide a policy (the
   bucket is per-tenant by path, so a lifecycle rule per prefix is straightforward).
5. Consolidated invoices per customer. `generateInvoices` dedupes on customer + period, so a
   customer with two active agreements only ever gets the first one billed. Pre-existing, and
   worth confirming it is intended before changing.

**Gotchas worth remembering**
- A `"use server"` file may only export async functions — constants live in a sibling module
  (`items/categories.ts`, `run/checklist.ts`, `inventory/states.ts`, `warehouse/stages.ts`).
- Supabase's type inference gives up on `.select()` strings built with `+`; use `.returns<T>()`.
- The local pgTAP shim needs `grant usage on schema auth` or security-invoker functions that
  call `auth.uid()` fail for the wrong reason.
- `tsconfig` sets `jsx: "preserve"` because Next owns the transform. Vitest has no such step,
  so `vitest.config.ts` sets `esbuild.jsx = "automatic"` — without it a `.tsx` under test
  renders nothing and react-pdf fails with a confusing "props of null".
- `throws_ok(sql, code, msg, desc)` — with three args the third is the expected *message*, not
  the description. For constraint violations pass `null` for the message.
- The media path is the security boundary. Always build it server-side from `session.tenantId`
  (`mediaPath()`), and re-check stored keys with `isTenantPath()` before writing them to a row.

## Environment readiness
- node v22.22.2
- deps installed (includes `@react-pdf/renderer`, `resend`)
- env missing (copy .env.example) — email and Supabase both need real values
- local Postgres 16 + pgTAP available; `npm run db:test` needs a clean `public` schema

Reminders: RLS on every tenant table (tenant_id); admin client must filter tenant_id;
getClaims not getUser; region syd1.
