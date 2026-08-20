-- Proof for 0019: a platform admin crosses every laundry, and widening
-- `is_member`/`has_role` to let them did not widen anything for anybody else.
--
-- The second half is the point. 0019 edits the two functions every policy in
-- the schema funnels through, so the risk it carries is not "does the new role
-- work" but "did the tenancy boundary survive". The existing eleven proofs
-- cover the no-platform-admin case; these assertions cover the case where one
-- exists and an ordinary member is signed in beside them.
begin;
select plan(23);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@example.com'),
  ('22222222-2222-2222-2222-222222222222','b@example.com'),
  ('99999999-9999-9999-9999-999999999999','platform@example.com'),
  ('88888888-8888-8888-8888-888888888888','platform2@example.com'),
  ('77777777-7777-7777-7777-777777777777','nobody@example.com');

insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');

insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Cafe A'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Hotel B');
insert into public.invoices (tenant_id, customer_id, invoice_number) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a','INV00001'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','c0000000-0000-0000-0000-00000000000b','INV00001');

-- `platform_admins` carries no tenant_id, which is the one table in the schema
-- that is true of. Assert the shape rather than trusting the DDL read right.
select hasnt_column('public','platform_admins','tenant_id',
  'platform_admins is deliberately not tenant-scoped');
select has_table('public','platform_settings','deployment settings table exists');

-- ------------------------------------------------------------------ the role
insert into public.platform_admins (user_id, note) values
  ('99999999-9999-9999-9999-999999999999','the platform admin');

set local role authenticated;
set local "request.jwt.claim.sub" = '99999999-9999-9999-9999-999999999999';

select ok(public.is_platform_admin(), 'a listed user is a platform admin');
select is((select count(*) from public.tenants)::int, 2,
          'platform admin sees every laundry');
select is((select count(*) from public.customers)::int, 2,
          'platform admin reads customers across laundries');
select is((select count(*) from public.invoices)::int, 2,
          'platform admin reads invoices across laundries — has_role widened too');
select ok(public.is_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          'is_member true for a laundry they hold no membership in');
select ok(public.has_role('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', array['finance']),
          'has_role true for a role they do not hold');
select ok(not public.is_driver_only('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          'a platform admin is never narrowed to one driver''s own run');

-- Creating a laundry is the thing no membership role can do (0001 shipped a
-- select policy on `tenants` and nothing else).
select lives_ok(
  $$ insert into public.tenants (id, name)
     values ('cccccccc-cccc-cccc-cccc-cccccccccccc','Laundry C') $$,
  'platform admin can create a laundry');

select lives_ok(
  $$ update public.platform_settings set settings = '{"default_gst_rate":0.1}'::jsonb
      where id $$,
  'platform admin can write deployment settings');

-- ------------------------------------------------- the boundary still holds
-- The assertions that matter most: an ordinary member, with a platform admin
-- now existing on the deployment, still sees exactly what they did before.
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select ok(not public.is_platform_admin(), 'an ordinary member is not a platform admin');
select is((select count(*) from public.customers)::int, 1,
          'member A still sees only its own customers');
select is((select count(*) from public.invoices)::int, 1,
          'member A still sees only its own invoices');
select is((select count(*) from public.tenants)::int, 1,
          'member A still sees only its own laundry');
select ok(not public.is_member('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
          'is_member still false across laundries for a member');
select is((select count(*) from public.platform_admins)::int, 0,
          'a member cannot even see that platform admins exist');

select throws_ok(
  $$ insert into public.platform_admins (user_id)
     values ('11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'a member cannot make themselves a platform admin');

select throws_ok(
  $$ insert into public.tenants (name) values ('Sneaky') $$,
  '42501', null, 'a member cannot create a laundry');

-- A super_admin is still refused the platform capability's table, which is the
-- app-side claim ("platform.* is held by platform_admin alone") checked against
-- the database rather than against roles.ts.
select is((select count(*) from public.platform_settings)::int, 0,
          'a super_admin cannot read deployment settings');

-- --------------------------------------------------- do not strand the app
set local "request.jwt.claim.sub" = '99999999-9999-9999-9999-999999999999';

select throws_ok(
  $$ delete from public.platform_admins
      where user_id = '99999999-9999-9999-9999-999999999999' $$,
  'P0001', 'Cannot remove the last platform administrator',
  'the last platform admin cannot be removed');

insert into public.platform_admins (user_id) values
  ('88888888-8888-8888-8888-888888888888');

select lives_ok(
  $$ delete from public.platform_admins
      where user_id = '99999999-9999-9999-9999-999999999999' $$,
  'with a second one present, the first can be removed');

-- ------------------------------------------------------------------ no login
-- Signed in, but on neither list: the ordinary "no membership" case must not
-- have been turned into access by the widened helpers.
set local "request.jwt.claim.sub" = '77777777-7777-7777-7777-777777777777';

select is((select count(*) from public.customers)::int, 0,
          'a user with no membership and no platform row sees nothing');

select finish();
rollback;
