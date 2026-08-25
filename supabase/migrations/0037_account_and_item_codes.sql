-- ============================================================================
-- 0037 — the Owner keeps the codes, and the codes reach Xero
--
-- Two halves of one request.
--
-- ## 1. The chart of accounts could not be added to, and could be edited by
--       anybody
--
-- `/accounts` has been read-only since the MYOB import landed — its empty state
-- says "appears here once it is imported from your accounting system" — so a
-- laundry that wants one more revenue code has no way to add it. There is no
-- create action anywhere in `src/`.
--
-- Underneath, the opposite was true. `0021` attached `apply_tenant_policy` to
-- `gl_accounts`, which is a single permissive `for all` policy carrying nothing
-- but `is_member(tenant_id)` — so **every member of the laundry could INSERT,
-- UPDATE and DELETE the chart of accounts straight off `/rest/v1/gl_accounts`**,
-- a driver included. Adding a create screen gated on a capability while leaving
-- that in place would have made the screen a decoration.
--
-- The `for all` is **dropped and replaced**, not supplemented: its USING half
-- grants SELECT as well, so a narrower read policy beside it would still have
-- been a second door onto the same rows. That is the trap 0033 recorded for
-- `laundry_prices` and §22 for 0017 before it — this is the third table.
--
-- The read narrows to the roles that already hold `purchases.read`, which is
-- what the screen has always been gated on, so no role loses anything it could
-- reach through the app. It matters because `gl_accounts.current_balance` is on
-- this table: an open read is every account balance in the business, handed to
-- a driver's session.
--
-- `gl_accounts` is deliberately **not** in `archivable_tables()`, so unlike the
-- 0028 case there is no `archived_at` clause to preserve when the policies are
-- rewritten. Checked, not assumed — the assertion block below re-reads it.
--
-- ## 2. Nothing the app knows ever reached Xero as a code
--
-- `buildInvoicePayload` has mapped `line.account_code` to Xero's `AccountCode`
-- since 0026, and **nothing has ever populated it**: `push.ts` selects
-- `description, quantity, unit_price, taxable` and stops. So every invoice line
-- this app has pushed landed in Xero uncoded, to be sorted out by hand. No
-- `ItemCode` was sent either, so the item codes staff type here reconcile
-- against nothing.
--
-- Both codes are **opt-in per row and null by default**, which is the property
-- that matters: Xero rejects an invoice naming a code its own chart does not
-- carry, so a column that defaulted to our code would have turned one wrong
-- mapping into every invoice failing to push. Nothing is sent until somebody
-- says what the Xero code is, and until they do this migration changes no
-- payload at all.
--
-- Adds no table. Drops no column. Changes no row.
-- ============================================================================

-- --------------------------------------------- the chart, and who owns it ---
alter table public.gl_accounts
  add column if not exists xero_account_code text;

comment on column public.gl_accounts.xero_account_code is
  'This account''s code in the laundry''s Xero chart, when they have said what '
  'it is. Null means "do not code Xero lines to this account" — deliberately '
  'not defaulted to `code`, because Xero refuses an invoice naming a code it '
  'does not carry and a guess would fail every push rather than one.';

create or replace function public.can_read_accounts(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array[
    'super_admin', 'operations_manager', 'finance',
    'branch_manager', 'regional_manager', 'auditor'
  ]);
$$;

create or replace function public.can_write_accounts(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array[
    'super_admin', 'operations_manager', 'finance',
    'branch_manager', 'regional_manager'
  ]);
$$;

comment on function public.can_write_accounts(uuid) is
  'Who may change the chart of accounts: the app''s `purchases.write` holders. '
  'The auditor reads and does not write, which is the whole of that role.';

-- Dropped rather than wrapped. A permissive `for all` policy''s USING half is a
-- SELECT grant, so leaving it beside a narrower read would leave the read open.
drop policy if exists gl_accounts_member on public.gl_accounts;

create policy gl_accounts_read on public.gl_accounts
  for select to authenticated
  using ((select public.is_member(tenant_id)) and (select public.can_read_accounts(tenant_id)));

create policy gl_accounts_insert on public.gl_accounts
  for insert to authenticated
  with check ((select public.is_member(tenant_id)) and (select public.can_write_accounts(tenant_id)));

create policy gl_accounts_update on public.gl_accounts
  for update to authenticated
  using ((select public.is_member(tenant_id)) and (select public.can_write_accounts(tenant_id)))
  with check ((select public.is_member(tenant_id)) and (select public.can_write_accounts(tenant_id)));

create policy gl_accounts_delete on public.gl_accounts
  for delete to authenticated
  using ((select public.is_member(tenant_id)) and (select public.can_write_accounts(tenant_id)));

-- ------------------------------------------------ an item carries its codes --
-- The income account a line for this item is coded to, and the item's code as
-- it is in Xero. Both nullable: an item nobody has coded behaves exactly as it
-- did before, which is what makes this safe to apply to a live chart.
alter table public.items
  add column if not exists income_account_id uuid references public.gl_accounts(id) on delete set null,
  add column if not exists xero_item_code text;

comment on column public.items.income_account_id is
  'The revenue account an invoice line for this item is coded to. Read through '
  'to gl_accounts.xero_account_code when an invoice is pushed to Xero.';
comment on column public.items.xero_item_code is
  'This item''s code in the laundry''s Xero inventory, when they have said what '
  'it is. Null means no ItemCode is sent — see the note on '
  'gl_accounts.xero_account_code for why this is never guessed.';

create index if not exists idx_items_income_account
  on public.items (income_account_id) where income_account_id is not null;

-- ------------------------------------- the laundry's default sales account --
-- Most invoice lines carry no item at all — a fuel levy, a contract minimum, a
-- laundry charge — so item-level coding alone would leave the ones that matter
-- most to a bookkeeper uncoded. This is the fallback, chosen once per laundry
-- from its own Xero chart on the settings screen, beside the bank account the
-- payments already post to.
alter table public.xero_connections
  add column if not exists sales_account_code text,
  add column if not exists sales_account_name text;

-- Re-created to carry the two new columns. A `create or replace` drops the
-- pinned search_path and the grant posture, so both are restated after — the
-- trap 0012 recorded and 0027 hit on this very function.
drop function if exists public.xero_connection_status(uuid);

create or replace function public.xero_connection_status(t uuid)
returns table (
  xero_tenant_name text,
  connected_at timestamptz,
  expires_at timestamptz,
  payment_account_code text,
  payment_account_name text,
  sales_account_code text,
  sales_account_name text,
  connected boolean
)
language sql stable security definer set search_path = public as $$
  select c.xero_tenant_name, c.connected_at, c.expires_at,
         c.payment_account_code, c.payment_account_name,
         c.sales_account_code, c.sales_account_name, true
    from public.xero_connections c
   where c.tenant_id = t
     and public.has_role(t, array['super_admin','operations_manager']);
$$;

-- ------------------------------------------------------------------ grants ---
revoke all on function public.can_read_accounts(uuid) from public, anon;
revoke all on function public.can_write_accounts(uuid) from public, anon;
revoke execute on function public.xero_connection_status(uuid) from public, anon;

grant execute on function public.can_read_accounts(uuid) to authenticated, service_role;
grant execute on function public.can_write_accounts(uuid) to authenticated, service_role;
grant execute on function public.xero_connection_status(uuid) to authenticated, service_role;

-- ------------------------------------------------- assert its own outcome ----
do $$
declare
  v_count integer;
begin
  -- 1. The columns, all nullable, so no existing row is invalidated.
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='gl_accounts'
                    and column_name='xero_account_code') then
    raise exception '0037: gl_accounts.xero_account_code is missing' using errcode='P0001';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='items'
                    and column_name='income_account_id') then
    raise exception '0037: items.income_account_id is missing' using errcode='P0001';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='xero_connections'
                    and column_name='sales_account_code') then
    raise exception '0037: xero_connections.sales_account_code is missing' using errcode='P0001';
  end if;

  select count(*) into v_count from public.items where xero_item_code is not null;
  if v_count > 0 then
    raise exception '0037: % item(s) arrived with a Xero code', v_count using errcode='P0001';
  end if;

  -- 2. The permissive `for all` is gone and four explicit policies replace it.
  --    Checked by name *and* by command, because the failure that matters is a
  --    `for all` surviving beside them and re-granting SELECT (the 0033 trap).
  if exists (select 1 from pg_policy
              where polrelid='public.gl_accounts'::regclass and polname='gl_accounts_member') then
    raise exception '0037: the permissive gl_accounts_member policy survived' using errcode='P0001';
  end if;
  if exists (select 1 from pg_policy
              where polrelid='public.gl_accounts'::regclass and polcmd='*') then
    raise exception '0037: a `for all` policy remains on gl_accounts' using errcode='P0001';
  end if;

  select count(*) into v_count from pg_policy where polrelid='public.gl_accounts'::regclass;
  if v_count <> 4 then
    raise exception '0037: gl_accounts carries % policies, expected 4', v_count using errcode='P0001';
  end if;

  -- 3. Every policy still names the tenancy predicate. Rewriting policies is
  --    how a tenancy clause gets dropped by accident — 0028 exists because
  --    exactly that happened one migration earlier.
  select count(*) into v_count from pg_policy
   where polrelid='public.gl_accounts'::regclass
     and coalesce(pg_get_expr(polqual, polrelid), '')
         || coalesce(pg_get_expr(polwithcheck, polrelid), '') like '%is_member%';
  if v_count <> 4 then
    raise exception '0037: only % of 4 gl_accounts policies name is_member', v_count
      using errcode='P0001';
  end if;

  -- 4. The write gate really is narrower than the read gate, which is the
  --    entire point of having two. If these ever became the same set somebody
  --    would rightly delete one.
  if pg_get_functiondef('public.can_write_accounts(uuid)'::regprocedure) like '%auditor%' then
    raise exception '0037: can_write_accounts admits the auditor' using errcode='P0001';
  end if;
  if pg_get_functiondef('public.can_read_accounts(uuid)'::regprocedure) not like '%auditor%' then
    raise exception '0037: can_read_accounts excludes the auditor' using errcode='P0001';
  end if;

  -- 5. Not archivable, so there was no `archived_at` clause to preserve. Stated
  --    as an assertion rather than a comment, because if this table is ever
  --    added to the archive set these policies have to be rewritten with it.
  if 'gl_accounts' = any (public.archivable_tables()) then
    raise exception '0037: gl_accounts is archivable and these policies dropped its clause'
      using errcode='P0001';
  end if;

  -- 6. Nothing new is reachable without a login (0011, 0029).
  if has_function_privilege('anon', 'public.can_read_accounts(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.can_write_accounts(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.xero_connection_status(uuid)', 'EXECUTE') then
    raise exception '0037: anon can execute a new function' using errcode='P0001';
  end if;

  -- 7. 0026's posture on the token table must survive the re-created function.
  if has_table_privilege('authenticated', 'public.xero_connections', 'SELECT') then
    raise exception '0037: authenticated can read xero_connections' using errcode='P0001';
  end if;
end $$;
