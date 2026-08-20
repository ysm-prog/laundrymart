-- Proof: archiving hides a tenant's business records from its own members, is
-- reversible without loss, leaves configuration and other tenants alone, and
-- cannot be driven by anyone who is not an administrator of that tenant.
begin;
select plan(25);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner-a@example.com'),
  ('33333333-3333-3333-3333-333333333333','clerk-a@example.com'),
  ('22222222-2222-2222-2222-222222222222','owner-b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  -- Holds orders.* and customers.* but no admin role: the app lets them work
  -- with the records, and must not let them hide everyone's.
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customer_service'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Cafe A'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Hotel B');
insert into public.items (id, tenant_id, sku, name) values
  ('11100000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','BT-A','Bath Towel');
insert into public.jobs (tenant_id, customer_id, job_number, scheduled_date) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a','JOB00001','2026-03-02');
insert into public.invoices (tenant_id, customer_id, invoice_number) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a','INV00001'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','c0000000-0000-0000-0000-00000000000b','INV00001');
insert into public.laundry_orders (id, tenant_id, customer_id, order_number) values
  ('40000000-0000-4000-8000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00001');
insert into public.laundry_order_items (tenant_id, order_id, item_type, exact_quantity) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','40000000-0000-4000-8000-00000000000a','towels', 3);

-- ----------------------------------------------------------- before, as A ---
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is((select count(*) from public.customers)::int, 1, 'A sees its customer before archiving');
select is((select count(*) from public.invoices)::int, 1, 'A sees its invoice before archiving');
select is((select count(*) from public.laundry_orders)::int, 1, 'A sees its job before archiving');

-- A member cannot hide a row by hand: the archive clause is in `with check`
-- too, so the stamp is only ever written by the definer-rights function.
select throws_ok(
  $$ update public.customers set archived_at = now()
      where id = 'c0000000-0000-0000-0000-00000000000a' $$,
  '42501', null, 'a member cannot archive a customer by hand');

-- --------------------------------------------------- who may drive it -----
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
select throws_ok(
  $$ select public.set_records_archived('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true) $$,
  '42501', null, 'a non-administrator member cannot archive');

set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select throws_ok(
  $$ select public.set_records_archived('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true) $$,
  '42501', null, 'another tenant''s owner cannot archive A');
select throws_ok(
  $$ select public.archived_record_counts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', null, 'a non-member cannot count A''s archived records');

-- ------------------------------------------------------------- archive -----
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select ok((select public.set_records_archived('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true)) >= 5,
          'archiving reports the rows it moved');

select is((select count(*) from public.customers)::int, 0, 'the customer is hidden');
select is((select count(*) from public.invoices)::int, 0, 'the invoice is hidden');
select is((select count(*) from public.laundry_orders)::int, 0, 'the job is hidden');
select is((select count(*) from public.laundry_order_items)::int, 0, 'the job''s laundry is hidden');
select is((select count(*) from public.jobs)::int, 0, 'the stop is hidden');

-- Reference and configuration data is not business records and must survive,
-- or an archived tenant comes back to an app that has forgotten its own setup.
select is((select count(*) from public.items)::int, 1, 'items survive an archive');
select is((select count(*) from public.tenants)::int, 1, 'the tenant itself survives');
-- Both of A's people, still there: an archive must never cost anyone access,
-- least of all the administrator who has to be able to undo it.
select is((select count(*) from public.memberships)::int, 2, 'A''s people keep their access');

-- The rows are hidden, not gone: the counter can still see how much is waiting.
select is((select archived from public.archived_record_counts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
            where table_name = 'customers')::int, 1, 'the count still finds the archived customer');
select is((select live from public.archived_record_counts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
            where table_name = 'customers')::int, 0, 'and reports nothing live');

-- An archived customer must not block ordinary work: a new one still saves, and
-- comes in visible rather than inheriting the archive.
select lives_ok(
  $$ insert into public.customers (tenant_id, customer_number, business_name)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00002','Fresh Start') $$,
  'a new customer can still be created while records are archived');
select is((select count(*) from public.customers)::int, 1, 'and the new customer is visible');

-- ------------------------------------------------------ another tenant -----
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is((select count(*) from public.customers)::int, 1, 'B''s customer is untouched');
select is((select count(*) from public.invoices)::int, 1, 'B''s invoice is untouched');

-- ------------------------------------------------------------- restore -----
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select ok((select public.set_records_archived('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false)) >= 5,
          'restoring reports the rows it brought back');
select is((select count(*) from public.customers)::int, 2,
          'the archived customer is back, beside the one added meanwhile');
select is((select count(*) from public.laundry_order_items)::int, 1,
          'the job''s laundry came back with it');

select * from finish();
rollback;
