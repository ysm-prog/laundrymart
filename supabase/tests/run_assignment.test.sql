-- Proof: Job → Driver → Delivery Date is a relationship the database polices,
-- and a driver reaches exactly the laundry assigned to them.
--
-- Three things are being defended.
--
-- The first is **eligibility**. The assign dialog checks the same rules and
-- explains itself in a sentence, but the dialog is not the boundary: anything
-- holding a session and the anon key can `PATCH /rest/v1/laundry_orders` with an
-- `assigned_driver_id` of its choosing. So "a customer pickup is never assigned
-- for delivery", "a job that has not left the plant is not ready", "a finished
-- job cannot be assigned" and "a stop is a visit to one customer" are asserted
-- here, against the trigger.
--
-- The second is **coherence between the two records of the assignment**. Since
-- 0016 the user-facing answer lives on the job (`assigned_driver_id`,
-- `assigned_delivery_date`) while the operational placement stays on the run
-- (`stop_id` → `jobs.route_id` → `daily_routes`). Carrying both is only safe if
-- they cannot disagree, so the guard is proven to refuse every way they could:
-- a stop on another driver's run, a stop on another day, and — the worst of them
-- — a job on a crewed run naming no driver at all, which would be on somebody's
-- route sheet and on nobody's My Runs.
--
-- The third is **scope**. 0016 narrows the read policy on the three laundry
-- tables so a driver-only member sees a job when it is assigned to them or sits
-- on a stop of their run. That is the difference between a driver's phone
-- showing their twelve deliveries and it being able to enumerate every
-- customer's laundry in the business, so it is proven from both sides.
begin;
select plan(30);

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
-- A driver belonging to the other tenant, so "that driver could not be found"
-- is proven against a real row rather than a made-up uuid.
insert into public.drivers (id, tenant_id, full_name) values
  ('dd000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Their Driver');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Fitness'),
  ('c0000000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00002','XYZ Physio'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Southern Cafe');

-- Two runs on the same Adelaide day, one per driver, plus one for driver one on
-- the following day. Nothing here assumes one run per driver per day, and the
-- second date is what proves the date-agreement rule.
insert into public.daily_routes (id, tenant_id, route_date, code, name, driver_id) values
  ('50000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '2026-08-14','R1','Deliveries','dd000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '2026-08-14','R2','Deliveries','dd000000-0000-0000-0000-000000000002'),
  ('50000000-0000-0000-0000-000000000003','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '2026-08-15','R3','Deliveries','dd000000-0000-0000-0000-000000000001');
-- A run with no driver on it, for the crewless-stop case.
insert into public.daily_routes (id, tenant_id, route_date, code, name) values
  ('50000000-0000-0000-0000-000000000004','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '2026-08-14','R4','Unstaffed'),
  ('50000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '2026-08-14','R1','Theirs');

-- Stop 1 on driver one's run is a visit to ABC Fitness; stop 2 on driver two's
-- run is the same customer on the other van; stop 3 is a different customer;
-- stop 4 is ABC Fitness on driver one's *next day*; stop 5 is on the crewless run.
insert into public.jobs (id, tenant_id, route_id, customer_id, driver_id, job_number, scheduled_date, sequence, service_type) values
  ('10000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-00000000000a',
   'dd000000-0000-0000-0000-000000000001','JOB00001','2026-08-14',1,'delivery'),
  ('10000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-00000000000a',
   'dd000000-0000-0000-0000-000000000002','JOB00002','2026-08-14',1,'delivery'),
  ('10000000-0000-0000-0000-000000000003','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-00000000000c',
   'dd000000-0000-0000-0000-000000000001','JOB00003','2026-08-14',2,'delivery'),
  ('10000000-0000-0000-0000-000000000004','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-00000000000a',
   'dd000000-0000-0000-0000-000000000001','JOB00004','2026-08-15',1,'delivery');
insert into public.jobs (id, tenant_id, route_id, customer_id, job_number, scheduled_date, sequence, service_type) values
  ('10000000-0000-0000-0000-000000000005','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-000000000004','c0000000-0000-0000-0000-00000000000a','JOB00005','2026-08-14',1,'delivery'),
  ('10000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '50000000-0000-0000-0000-0000000000bb','c0000000-0000-0000-0000-00000000000b','JOB00001','2026-08-14',1,'delivery');

-- The counter jobs. a1/a4/a5 are eligible, a2 has not left the plant, a3 is a
-- customer pickup.
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

/* The whole user-facing assignment, as one statement — driver, date, status and
   the internal placement together. Every test below drives the guard through
   this shape, because it is the shape the server action writes. */
create function pg_temp.assign(
  p_order uuid, p_driver uuid, p_date date, p_stop uuid
) returns void language sql as $$
  update public.laundry_orders
     set assigned_driver_id = p_driver,
         assigned_delivery_date = p_date,
         stop_id = p_stop,
         status = 'assigned'
   where id = p_order;
$$;

-- ------------------------------------------------------------ eligibility ---
select throws_ok(
  $$select pg_temp.assign('d0000000-0000-0000-0000-0000000000a3',
      'dd000000-0000-0000-0000-000000000001','2026-08-14',
      '10000000-0000-0000-0000-000000000001')$$,
  'P0001',
  -- The assignment guard fires before the transition guard (trigger order is
  -- alphabetical), so this is its wording rather than the workflow's. Both
  -- refuse it; asserting the message proves which rule actually caught it.
  'this job is a customer pickup, so it is not eligible for delivery assignment',
  'a customer pickup cannot be assigned for delivery');

select throws_ok(
  $$select pg_temp.assign('d0000000-0000-0000-0000-0000000000a2',
      'dd000000-0000-0000-0000-000000000001','2026-08-14',
      '10000000-0000-0000-0000-000000000001')$$,
  'P0001',
  'a job cannot go from new to assigned',
  'a job that has not left the plant cannot be assigned');

select throws_ok(
  $$select pg_temp.assign('d0000000-0000-0000-0000-0000000000a1',
      'dd000000-0000-0000-0000-000000000001','2026-08-14',
      '10000000-0000-0000-0000-000000000003')$$,
  'P0001',
  'that stop is a visit to a different customer',
  'a job cannot be filed under a visit to another business');

select throws_ok(
  $$select pg_temp.assign('d0000000-0000-0000-0000-0000000000a1',
      'dd000000-0000-0000-0000-0000000000bb','2026-08-14',
      '10000000-0000-0000-0000-000000000001')$$,
  'P0001',
  'that driver could not be found',
  'a job cannot be assigned to another tenant''s driver');

-- The cross-tenant stop check has two outcomes and both are correct. This block
-- runs as the owner, so RLS is bypassed, the other tenant's stop is found and
-- the explicit tenant comparison refuses it. Through PostgREST — where every
-- caller is `authenticated` — RLS hides the row first and the same attempt comes
-- back as "that stop could not be found". Either way it does not happen; the
-- explicit comparison exists so the guard does not *depend* on RLS.
select throws_ok(
  $$select pg_temp.assign('d0000000-0000-0000-0000-0000000000a1',
      'dd000000-0000-0000-0000-000000000001','2026-08-14',
      '10000000-0000-0000-0000-0000000000bb')$$,
  'P0001',
  'that stop belongs to another tenant',
  'a stop in another tenant is refused even with RLS out of the way');

-- ------------------------------------------- the two records must agree -----
select throws_ok(
  $$select pg_temp.assign('d0000000-0000-0000-0000-0000000000a1',
      'dd000000-0000-0000-0000-000000000001','2026-08-14',
      '10000000-0000-0000-0000-000000000002')$$,
  'P0001',
  'that stop is on another driver''s run',
  'the job and the run it sits on must name the same driver');

select throws_ok(
  $$select pg_temp.assign('d0000000-0000-0000-0000-0000000000a1',
      'dd000000-0000-0000-0000-000000000001','2026-08-14',
      '10000000-0000-0000-0000-000000000004')$$,
  'P0001',
  'that stop is on a run for a different day',
  'the job and the run it sits on must name the same day');

-- The worst of the disagreements: on a crewed route sheet and on nobody's day.
select throws_ok(
  $$update public.laundry_orders set stop_id = '10000000-0000-0000-0000-000000000001'
     where id = 'd0000000-0000-0000-0000-0000000000a1'$$,
  'P0001',
  'a job on a driver''s run must name that driver and delivery date',
  'a job cannot sit on a crewed run while naming no driver');

-- ---------------------------------------------------------- the integrity ---
select throws_ok(
  $$update public.laundry_orders set status = 'assigned'
     where id = 'd0000000-0000-0000-0000-0000000000a1'$$,
  '23514', null,
  'a job cannot be Assigned without a driver and a delivery date');

select throws_ok(
  $$update public.laundry_orders set assigned_driver_id = 'dd000000-0000-0000-0000-000000000001'
     where id = 'd0000000-0000-0000-0000-0000000000a1'$$,
  '23514', null,
  'a driver without a date is half an assignment and is refused');

-- ------------------------------------------------------------ happy path ----
select lives_ok(
  $$select pg_temp.assign('d0000000-0000-0000-0000-0000000000a1',
      'dd000000-0000-0000-0000-000000000001','2026-08-14',
      '10000000-0000-0000-0000-000000000001')$$,
  'a ready delivery job takes a driver, a date and a place on their run');

select is((select status from public.laundry_orders where id = 'd0000000-0000-0000-0000-0000000000a1'),
          'assigned', 'assignment moves the job to Assigned');
select isnt((select assigned_at from public.laundry_orders where id = 'd0000000-0000-0000-0000-0000000000a1'),
            null, 'the trigger stamps assigned_at even when the client forgets');

-- Reassignment to the other driver, moving the stop with it.
select lives_ok(
  $$select pg_temp.assign('d0000000-0000-0000-0000-0000000000a1',
      'dd000000-0000-0000-0000-000000000002','2026-08-14',
      '10000000-0000-0000-0000-000000000002')$$,
  'a job can be reassigned to another driver');
select is((select assigned_driver_id from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-0000000000a1'),
          'dd000000-0000-0000-0000-000000000002'::uuid,
          'reassignment updates one row rather than creating a second job');
select is((select count(*)::int from public.laundry_orders), 5,
          'reassignment never duplicates the job');

-- Remove Assignment: back to the ready queue, and the trigger clears every trace
-- of the assignment so no half-state can survive a careless caller.
update public.laundry_orders set status = 'ready_for_delivery'
 where id = 'd0000000-0000-0000-0000-0000000000a1';
select is((select assigned_driver_id from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-0000000000a1'), null::uuid,
          'removing an assignment clears the driver');
select is((select assigned_delivery_date from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-0000000000a1'), null::date,
          'removing an assignment clears the delivery date');
select is((select stop_id from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-0000000000a1'), null::uuid,
          'removing an assignment takes the job off the run too');

-- Put the day back together for the workflow and scope assertions below.
select pg_temp.assign('d0000000-0000-0000-0000-0000000000a1',
  'dd000000-0000-0000-0000-000000000001','2026-08-14','10000000-0000-0000-0000-000000000001');
select pg_temp.assign('d0000000-0000-0000-0000-0000000000a4',
  'dd000000-0000-0000-0000-000000000001','2026-08-14','10000000-0000-0000-0000-000000000001');
select pg_temp.assign('d0000000-0000-0000-0000-0000000000a5',
  'dd000000-0000-0000-0000-000000000002','2026-08-14','10000000-0000-0000-0000-000000000002');

-- Two jobs, one stop: several jobs for one business gather under one visit,
-- with no join table and no duplicate call.
select is((select count(*)::int from public.laundry_orders
            where stop_id = '10000000-0000-0000-0000-000000000001'),
          2, 'several jobs can hang off one stop');

-- ---------------------------------------------------------- the workflow ----
-- The delivery walks on to completion, and the assignment guard must not
-- re-fire while it does — a job being completed keeps its driver and its stop.
update public.laundry_orders set status = 'out_for_delivery'
 where id = 'd0000000-0000-0000-0000-0000000000a1';
update public.laundry_orders set status = 'completed'
 where id = 'd0000000-0000-0000-0000-0000000000a1';
select is((select assigned_driver_id from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-0000000000a1'),
          'dd000000-0000-0000-0000-000000000001'::uuid,
          'completing a job keeps the record of who delivered it');
select isnt((select completed_at from public.laundry_orders where id = 'd0000000-0000-0000-0000-0000000000a1'),
            null, 'the trigger still stamps the completion time');

-- ...but a finished job cannot be newly assigned.
select throws_ok(
  $$select pg_temp.assign('d0000000-0000-0000-0000-0000000000a1',
      'dd000000-0000-0000-0000-000000000002','2026-08-14',
      '10000000-0000-0000-0000-000000000002')$$,
  'P0001',
  'a job cannot go from completed to assigned',
  'a finished job cannot be handed to another driver');

-- Deleting the stop returns the job to the queue rather than deleting the
-- customer's laundry with it.
delete from public.jobs where id = '10000000-0000-0000-0000-000000000003';
select is((select count(*)::int from public.laundry_orders), 5,
          'removing a stop never removes a job');

-- ---------------------------------------------------------------- scope -----
set local role authenticated;
set local "request.jwt.claim.sub" = 'd0000000-0000-0000-0000-000000000001';

select is((select count(*)::int from public.laundry_orders), 2,
          'a driver sees only the laundry assigned to them');
select is((select count(*)::int from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-0000000000a5'), 0,
          'a driver cannot see laundry assigned to another driver');
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
