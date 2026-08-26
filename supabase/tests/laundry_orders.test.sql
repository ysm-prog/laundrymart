-- Proof: laundry jobs are tenant-scoped, and the workflow is a database fact.
--
-- Two things are being defended here. The first is the usual one — a job carries
-- a customer's name, their address and what is in their bags, so another tenant
-- must not be able to reach it, and the `with check` half has to refuse a
-- well-formed row addressed to someone else.
--
-- The second is the workflow itself. The server action checks the transition
-- table before it writes, but the action is not the boundary: anything holding a
-- session and the anon key can PATCH `/rest/v1/laundry_orders` directly. So
-- "a job cannot skip from new to completed", "a customer pickup never goes out
-- on a van" and "a finished job stays finished" are asserted here, against the
-- trigger, rather than trusted to the screen.
begin;
select plan(39);

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
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Harbourview Hotel'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Southern Cafe');

-- A delivers, B has a customer collecting. Both numbered LJ00001 on purpose:
-- job numbers are unique per tenant, not globally, and the index has to agree.
insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, delivery_required, expected_delivery_date) values
  ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00001', true, '2026-08-20');
insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, delivery_required, expected_collection_date) values
  ('d0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'c0000000-0000-0000-0000-00000000000b','LJ00001', false, '2026-08-21');

-- A driver for tenant A. Since 0031 a driver is the *person* rather than the
-- assignment target, and is kept here because the run still records who drove.
insert into public.drivers (id, tenant_id, full_name, status) values
  ('44444444-4444-4444-4444-44444444444a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Michael Driver','active');

-- A board for tenant A, so the assignment step below has a round to give the job
-- to. Deliberately only in A: the guard's "that board could not be found" branch
-- is what stops a job naming another tenant's round.
insert into public.boards (id, tenant_id, code, name, status) values
  ('55555555-5555-5555-5555-55555555555a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'BOARD1','Board 1','active');

insert into public.laundry_order_items
  (tenant_id, order_id, item_type, quantity_type, exact_quantity) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-00000000000a','towels','exact',24),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','d0000000-0000-0000-0000-00000000000b','sheets','exact',6);

-- ------------------------------------------------------------------ anon ----
-- PostgREST hands an unauthenticated request to `anon`. Asserted twice: the
-- privilege itself, and the attempt matched on its message — 42501 alone proves
-- nothing, because our own membership guards raise it too.
select ok(not has_table_privilege('anon', 'public.laundry_orders', 'SELECT'),
          'anon holds no SELECT privilege on laundry_orders');
select ok(not has_function_privilege('anon', 'public.save_laundry_order_items(uuid, jsonb)', 'EXECUTE'),
          'anon cannot execute save_laundry_order_items');

set local role anon;
select throws_ok(
  $$select id from public.laundry_orders$$,
  '42501',
  'permission denied for table laundry_orders',
  'an unauthenticated caller cannot read jobs');
reset role;

-- --------------------------------------------------------------- tenancy ----
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is((select count(*) from public.laundry_orders)::int, 1,
          'A sees only its own jobs');
select is((select count(*) from public.laundry_orders
            where tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')::int, 0,
          'B''s job is invisible, not merely unlinked');
select is((select count(*) from public.laundry_order_items)::int, 1,
          'the laundry list is scoped with its job');

-- The tenant-hop: a well-formed row addressed to someone else. The using clause
-- has nothing to say about an insert, so the with check has to refuse it.
select throws_ok(
  $$insert into public.laundry_orders
      (tenant_id, customer_id, order_number, delivery_required, expected_collection_date)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            'c0000000-0000-0000-0000-00000000000b','LJ00002', false, '2026-08-25')$$,
  '42501',
  'new row violates row-level security policy for table "laundry_orders"',
  'A cannot file a job into B''s tenant');

-- Job numbers are per tenant, so the same number in two tenants is fine and the
-- same number twice in one tenant is not.
select throws_ok(
  $$insert into public.laundry_orders
      (tenant_id, customer_id, order_number, delivery_required, expected_collection_date)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'c0000000-0000-0000-0000-00000000000a','LJ00001', false, '2026-08-25')$$,
  '23505'::char(5), NULL,
  'a job number cannot be reused inside one tenant');

-- ------------------------------------------------------------ due_date ------
-- The generated column the list, the filters and the overdue rule all read.
select is((select due_date from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a'), '2026-08-20'::date,
          'a delivery job is due on its delivery date');

-- ---------------------------------------------------------- transitions -----
-- **Since 0042 the stages are picked, not walked.** Three of the assertions in
-- this section used to say the opposite — that a job takes one step at a time,
-- forwards — and they are rewritten to the decision rather than deleted: what a
-- proof asserts is what the next person reads the rule as. What survives is the
-- four rules that are about the job's own facts, and each is proved below.
select throws_ok(
  $$update public.laundry_orders set status = 'completed'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'a delivery job must be assigned to a board and go out before it is completed',
  'a delivery job cannot be finished before it has been anywhere');

select lives_ok(
  $$update public.laundry_orders set status = 'in_progress'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'new to in progress is allowed');

select lives_ok(
  $$update public.laundry_orders set status = 'new'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'a job goes back a stage when it was moved on by mistake');

select throws_ok(
  $$update public.laundry_orders set status = 'assigned',
        assigned_board_id = '55555555-5555-5555-5555-55555555555a',
        assigned_delivery_date = '2026-08-20'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'a job is marked ready for delivery before it is given to a round',
  'laundry still in the plant is not handed to a delivery round');

select lives_ok(
  $$update public.laundry_orders set status = 'ready_for_delivery'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'a job skips a stage it does not need');

-- The fork the whole module turns on, asserted from both sides.
select throws_ok(
  $$update public.laundry_orders set status = 'completed'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'a delivery job must be assigned to a board and go out before it is completed',
  'a delivery job cannot be completed off the shelf');

-- A delivery job cannot jump the assignment step: it needs a board and a date
-- before it can go out. 0042 restates this as a rule about the job's own
-- assignment rather than about which stage it came from, because every other
-- stage is now reachable — a job out on nobody's van is invisible to My Runs.
select throws_ok(
  $$update public.laundry_orders set status = 'out_for_delivery'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'a delivery job is assigned to a round before it goes out',
  'a delivery job must be assigned before it goes out');

select throws_ok(
  $$update public.laundry_orders set status = 'assigned'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  '23514',
  null,
  'a job cannot be Assigned without a board and a delivery date');

select lives_ok(
  $$update public.laundry_orders
       set status = 'assigned',
           assigned_board_id = '55555555-5555-5555-5555-55555555555a',
           assigned_delivery_date = '2026-08-20'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'a ready delivery job takes a board and a date');

select isnt((select assigned_at from public.laundry_orders
              where id = 'd0000000-0000-0000-0000-00000000000a'), null,
            'assigning stamps assigned_at even when the client forgets');

select lives_ok(
  $$update public.laundry_orders set status = 'out_for_delivery'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'an assigned delivery job goes out on a van');

-- **Coming back off a round.** 0031 cleared the assignment on the single
-- `assigned -> ready_for_delivery` edge; 0042 widened that to every move out of
-- the two delivery stages into the three plant ones, because those are all
-- reachable now — and without it `chk_laundry_orders_assignment_status` refuses
-- the whole update, since an assignment may only be held from `assigned` on.
select lives_ok(
  $$update public.laundry_orders set status = 'in_progress'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'a job out on a van can be pulled back into the plant');

select is((select assigned_board_id from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a'), null,
          'coming off a round clears the board');

select is((select assigned_delivery_date from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a'), null,
          'coming off a round clears the delivery date');

-- And back out again, which is the point of allowing it at all.
update public.laundry_orders set status = 'ready_for_delivery'
 where id = 'd0000000-0000-0000-0000-00000000000a';
update public.laundry_orders
   set status = 'assigned',
       assigned_board_id = '55555555-5555-5555-5555-55555555555a',
       assigned_delivery_date = '2026-08-20'
 where id = 'd0000000-0000-0000-0000-00000000000a';
update public.laundry_orders set status = 'out_for_delivery'
 where id = 'd0000000-0000-0000-0000-00000000000a';

update public.laundry_orders set status = 'completed'
 where id = 'd0000000-0000-0000-0000-00000000000a';

-- The trigger stamps what the state implies, so no client can record a finished
-- job without a finishing time.
select isnt((select completed_at from public.laundry_orders
              where id = 'd0000000-0000-0000-0000-00000000000a'), null,
            'completing a job stamps completed_at even when the client forgets');

select throws_ok(
  $$update public.laundry_orders set status = 'in_progress'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'a job cannot go from completed to in_progress',
  'a finished job stays finished');

-- ------------------------------------------------------- the pickup side ----
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

select is((select due_date from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000b'), '2026-08-21'::date,
          'a customer pickup is due on its collection date');

update public.laundry_orders set status = 'in_progress'
 where id = 'd0000000-0000-0000-0000-00000000000b';
update public.laundry_orders set status = 'ready_for_delivery'
 where id = 'd0000000-0000-0000-0000-00000000000b';

select throws_ok(
  $$update public.laundry_orders set status = 'out_for_delivery'
     where id = 'd0000000-0000-0000-0000-00000000000b'$$,
  'P0001',
  'this job is a customer pickup, so it is never sent out on a run',
  'a customer pickup never goes out on a van');

select throws_ok(
  $$update public.laundry_orders set status = 'assigned'
     where id = 'd0000000-0000-0000-0000-00000000000b'$$,
  'P0001',
  'this job is a customer pickup, so it is never sent out on a run',
  'a customer pickup is never assigned to a delivery driver');

select lives_ok(
  $$update public.laundry_orders set status = 'completed'
     where id = 'd0000000-0000-0000-0000-00000000000b'$$,
  'a customer pickup is completed when they walk out with it');

-- A pickup has no delivery to go out on, so nothing stands between it and being
-- finished — including the two stages in front of it. The counter hand who takes
-- a bag in, washes it and hands it straight back has one press, not three.
insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, delivery_required, expected_collection_date)
values ('d0000000-0000-0000-0000-00000000000d','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'c0000000-0000-0000-0000-00000000000b','LJ00002', false, '2026-08-22');

select lives_ok(
  $$update public.laundry_orders set status = 'completed'
     where id = 'd0000000-0000-0000-0000-00000000000d'$$,
  'a customer pickup is finished straight from new');

select throws_ok(
  $$update public.laundry_orders set status = 'in_progress'
     where id = 'd0000000-0000-0000-0000-00000000000d'$$,
  'P0001',
  'a job cannot go from completed to in_progress',
  'a finished job stays finished however it got there');

-- ------------------------------------------------------- item constraints ---
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, delivery_required, expected_collection_date)
values ('d0000000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'c0000000-0000-0000-0000-00000000000a','LJ00003', false, '2026-08-30');

select throws_ok(
  $$insert into public.laundry_order_items
      (tenant_id, order_id, item_type, quantity_type)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'd0000000-0000-0000-0000-00000000000c','towels','exact')$$,
  '23514'::char(5), NULL,
  'counted laundry has to carry a count');

select throws_ok(
  $$insert into public.laundry_order_items
      (tenant_id, order_id, item_type, quantity_type)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'd0000000-0000-0000-0000-00000000000c','sheets','bulk_lot')$$,
  '23514'::char(5), NULL,
  'a bulk lot with no bags, no estimate and no note records nothing');

select throws_ok(
  $$insert into public.laundry_order_items
      (tenant_id, order_id, item_type, quantity_type, exact_quantity)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'd0000000-0000-0000-0000-00000000000c','other','exact',3)$$,
  '23514'::char(5), NULL,
  '"Other" without a description is a row nobody can act on later');

-- ------------------------------------------------ save_laundry_order_items ---
select is(
  public.save_laundry_order_items(
    'd0000000-0000-0000-0000-00000000000c',
    '[{"item_type":"towels","quantity_type":"exact","exact_quantity":"12"},
      {"item_type":"sheets","quantity_type":"bulk_lot","bag_count":"2"}]'::jsonb),
  2,
  'the whole laundry list is written in one transaction');

select throws_ok(
  $$select public.save_laundry_order_items('d0000000-0000-0000-0000-00000000000c', '[]'::jsonb)$$,
  'P0001',
  'a job needs at least one laundry item',
  'a job cannot be emptied of its laundry');

-- The set survived the refused call: a rejected replace leaves the old list.
select is((select count(*) from public.laundry_order_items
            where order_id = 'd0000000-0000-0000-0000-00000000000c')::int, 2,
          'a refused replace leaves the previous list intact');

-- ------------------------------------------------------- cancelled is final --
update public.laundry_orders set status = 'cancelled'
 where id = 'd0000000-0000-0000-0000-00000000000c';

select isnt((select cancelled_at from public.laundry_orders
              where id = 'd0000000-0000-0000-0000-00000000000c'), null,
            'cancelling stamps cancelled_at');

select throws_ok(
  $$update public.laundry_order_items set notes = 'changed my mind'
     where order_id = 'd0000000-0000-0000-0000-00000000000c'$$,
  'P0001',
  'this job was cancelled, so its laundry list cannot be changed',
  'a cancelled job''s contents stop moving');

select finish();
rollback;
