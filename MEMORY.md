# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**Done (2026-08-13): the MYOB books for Adelaide Towel Service are in.**
Branch `claude/data-database-import-19ijkz`, pushed. `0014_purchases` is applied to
`laundrymart-syd`, and the tenant `Adelaide Towel Service`
(`20000000-0000-4000-8000-000000000001`, Australia/Adelaide) holds the data with both
super_admin logins as members and one depot (`ADL`). The demo tenant is untouched.

Loaded and verified against the local run, row for row: **customers 459, suppliers 192,
chart of accounts 268, supplier bills 1515, purchase order 1, credit invoices 46.**
Bills outstanding sums to **65,724.25**, exactly Trade Creditors (`2-1200`) in the imported
chart of accounts; no bill is orphaned from its supplier; the 12 supplier debit notes keep
their negative balances. The customer side is knowingly 5,466.06 short of Trade Debtors —
that gap is in the source export, not the import (`docs/IMPORT-MYOB.md`).

Security advisors after the migration: the same five SECURITY DEFINER warnings §18 records
as legitimate, plus a pre-existing `auth_leaked_password_protection` notice that has nothing
to do with this work. No new lint from 0014.

**How to re-run or extend it.** The export is not in the repo (real contact details);
`scripts/import/myob-import.py` is, and `docs/IMPORT-MYOB.md` explains both the run and the
two flags that matter when the database can only be reached through a statement-capped tool
— which was the case here, since this container's egress policy answers 403 to
`CONNECT xujhwljrmogenhvqpkrf.supabase.co` and the Supabase MCP was the only channel.

**Still open, unchanged from before:** `/design-preview` has no section for the three new
screens (`/bills`, `/suppliers`, `/accounts`).

---

**Status:** Live, signed into, and on the upgraded stack (Next 16, Tailwind 4, Zod 4,
vitest 4). `laundrymart-syd` (ref `xujhwljrmogenhvqpkrf`) has the demo tenant; the app is on
Vercel at `ats.coreit.com.au`; sign-in verified end to end.

**Phases A, B and C are all on `Prod`** (`3f59cc6`). `0013_notifications` is applied to
`laundrymart-syd`, verified there: RLS on, one policy, the `nulls not distinct` idempotency
index in place, `anon` reading zero rows through a rolled-back probe, and no new security
advisor (still the same five SECURITY DEFINER warnings §18 records as legitimate).

**Two things must happen on the deployment before Phase C actually does anything:**
1. **Set `CRON_SECRET`** in Vercel (`openssl rand -hex 32`). Until it is set,
   `/api/notifications/sweep` refuses every request — closed by default on purpose — so the
   two swept events (invoice past terms, run not started) never fire. `vercel.json` already
   carries the cron entry; its schedule is **UTC**, five hits covering 07:00–15:00 Sydney.
2. **Prove the Resend path — C0 was never completed.** It could not be: this container's
   network policy answers 403 to `CONNECT api.resend.com`, so no live send was possible at
   any point. Use the **"Send a test email"** button on `/admin/notifications` (admin.write,
   sends only to the signed-in user's own address, audited), then email one real invoice for
   the full path including the PDF. **Do not switch the customer emails on until both have
   been done** — they are off by default and should stay off until the sender is proven.

Owner's C3 decisions (2026-08-05), already the shipped defaults: overdue chase **7 days past
terms, weekly, three at most, friendly in tone**. `enabled` is still false.

The remaining Part-4 forks are Phase D's, not C's: simple-mode default for the existing
tenant, and "Stops" vs "Jobs" as the merged name.

All 12 earlier migrations applied — `0012_optional_inspection` went on 2026-08-05 (verified:
`search_path=public` still pinned, `anon` still cannot execute the guard, no inspection check
left in the body). The app code for it is on `Prod` — it rode the Phase A promotion (`6147b06`),
whose CI was green on all three jobs.

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
**Simplification audit shipped to `Prod`** (`112fab7`, via `Dev` `d1abc68` with all three CI
jobs green). Branch `claude/app-simplification-ux-audit-g94ki1`:
`docs/SIMPLIFICATION-AUDIT.md` is the 13-part deliverable and the record of what changed.
Navigation rebuilt as data (ten areas + tab strip, `sectionFor` longest-match, capability
resolved together with href); `/search` (seven capability-gated `ilike` groups) replacing a
search box that submitted to the customers list; `/help` glossary; `DataTable` stacks to
labelled cards below `sm` and its scroll box is focusable; dashboard's hand-rolled table
folded in via `rowClassName`; `COMMON_ROLES`/`ROLE_SUMMARY` on People; `/admin` retired to a
redirect; 36px tap targets; copy pass. No migrations. Verified: typecheck, lint, 103 tests,
build, `/design-preview` screenshotted light + dark + 390px.
**Live bug this pass found and fixed:** a driver had no rail row for `/dashboard`, the page
the auth gate redirects everyone to — the row required `reports.read`. `capability` on a nav
item is now optional (= every signed-in member), because no single capability is held by all
eleven roles.

Merged `Prod` (Phase C) through on the way to shipping. The two met in the navigation:
C's notification settings screen is a tab under Settings, and its `/notifications` list
stays off the nav map because the bell is its entry point.

**Phase C shipped** on `claude/laundrymart-phase-c-notifications-p90wk1`, merged through `Dev`
to `Prod`. `0013_notifications` adds `tenants.settings jsonb` and the `notifications` table.
Writers: server actions (`notify()`, RLS client) for inspection-failed, vehicle off the road,
stock written off as damaged, and a rejected offline batch; `/api/notifications/sweep` (cron,
bearer token, service-role client, tenant_id from the iterated row) for invoice-past-terms and
run-not-started. Idempotency is `(tenant_id, kind, subject_id, occurred_on) nulls not
distinct`, and `occurred_on` is the day the *event* belongs to — the invoice's due date, the
run's date — not the day the sweep ran, so five hits a day still notify once.
Things worth remembering:
- **Notification rows are forms, not links.** Next prefetches `<Link>` on hover and in the
  viewport, and the destination marks the row read on the way through — links would empty the
  bell for anyone who merely scrolled past. Same reason `openNotification` reads the href back
  from the row instead of the posted form.
- **`nulls not distinct` needs PG15+** and PostgREST's `on_conflict=` names columns only, so
  an expression/coalesce index would have been unusable from supabase-js. Hosted is PG17.6.
- **Supabase's default privileges grant `anon` table-level SELECT on every new public table**,
  including this one. The local pgTAP box does not, so the local assertion passes while the
  hosted grant exists. RLS is the boundary and denies it — verified by probe. Consistent with
  every other table; do not "fix" it in isolation.
- Overdue-reminder idempotency rides the **audit log**, not the notifications table, because a
  reminder recurs; the marker is written only on success, so a bounce retries.

Open item: the live DB has `0012_return_count` applied from unmerged branch
`claude/warehouse-inventory-flow-psooyq`; merging that branch needs a migration-number
reconcile (0013 is taken — that one gets renumbered, not this one).

**Consolidated invoicing is fixed** (same branch): `generateInvoices` now writes one invoice
per customer per period carrying every contract's charges. It used to loop per contract while
de-duplicating on customer + period, so contract two was skipped as "already billed" — every
period, silently. Consolidating is the only correct shape, because the weighed collections
and the damaged/missing linen are recorded against the *customer*: one invoice per contract
would have billed both twice. Each contract's minimum/levy/surcharges still apply to its own
services only; lines keep `agreement_id` (null for replacement charges); header fields the
contracts disagree on fall back via `consolidate()` to the customer's own payment terms, or
to null for a purchase order. Pure part lives in `src/lib/domain/invoicing.ts` with 12 tests.
No migration. **Not yet exercised against real data** — worth generating a period on the demo
tenant for a customer with two contracts before anyone bills a real month.

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
3. **Set `CRON_SECRET` and prove the Resend path** — see the two blockers at the top. The
   provider has still never been reached from anywhere; templates and PDF render are
   unit-tested, the wire is not.
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
