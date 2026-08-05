# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**Status:** Live, signed into, and on the upgraded stack (Next 16, Tailwind 4, Zod 4,
vitest 4). `laundrymart-syd` (ref `xujhwljrmogenhvqpkrf`) has migrations 0001–0011 and the demo
tenant; the app is on Vercel at `ats.coreit.com.au`; sign-in verified end to end.

**`0012_return_count` is written and green locally but NOT yet applied to the hosted
project** — apply it before the branch deploys, or `/warehouse` 500s on the missing
`route_id` column.

The warehouse flow was rebuilt around the depot count on branch
`claude/warehouse-inventory-flow-psooyq`: `/warehouse/count/:routeId` pre-fills the driver's
own numbers, records the difference as a real loss/find movement, and `move_inventory()` now
refuses to leave a pool negative. See the top changelog entry in CLAUDE.md. Deliberately not
done: shortening the six plant stages — the user kept all six.

Working through the Plantline design handoff in four stages. **1 (theme), 2 (shell) and the
dashboard from 3 are done.** Remaining: dispatch planner, billing two-pane, then stage 4 —
customer portal, public tracking, Xero push, bag scan. The handoff bundle lives in the
scratchpad, not the repo; re-upload it in a new session.

The theme was written against Tailwind 3 and ported to 4 during the merge from `Dev`: there is
no `tailwind.config.ts` any more, everything lives in the `@theme` block of `globals.css`.

CI's DB job runs Postgres on the runner, not in a `services:` container — pgTAP is a
server-side extension, so its `.control` file has to sit in the postmaster's own filesystem
and apt on the runner cannot reach into a container.

**Next up**
0. Apply `0012_return_count` to `laundrymart-syd`, then walk one run end to end: driver
   unloads → "Count it" on `/warehouse` → wash through to ready.
1. Dispatch planner and billing two-pane (stage 3), then stage 4.
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
  (`items/categories.ts`, `run/checklist.ts`, `inventory/states.ts`, `warehouse/stages.ts`).
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
