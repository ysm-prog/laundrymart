-- Proof: a tenant can be held inactive and turned back on without losing the
-- distinctions the imported data arrived with.
--
-- The deactivation itself is trivial and needs no proof — it is an UPDATE that
-- sets one column. What is worth proving is the *reverse*, because the failure
-- is silent and only shows up months later. Real imported data is not uniformly
-- active: some records were already switched off in the business the data came
-- from. If the hold overwrites those and the release sets everything back to
-- 'active', records the operator deliberately retired come back to life, are
-- offered in every customer picker, and start appearing on runs and invoices.
-- Nothing errors. Nobody is told.
--
-- So the assertions below are mostly about what must NOT move: rows already
-- inactive get no state row and stay inactive, a second hold does not overwrite
-- the first one's memory with 'inactive', and a status changed by hand after the
-- hold is a later decision that survives the release.
--
-- `suppliers` is covered by the same code path but cannot be asserted here: its
-- table is created by a migration on an unmerged branch, so it does not exist in
-- a database built from supabase/migrations/. The functions skip a missing table
-- via to_regclass, which is what lets this file run at all.
begin;
select plan(15);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@example.com'),
  ('22222222-2222-2222-2222-222222222222','b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Imported Laundry'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Other Laundry');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

-- The shape of a real import: mostly active, a minority already retired, and
-- the other values the status constraint allows.
insert into public.customers (id, tenant_id, customer_number, business_name, status) values
  ('c0000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','C1','Active One','active'),
  ('c0000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','C2','Active Two','active'),
  ('c0000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','C3','Already Retired','inactive'),
  ('c0000000-0000-4000-8000-000000000004','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','C4','On Hold','on_hold'),
  ('c0000000-0000-4000-8000-000000000005','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','C5','Archived','archived'),
  ('d0000000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','C1','Untouchable','active');

-- ------------------------------------------------------------------ anon ----
-- The state table records which of a tenant's customers are switched off, which
-- is a fact about their business. Asserted on the privilege rather than on an
-- error code, since our own guards also raise 42501 (CLAUDE.md §7).
select ok(not has_table_privilege('anon', 'public.import_activation_state', 'SELECT'),
          'anon holds no SELECT privilege on import_activation_state');
-- Service-role only, not merely anon-proof: releasing the hold turns a whole
-- tenant's customer base live and no screen gates it, so an ordinary signed-in
-- member must not hold the RPC either.
select ok(not has_function_privilege('anon', 'public.deactivate_tenant_records(uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.deactivate_tenant_records(uuid)', 'EXECUTE'),
          'neither anon nor a signed-in member can execute deactivate_tenant_records');
select ok(not has_function_privilege('anon', 'public.reactivate_tenant_records(uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.reactivate_tenant_records(uuid)', 'EXECUTE'),
          'neither anon nor a signed-in member can execute reactivate_tenant_records');

-- --------------------------------------------------------------- the hold ----
select is((public.deactivate_tenant_records('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->>'customers')::int,
          4, 'the hold switches off the four customers that were not already inactive');

select is((select count(*)::int from public.customers
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and status <> 'inactive'),
          0, 'every customer in the held tenant is inactive');

select is((select count(*)::int from public.import_activation_state
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          4, 'only the previously-active rows are written down');

-- The one that matters: a row already inactive at import must carry no memory,
-- because a memory of 'inactive' is indistinguishable from one this hold made.
select is((select count(*)::int from public.import_activation_state
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
              and previous_status = 'inactive'),
          0, 'no row records inactive as the status to restore');

select is((select status from public.customers
            where id = 'd0000000-0000-4000-8000-000000000001'),
          'active', 'the other tenant is untouched by the hold');

-- A hold applied twice must not overwrite the first one's memory with the value
-- the first one wrote — the failure that would quietly make the hold permanent.
select is((public.deactivate_tenant_records('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->>'customers')::int,
          0, 'a second hold is a no-op');
select is((select count(*)::int from public.import_activation_state
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
              and previous_status = 'inactive'),
          0, 'a second hold does not overwrite what the first recorded');

-- ------------------------------------------------------------ RLS scoping ----
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

select is((select count(*)::int from public.import_activation_state),
          0, 'a member of another tenant sees none of the held rows');

select throws_ok(
  $$insert into public.import_activation_state
      (tenant_id, source_table, row_id, previous_status)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customers',
            'c0000000-0000-4000-8000-000000000001','active')$$,
  '42501', null,
  'with check blocks writing a state row into another tenant');

reset role;

-- ------------------------------------------------------------ the release ----
-- Someone sets a customer active by hand while the hold is on. That is a later
-- decision than the hold and the release must not walk it back.
update public.customers set status = 'active'
 where id = 'c0000000-0000-4000-8000-000000000002';

select public.reactivate_tenant_records('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

select is((select string_agg(status, ',' order by customer_number) from public.customers
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          'active,active,inactive,on_hold,archived',
          'the release restores the import exactly as it arrived');

select is((select status from public.customers
            where id = 'c0000000-0000-4000-8000-000000000003'),
          'inactive', 'a customer retired before the import stays retired');

select is((select count(*)::int from public.import_activation_state
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          0, 'the release clears the hold rather than leaving it half-applied');

select * from finish();
rollback;
