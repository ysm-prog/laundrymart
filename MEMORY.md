# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**Status:** Live and signed into. `laundrymart-syd` (ref `xujhwljrmogenhvqpkrf`) has all 11
migrations and the demo tenant; the app is on Vercel at `ats.coreit.com.au`; sign-in verified
end to end. `npm run verify` passes (60 unit tests), `npm run db:test` passes (47 pgTAP).

Working through the Plantline design handoff in four stages. **1 (theme), 2 (shell) and the
dashboard from 3 are done and pushed.** Remaining: dispatch planner, billing two-pane, then
stage 4 — customer portal, public tracking, Xero push, bag scan. The handoff bundle is in the
scratchpad, not the repo; re-upload it if the session is new.

**The restyle has never been looked at.** It is verified structurally only — built stylesheet
inspected, typecheck, lint, build. This container cannot reach `*.supabase.co`, so the app
cannot be run here. Eyeball it before building further on top.

**Next up**
1. Dispatch planner and billing two-pane (stage 3), then stage 4.
2. **Enable asymmetric JWT signing keys** on the project so `getClaims()` verifies locally
   instead of calling the auth server on every navigation (§2 assumes this).
3. Send one real invoice email end to end — the Resend path is still untested against the
   provider. PDF render and template are unit-tested.
4. Photo retention: nothing prunes `run-media`. Per-tenant path prefixes make a lifecycle
   rule straightforward.
5. Consolidated invoices: `generateInvoices` dedupes on customer + period, so a customer with
   two active agreements only gets the first billed. Pre-existing; confirm intent first.

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
