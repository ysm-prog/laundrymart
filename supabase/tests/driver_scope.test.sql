-- Proof: a driver sees their own run and nothing else, while office roles see
-- the whole depot. Resource-scoped authz, not just tenant-scoped.
begin;
select plan(6);

insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-000000000001','driver1@example.com'),
  ('d0000000-0000-0000-0000-000000000002','driver2@example.com'),
  ('d0000000-0000-0000-0000-00000000000d','dispatcher@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A');
insert into public.memberships (user_id, tenant_id, role) values
  ('d0000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('d0000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('d0000000-0000-0000-0000-00000000000d','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dispatcher');

insert into public.drivers (id, tenant_id, user_id, full_name) values
  ('dd000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-000000000001','Driver One'),
  ('dd000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-000000000002','Driver Two');
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Cafe A');
insert into public.daily_routes (id, tenant_id, route_date, code, name, driver_id) values
  ('50000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-03-02','R1','North','dd000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-03-02','R2','South','dd000000-0000-0000-0000-000000000002');
insert into public.jobs (id, tenant_id, route_id, customer_id, driver_id, job_number, scheduled_date) values
  ('10000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','50000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-00000000000a','dd000000-0000-0000-0000-000000000001','JOB00001','2026-03-02'),
  ('10000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','50000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-00000000000a','dd000000-0000-0000-0000-000000000002','JOB00002','2026-03-02');
insert into public.pickups (id, tenant_id, job_id, customer_id, driver_id, pickup_date) values
  ('70000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','10000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-00000000000a','dd000000-0000-0000-0000-000000000001','2026-03-02'),
  ('70000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','10000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-00000000000a','dd000000-0000-0000-0000-000000000002','2026-03-02');

set local role authenticated;
set local "request.jwt.claim.sub" = 'd0000000-0000-0000-0000-000000000001';

select is((select count(*) from public.daily_routes)::int, 1, 'driver sees only their own daily route');
select is((select count(*) from public.jobs)::int, 1, 'driver sees only their own jobs');
select is((select count(*) from public.pickups)::int, 1,
          'driver sees only pickups belonging to their own jobs');
-- RLS filters the row out of the UPDATE rather than raising: prove zero rows
-- were touched, which is the outcome that actually matters.
with u as (
  update public.jobs set status = 'completed'
   where id = '10000000-0000-0000-0000-000000000002' returning 1
)
select is((select count(*)::int from u), 0,
          'driver cannot modify another driver''s job');

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = 'd0000000-0000-0000-0000-00000000000d';

select is((select count(*) from public.daily_routes)::int, 2, 'dispatcher sees every route');
select is((select count(*) from public.jobs)::int, 2, 'dispatcher sees every job');

select * from finish();
rollback;
