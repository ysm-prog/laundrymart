-- Proof: tenant A can never see or touch tenant B's operational data.
begin;
select plan(10);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@example.com'),
  ('22222222-2222-2222-2222-222222222222','b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Cafe A'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Hotel B');
insert into public.items (id, tenant_id, sku, name) values
  ('11100000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','BT-A','Bath Towel'),
  ('11100000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','BT-B','Bath Towel');
insert into public.jobs (tenant_id, customer_id, job_number, scheduled_date) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a','JOB00001','2026-03-02'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','c0000000-0000-0000-0000-00000000000b','JOB00001','2026-03-02');
insert into public.invoices (tenant_id, customer_id, invoice_number) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a','INV00001'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','c0000000-0000-0000-0000-00000000000b','INV00001');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is((select count(*) from public.customers)::int, 1, 'A sees only its customers');
select is((select count(*) from public.customers
            where tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')::int, 0,
          'A cannot read B customers');
select is((select count(*) from public.items)::int, 1, 'A sees only its items');
select is((select count(*) from public.jobs)::int, 1, 'A sees only its jobs');
select is((select count(*) from public.invoices)::int, 1, 'A sees only its invoices');
select is((select count(*) from public.tenants)::int, 1, 'A sees only its own tenant row');

select throws_ok(
  $$ insert into public.customers (tenant_id, customer_number, business_name)
     values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST09999','Injected') $$,
  '42501', null, 'with check blocks cross-tenant customer insert');

select throws_ok(
  $$ update public.customers set tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
     where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $$,
  '42501', null, 'with check blocks re-tenanting a customer');

select throws_ok(
  $$ insert into public.jobs (tenant_id, customer_id, job_number, scheduled_date)
     values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','c0000000-0000-0000-0000-00000000000b','JOB09999','2026-03-02') $$,
  '42501', null, 'with check blocks cross-tenant job insert');

select throws_ok(
  $$ insert into public.invoices (tenant_id, customer_id, invoice_number)
     values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','c0000000-0000-0000-0000-00000000000b','INV09999') $$,
  '42501', null, 'with check blocks cross-tenant invoice insert');

select * from finish();
rollback;
