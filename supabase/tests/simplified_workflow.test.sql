-- Proof: the simplified workflow (0065) finishes a delivery job off the shelf,
-- and the full workflow still does not.
--
-- Change request 3 (2026-11-23): ATS is not running rounds or deliveries
-- through the app yet, so a new job is completed as it is saved. The app does
-- that in `createOrder`; this file proves the half that lives in the database,
-- which is the boundary — rule 4 of 0042 refused exactly that move.
--
-- Run as a real member (`authenticated` with a `sub`), because the guard is
-- SECURITY INVOKER and reads the tenant's setting through RLS: a proof run as
-- the superuser would pass whatever the tenants policy said.
begin;
select plan(21);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','s@example.com'),
  ('22222222-2222-2222-2222-222222222222','f@example.com');

-- S has never saved the setting (the live laundry's state); F chose full.
insert into public.tenants (id, name, settings) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Simplified by default', '{}'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Full workflow', '{"operations":{"workflow":"full"}}');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customer_service'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','customer_service');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Hotel'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','XYZ Motel');

insert into public.boards (id, tenant_id, code, name, status) values
  ('55555555-5555-5555-5555-55555555555a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','BOARD1','Board 1','active');

insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, delivery_required, expected_delivery_date) values
  -- S: completed straight from New, the create-and-complete path.
  ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00001', true, '2026-11-25'),
  -- S: an older job left at Ready, completed by hand.
  ('d0000000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00002', true, '2026-11-25'),
  -- S: a job already on a round.
  ('d0000000-0000-0000-0000-00000000000d','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00003', true, '2026-11-25'),
  -- F: the full process.
  ('d0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'c0000000-0000-0000-0000-00000000000b','LJ00001', true, '2026-11-25');

update public.laundry_orders set status = 'ready_for_delivery'
 where id in ('d0000000-0000-0000-0000-00000000000c','d0000000-0000-0000-0000-00000000000d');
update public.laundry_orders set status = 'assigned',
       assigned_board_id = '55555555-5555-5555-5555-55555555555a',
       assigned_delivery_date = '2026-11-25'
 where id = 'd0000000-0000-0000-0000-00000000000d';

-- ------------------------------------------------------------- simplified --
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select lives_ok(
  $$update public.laundry_orders set status = 'completed'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'with no setting saved, a delivery job is completed straight from New');

-- Asserted by outcome, not by `lives_ok` alone: a restrictive policy refusing
-- a caller writes zero rows with no error, the silence this project has shipped
-- twice.
select is((select status from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a'), 'completed',
          'the counter''s write landed');
select is((select billing_status from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a'), 'awaiting_review',
          'completing it puts it in the billing queue — 0017''s hook survived the rebuild');
select ok((select completed_at is not null from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a'),
          'the finishing time is stamped');
select is((select count(*) from public.invoice_source_jobs
            where order_id = 'd0000000-0000-0000-0000-00000000000a')::int, 0,
          'completing a job raises no invoice');

select lives_ok(
  $$update public.laundry_orders set status = 'completed'
     where id = 'd0000000-0000-0000-0000-00000000000c'$$,
  'an older job left at Ready can be completed from the shelf too');

select throws_ok(
  $$update public.laundry_orders set status = 'completed'
     where id = 'd0000000-0000-0000-0000-00000000000d'$$,
  'P0001',
  'a delivery job must be assigned to a board and go out before it is completed',
  'a job already on a round still goes out before it is completed');

select throws_ok(
  $$update public.laundry_orders set status = 'ready_for_delivery'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'a job cannot go from completed to ready_for_delivery',
  'a completed job stays completed in the simplified workflow');

select throws_ok(
  $$update public.laundry_orders set status = 'out_for_delivery'
     where id = 'd0000000-0000-0000-0000-00000000000c'$$,
  'P0001',
  'a job cannot go from completed to out_for_delivery',
  'a finished job is terminal for every stage, not only the one it came from');

-- A backdated job (2026-11-24): the counter types in on the 24th laundry that
-- came in on 31 October, and `createOrder` completes it as at that instant.
-- 23:50 on 31 October in Adelaide is 13:20 UTC, under daylight saving.
select lives_ok(
  $$insert into public.laundry_orders
      (id, tenant_id, customer_id, order_number, delivery_required,
       expected_delivery_date, received_at)
    values ('d0000000-0000-0000-0000-00000000000f','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'c0000000-0000-0000-0000-00000000000a','LJ00005', true,
            '2026-11-02', '2026-10-31T13:20:00Z')$$,
  'the counter takes in a job received last month');
select lives_ok(
  $$update public.laundry_orders
       set status = 'completed', completed_at = '2026-10-31T13:20:00Z'
     where id = 'd0000000-0000-0000-0000-00000000000f'$$,
  'and completes it straight from New as at the day it was received');
select is((select status from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000f'), 'completed',
          'the backdated completion landed');
select is((select completed_at from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000f'),
          '2026-10-31T13:20:00Z'::timestamptz,
          'the received instant is kept as the finishing time, not replaced with now');
select is((select (completed_at at time zone 'Australia/Adelaide')::date
             from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000f'),
          '2026-10-31'::date,
          'which is 31 October in Adelaide, so it joins October''s draft');
select is((select billing_status from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000f'), 'awaiting_review',
          'and it is in the billing queue like any other finished job');

-- Correcting its received date carries the completion date with it (2026-11-24):
-- nothing in the database refuses moving `completed_at` on a finished job, which
-- is what `updateOrder` relies on.
select lives_ok(
  $$update public.laundry_orders
       set received_at = '2026-10-28T02:00:00Z', completed_at = '2026-10-28T02:00:00Z'
     where id = 'd0000000-0000-0000-0000-00000000000f'$$,
  'a completed job''s received and completion dates can be corrected together');
select is((select (completed_at at time zone 'Australia/Adelaide')::date
             from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000f'),
          '2026-10-28'::date,
          'the correction landed, so the job now bills to the day it was really received');

reset role;

-- ------------------------------------------------------------------- full --
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

select throws_ok(
  $$update public.laundry_orders set status = 'completed'
     where id = 'd0000000-0000-0000-0000-00000000000b'$$,
  'P0001',
  'a delivery job must be assigned to a board and go out before it is completed',
  'in the full workflow a delivery job still cannot be completed from New');

reset role;

-- Switching back to full applies at once, to the very laundry that was simplified.
update public.tenants set settings = '{"operations":{"workflow":"full"}}'
 where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, delivery_required, expected_delivery_date) values
  ('d0000000-0000-0000-0000-00000000000e','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00004', true, '2026-11-25');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select throws_ok(
  $$update public.laundry_orders set status = 'completed'
     where id = 'd0000000-0000-0000-0000-00000000000e'$$,
  'P0001',
  'a delivery job must be assigned to a board and go out before it is completed',
  'switching to the full workflow restores the original rule');

select is((select status from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a'), 'completed',
          'and changes no job that was already completed');

reset role;

-- An unreadable setting refuses rather than permits.
select ok(pg_get_functiondef('public.guard_laundry_order_transition()'::regprocedure)
            like '%), false)%',
          'a tenant row the caller cannot see is read as not simplified');

select * from finish();
rollback;
