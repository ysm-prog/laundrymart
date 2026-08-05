# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**Status:** Live, signed into, and on the upgraded stack (Next 16, Tailwind 4, Zod 4,
vitest 4). `laundrymart-syd` (ref `xujhwljrmogenhvqpkrf`) has the demo tenant; the app is on
Vercel at `ats.coreit.com.au`; sign-in verified end to end.

All 12 migrations applied — `0012_optional_inspection` went on 2026-08-05 (verified:
`search_path=public` still pinned, `anon` still cannot execute the guard, no inspection check
left in the body). The app code for it is merged to `Dev` and not yet promoted to `Prod`; 0012
only removes a check, so `Prod`'s currently deployed code is unaffected by it.

**Simplification redesign:** Phase A is merged to `Prod` (6147b06, CI green). **Phase B
shipped** on branch `claude/laundrymart-phase-b-88p0e4`: the 3-step contract wizard (one post
to `createAgreement`, which now inserts priced lines and derives the delivery pattern from
`delivery_follows`), the four-field customer quick-create (site address → first location;
embedded in wizard step 1 via the HTML `form` attribute; `createCustomer` honours
`return_to`), dashboard "Plan my day" (shared `instantiateRoutes`, lands on the planner only
when a run is crewless or a stop is on no run), the in-run "Something's wrong" capture
(outbox `exception` record kind + `exception` media scope; photo path rides
`exception_notes` as a `[photo:…]` marker via `src/lib/exceptions.ts`), and flash-toast fix
links (`fail`/`done` take optional `{href,label}`; template re-validates same-site).
No migrations. Verified: typecheck, lint, 88 tests, build, /design-preview screenshotted
light+dark. Wizard gotcha for later: step fields hide rather than unmount, and none carry
`required` — a hidden required field fails native validation unfocusable.
Next: Phase C (notifications — the one migration, shared with `tenants.settings`). Three
owner decisions are queued in Part 4 of the design spec. Open item: the live DB has
`0012_return_count` applied from unmerged branch `claude/warehouse-inventory-flow-psooyq`;
merging that branch needs a migration-number reconcile.

Working through the Plantline design handoff in four stages. **Stages 1–3 are done** — theme,
shell, dashboard, and now the dispatch planner and the billing two-pane (branch
`claude/dispatch-planner-billing-pane-xte9qg`, commit `ab43335`, pushed; no PR opened). The
handoff bundle lives in the scratchpad, not the repo; re-upload it in a new session.

**Stage 4 is blocked on four decisions, not on code.** Customer portal / public tracking,
Xero and bag scan each have a fork the user asked to be consulted on rather than guessed:
1. *Tracking auth* — unguessable per-job link (no login) vs emailed one-time code vs full
   Supabase Auth portal accounts. Whatever wins, the tracking page shows no dollar figures:
   §10b already establishes that drivers and floor staff see none, and a link holder is less
   trusted than either.
2. *Xero push* — DRAFT (a human approves in Xero before anything reaches a customer) vs
   AUTHORISED-and-we-still-send vs AUTHORISED-and-Xero-sends (retires the Resend path).
3. *Xero return path* — pull payments back on a schedule, push-only, or webhook. Push-only
   leaves the aging strip, the chase queue and the dashboard's overdue KPI permanently stale
   once Xero starts collecting.
4. *Bag scan* — durable bag registered to a customer (needs a `bags` table + issue/retire) vs
   one-time label per collection vs just scanning existing item barcodes to speed up counts.
Only the first Xero option and the durable-bag option imply new migrations.

The theme was written against Tailwind 3 and ported to 4 during the merge from `Dev`: there is
no `tailwind.config.ts` any more, everything lives in the `@theme` block of `globals.css`.

Run workflow: the inspection is no longer a database gate (0012) and `routes.status` is now a
capability separate from `routes.write`, held by dispatchers/managers plus `driver` and
`customer_service`. Office and driver unload share `src/lib/routes/unload.ts`.

CI's DB job runs Postgres on the runner, not in a `services:` container — pgTAP is a
server-side extension, so its `.control` file has to sit in the postmaster's own filesystem
and apt on the runner cannot reach into a container.

**Next up**
1. Stage 4, once the four decisions above are made.
2. **Enable asymmetric JWT signing keys** on the project so `getClaims()` verifies locally
   instead of calling the auth server on every navigation (§2 assumes this).
3. Send one real invoice email end to end — the Resend path is still untested against the
   provider. PDF render and template are unit-tested.
4. Photo retention: nothing prunes `run-media`. Per-tenant path prefixes make a lifecycle
   rule straightforward.
5. Consolidated invoices: `generateInvoices` dedupes on customer + period, so a customer with
   two active agreements only gets the first billed. Pre-existing; confirm intent first.

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
  (`items/categories.ts`, `run/checklist.ts`, `inventory/states.ts`, `warehouse/stages.ts`,
  `routes/planner/plan.ts`).
- **`revalidatePath` matches on route and ignores a query string.** Three invoice actions were
  passing `/invoices/<id>?ok=…`-shaped paths to it and quietly revalidating nothing.
- Tailwind only emits utilities it can see in the source, so `text-${tone}` compiles to
  nothing. Tone classes get written out in full (see the aging strip in `invoices/page.tsx`).
- `/design-preview` renders the real `PlannerBoard`; a no-op inline `"use server"` function
  satisfies its `action` prop, and a zero-arg function is assignable to `(fd: FormData) => …`.
- Screenshot loop that worked here: `npm run build && npm start`, Playwright from the
  scratchpad against `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, element shots of
  `main > div.border-t`. `.env.local` needs only the three Supabase vars — copying
  `.env.example` wholesale fails validation on the *optional* blocks (empty `SENTRY_DSN`,
  `RESEND_API_KEY`, `INVOICE_FROM_EMAIL`).
- Supabase's type inference gives up on `.select()` strings built with `+`; use `.returns<T>()`.
- `tsconfig` sets `jsx: "preserve"`; `vitest.config.ts` must set `esbuild.jsx = "automatic"`
  or a `.tsx` under test renders nothing and react-pdf fails with "props of null".
- `throws_ok(sql, code, msg, desc)` — with three args the third is the expected *message*.
  Pass `null` for the message on constraint violations.
- The media path is the security boundary. Build it server-side from `session.tenantId`
  (`mediaPath()`), and re-check stored keys with `isTenantPath()` before writing them to a row.
- **`storage.objects` is owned by `supabase_storage_admin`.** `alter table … enable row level
  security` fails with "must be owner of table objects" on the hosted project (RLS is already
  on). `create policy` on it *is* granted to `postgres`. 0007 guards the ALTER accordingly.
- **Direct `delete from storage.objects` is blocked** by `storage.protect_delete()`. Escape
  hatch for genuinely orphaned metadata: `set local storage.allow_delete_query = 'true'`.
- **Revoking a grant from `anon` does not revoke the implicit PUBLIC grant.** Postgres gives
  EXECUTE to PUBLIC at function creation. Assert on `has_function_privilege('anon', …)`, never
  on the grant statements. And note 42501 means both "permission denied" *and* whatever your
  own `raise … errcode = '42501'` throws — do not use it alone to prove a lockout.
- This container's network policy blocks `*.supabase.co`, so REST/Storage cannot be exercised
  over HTTP from here. Verify by simulating roles in SQL (`set local role anon` + `set local
  "request.jwt.claim.sub"`) through the MCP `execute_sql` tool instead.

## Environment readiness
- node v22.22.2; deps installed
- `.env.local` has the live URL + anon key; service-role key is set on Vercel, still blank here
- local Postgres 16 + pgTAP available; `npm run db:test` needs a clean `public` schema
  (`drop schema public cascade; create schema public;` first) and Postgres may need
  `service postgresql start`

Reminders: RLS on every tenant table (tenant_id); admin client must filter tenant_id;
getClaims not getUser; region syd1; never re-add `grant execute … to anon`.
