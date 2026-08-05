# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**Status:** Deployed to a live Sydney Supabase project. `npm run verify` passes (60 unit
tests) and `npm run db:test` passes (47 pgTAP assertions). All 11 migrations are applied to
`laundrymart-syd` (ref `xujhwljrmogenhvqpkrf`) and the demo tenant is seeded.

**Next up**
1. **Create the first login.** Auth has no users, so `memberships` is empty and nobody can get
   past `/login`. Dashboard → Authentication → Add user, then run:
   ```sql
   insert into public.memberships (user_id, tenant_id, role)
   select u.id, '10000000-0000-4000-8000-000000000001', 'super_admin'
     from auth.users u where u.email = 'YOU@example.com';
   ```
   For the driver run, also: `update public.drivers set user_id = <that user's id>
   where id = '60000000-0000-4000-8000-000000000001';`
2. **Paste `SUPABASE_SERVICE_ROLE_KEY` into `.env.local`.** Everything else is filled in. The
   key is not readable through the management API — Settings → API → service_role.
3. **Enable asymmetric JWT signing keys** on the project so `getClaims()` verifies locally
   instead of calling the auth server on every navigation (§2 assumes this).
4. Send one real invoice email end to end — the Resend path is still untested against the
   provider. PDF render and template are unit-tested.
5. Photo retention: nothing prunes `run-media`. Per-tenant path prefixes make a lifecycle
   rule straightforward.
6. Consolidated invoices: `generateInvoices` dedupes on customer + period, so a customer with
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
- `.env.local` written with the live URL + anon key; service-role key still blank
- local Postgres 16 + pgTAP available; `npm run db:test` needs a clean `public` schema
  (`drop schema public cascade; create schema public;` first) and Postgres may need
  `service postgresql start`

Reminders: RLS on every tenant table (tenant_id); admin client must filter tenant_id;
getClaims not getUser; region syd1; never re-add `grant execute … to anon`.
