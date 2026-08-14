-- Proof: putting a counter Job on a driver's Run is a relationship the database
-- polices, and a driver reaches exactly the laundry on their own stops.
--
-- Two things are being defended.
--
-- The first is **eligibility**. The assignment dialog checks the same rules and
-- explains itself in a sentence, but the dialog is not the boundary: anything
-- holding a session and the anon key can `PATCH /rest/v1/laundry_orders` with a
-- `stop_id` of its choosing. So "a customer pickup never goes on a delivery
-- run", "a job that has not left the plant is not ready", "a finished job is not
-- dispatchable" and "a stop is a visit to one customer" are asserted here,
-- against the trigger.
--
-- The second is **scope**. 0015 narrows the read policy on the three laundry
-- tables so that a driver-only member sees a job only while it sits on a stop of
-- a run that is theirs. That is the difference between a driver's phone showing
-- their twelve deliveries and it being able to enumerate every customer's
-- laundry in the business, so it is proven from both sides: their own job is
-- visible, another driver's is not, and an unassigned one is not.
begin;
select plan(19);

insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-000000000001','driver1@example.com'),
  ('d0000000-0000-0000-0000-000000000002','driver2@example.com'),
  ('d0000000-0000-0000-0000-00000000000d','dispatcher@example.com'),
  ('e0000000-0000-0000-0000-00000000000b','other-tenant@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('d0000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('d0000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('d0000000-0000-0000-0000-00000000000d','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dispatcher'),
  ('e0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.drivers (id, tenant_id, user_id, full_name) values
  ('dd000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'd0000000-0000-0000-0000-000000000001','Driver One'),
  ('dd000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'd0000000-0000-0000-0000-000000000002','Driver Two');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Fitness'),
  ('c0000000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00002','XYZ Physio'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Southern Cafe');

-- Two runs on the same Adelaide day, one per driver. Note the pair exists at all
-- because nothing here assumes one run per driver per day.
insert into public.daily_routes (id, tenant_id, route_date, code, name, driver_id) values
  ('50000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '2026-08-14','R1','Morning','dd000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '2026-08-14','R2','Afternoon','dd000000-0000-0000-0000-000000000002');
insert into public.daily_routes (id, tenant_id, route_date, code, name) values
  ('50000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '2026-08-14','R1','Theirs');

-- Stop 1 on driver one's run is a visit to ABC Fitness; stop 2 on driver two's
-- run is the same customer on the other van; stop 3 is a different customer.
insert into public.jobs (id, tenant_id, route_id, customer_id, driver_id, job_number, scheduled_date, sequence, service_type) values
  ('10000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-00000000000a',
   'dd000000-0000-0000-0000-000000000001','JOB00001','2026-08-14',1,'delivery'),
  ('10000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-00000000000a',
   'dd000000-0000-0000-0000-000000000002','JOB00002','2026-08-14',1,'delivery'),
  ('10000000-0000-0000-0000-000000000003','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-00000000000c',
   'dd000000-0000-0000-0000-000000000001','JOB00003','2026-08-14',2,'delivery');
insert into public.jobs (id, tenant_id, route_id, customer_id, job_number, scheduled_date) values
  ('10000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '50000000-0000-0000-0000-0000000000bb','c0000000-0000-0000-0000-00000000000b','JOB00001','2026-08-14');

-- The counter jobs. `ready` is the eligible one, `fresh` has not left the plant,
-- `collect` is a customer pickup, `done` is finished.
insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, status, delivery_required, expected_delivery_date) values
  ('d0000000-0000-0000-0000-0000000000a1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00001','ready_for_delivery', true, '2026-08-14'),
  ('d0000000-0000-0000-0000-0000000000a2','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00002','new', true, '2026-08-14'),
  ('d0000000-0000-0000-0000-0000000000a4','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00004','ready_for_delivery', true, '2026-08-14'),
  ('d0000000-0000-0000-0000-0000000000a5','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00005','ready_for_delivery', true, '2026-08-14');
insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, status, delivery_required, expected_collection_date) values
  ('d0000000-0000-0000-0000-0000000000a3','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00003','ready_for_delivery', false, '2026-08-14');

insert into public.laundry_order_items (tenant_id, order_id, item_type, quantity_type, exact_quantity) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-0000000000a1','towels','exact',250),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-0000000000a4','bath_mats','exact',80);

-- ------------------------------------------------------------ eligibility ---
select throws_ok(
  $$update public.laundry_orders set stop_id = '10000000-0000-0000-0000-000000000001'
     where id = 'd0000000-0000-0000-0000-0000000000a3'$$,
  'P0001',
  'this job is a customer pickup, so it is not eligible for a delivery run',
  'a customer pickup cannot be put on a delivery run');

select throws_ok(
  $$update public.laundry_orders set stop_id = '10000000-0000-0000-0000-000000000001'
     where id = 'd0000000-0000-0000-0000-0000000000a2'$$,
  'P0001',
  'this job is not ready for delivery yet',
  'a job that has not left the plant cannot be assigned');

select throws_ok(
  $$update public.laundry_orders set stop_id = '10000000-0000-0000-0000-000000000003'
     where id = 'd0000000-0000-0000-0000-0000000000a1'$$,
  'P0001',
  'that stop is a visit to a different customer',
  'a job cannot be filed under a visit to another business');

-- The cross-tenant check has two outcomes and both are correct. This block runs
-- as the owner, so RLS is bypassed, the other tenant's stop is found and the
-- explicit tenant comparison is what refuses it. Through PostgREST — where every
-- caller is `authenticated` — RLS hides the row first and the same attempt comes
-- back as "that stop could not be found". Either way it does not happen; the
-- explicit comparison exists so that the guard does not *depend* on RLS.
select throws_ok(
  $$update public.laundry_orders set stop_id = '10000000-0000-0000-0000-0000000000bb'
     where id = 'd0000000-0000-0000-0000-0000000000a1'$$,
  'P0001',
  'that stop belongs to another tenant',
  'a stop in another tenant is refused even with RLS out of the way');

-- The happy path, and the one that matters: assignment does not touch status.
update public.laundry_orders set stop_id = '10000000-0000-0000-0000-000000000001'
 where id = 'd0000000-0000-0000-0000-0000000000a1';
select is((select stop_id from public.laundry_orders where id = 'd0000000-0000-0000-0000-0000000000a1'),
          '10000000-0000-0000-0000-000000000001'::uuid,
          'an eligible ready-for-delivery job can be put on a run');
select is((select status from public.laundry_orders where id = 'd0000000-0000-0000-0000-0000000000a1'),
          'ready_for_delivery',
          'assignment is a relationship, not a status change');

-- Reassignment to the other driver's stop for the same customer.
update public.laundry_orders set stop_id = '10000000-0000-0000-0000-000000000002'
 where id = 'd0000000-0000-0000-0000-0000000000a1';
select is((select stop_id from public.laundry_orders where id = 'd0000000-0000-0000-0000-0000000000a1'),
          '10000000-0000-0000-0000-000000000002'::uuid,
          'a job can be reassigned to another driver''s stop');

-- Removal is always allowed — it is the undo, and refusing it would strand work.
update public.laundry_orders set stop_id = null
 where id = 'd0000000-0000-0000-0000-0000000000a1';
select is((select stop_id from public.laundry_orders where id = 'd0000000-0000-0000-0000-0000000000a1'),
          null::uuid, 'removing a job from a run is always allowed');

-- Put it back for the workflow and scope assertions below.
update public.laundry_orders set stop_id = '10000000-0000-0000-0000-000000000001'
 where id in ('d0000000-0000-0000-0000-0000000000a1','d0000000-0000-0000-0000-0000000000a4');
update public.laundry_orders set stop_id = '10000000-0000-0000-0000-000000000002'
 where id = 'd0000000-0000-0000-0000-0000000000a5';

-- Two jobs, one stop: the grouping §16 asks for is a plain foreign key, with no
-- join table and no duplicate stop.
select is((select count(*)::int from public.laundry_orders
            where stop_id = '10000000-0000-0000-0000-000000000001'),
          2, 'several jobs can hang off one stop');

-- ---------------------------------------------------------- the workflow ----
-- The delivery still walks the six statuses of 0014, and the assignment guard
-- must not re-fire while it does — a job being completed keeps its stop.
update public.laundry_orders set status = 'out_for_delivery'
 where id = 'd0000000-0000-0000-0000-0000000000a1';
update public.laundry_orders set status = 'completed'
 where id = 'd0000000-0000-0000-0000-0000000000a1';
select is((select stop_id from public.laundry_orders where id = 'd0000000-0000-0000-0000-0000000000a1'),
          '10000000-0000-0000-0000-000000000001'::uuid,
          'completing an assigned job keeps it on its run');
select isnt((select completed_at from public.laundry_orders where id = 'd0000000-0000-0000-0000-0000000000a1'),
            null, 'the 0014 trigger still stamps the completion time');

-- ...but a finished job cannot be *newly* dispatched.
select throws_ok(
  $$update public.laundry_orders set stop_id = '10000000-0000-0000-0000-000000000002'
     where id = 'd0000000-0000-0000-0000-0000000000a1'$$,
  'P0001',
  'a completed job cannot be put on a run',
  'a finished job cannot be moved onto another run');

-- Deleting the stop returns the job to the unassigned queue rather than
-- deleting the customer's laundry with it.
delete from public.jobs where id = '10000000-0000-0000-0000-000000000003';
select is((select count(*)::int from public.laundry_orders), 5,
          'removing a stop never removes a job');

-- ---------------------------------------------------------------- scope -----
set local role authenticated;
set local "request.jwt.claim.sub" = 'd0000000-0000-0000-0000-000000000001';

select is((select count(*)::int from public.laundry_orders), 2,
          'a driver sees only the laundry on their own stops');
select is((select count(*)::int from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-0000000000a5'), 0,
          'a driver cannot see laundry on another driver''s run');
select is((select count(*)::int from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-0000000000a2'), 0,
          'a driver cannot see an unassigned job');
select is((select count(*)::int from public.laundry_order_items), 2,
          'laundry lists follow their job — a driver reads only their own');

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = 'd0000000-0000-0000-0000-00000000000d';

select is((select count(*)::int from public.laundry_orders), 5,
          'a dispatcher still sees every job in the tenant');

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = 'e0000000-0000-0000-0000-00000000000b';

select is((select count(*)::int from public.laundry_orders), 0,
          'the other tenant sees none of it, driver clause or not');

select * from finish();
rollback;
