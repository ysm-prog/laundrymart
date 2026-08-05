# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**Status:** MVP plus the four post-MVP items (proof of service, invoice PDF + email,
warehouse, per-kg billing), on the upgraded stack (Next 16, Tailwind 4, Zod 4, vitest 4).
`Prod`, `Dev` and the feature branch are all in sync.

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

**Toolchain decisions from the dependency merge**
- TypeScript is pinned to **6**, not the 7 Dependabot offered: typescript-eslint has no TS 7
  support, so ESLint dies with "typescript-eslint does not support TS 7.0".
- ESLint is pinned to **9**, not 10: `eslint-config-next@16` depends on typescript-eslint 8,
  which targets ESLint 9 — under 10 the parser throws `scopeManager.addGlobals is not a
  function`. Revisit both when the lint stack catches up.
- Next 16 needs `experimental.useTypeScriptCli` because TS no longer exposes the JS
  compiler API Next used to call.
- Tailwind 4 is CSS-first: there is no `tailwind.config.ts`, the theme lives in `@theme`
  in `globals.css`, and PostCSS uses `@tailwindcss/postcss`.
- `npm install eslint@^9.40.0` hangs for minutes before failing — 9.40 does not exist and
  npm backtracks the whole tree. Check the version exists before pinning.

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
