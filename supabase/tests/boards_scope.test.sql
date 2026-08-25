-- Proof: a board is the operational unit, and it reaches exactly its own round.
--
-- The failure this file exists to prevent is a **silent** one, and this project
-- has shipped it once already (2026-08-17, a driver with no `drivers` row): a
-- login that works perfectly and shows an empty application. `current_board_id()`
-- is what four policy families read to scope a round's session, so if the helper
-- or any one of those predicates is wrong the board signs in, sees nothing, and
-- everybody concludes the app is broken rather than the link is missing.
--
-- So the assertions here are deliberately of two kinds:
--
--   * **it can see its own** — the run, the stops on it, the laundry assigned to
--     it. A policy that filters everything out passes every "cannot see" test in
--     the world and is still useless.
--   * **it cannot see another's** — the tenancy boundary, and the board boundary
--     inside it.
--
-- Plus the two things that are easy to get wrong in a migration and impossible
-- to notice afterwards: the twelfth membership role actually being accepted by
-- the column, and 0025's *restrictive* write layer carving the board out. Without
-- that carve-out a board completing its own delivery is refused with zero rows
-- and no error, and the job sits at `out_for_delivery` for ever.
begin;
select plan(23);

insert into auth.users (id, email) values
  ('b1000000-0000-0000-0000-000000000001','board1@example.com'),
  ('b1000000-0000-0000-0000-000000000002','board2@example.com'),
  ('b1000000-0000-0000-0000-00000000000d','dispatcher@example.com'),
  ('b1000000-0000-0000-0000-0000000000bb','other@example.com');

insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');

-- The twelfth role. If 0031 had widened `roles.ts` and not the check constraint,
-- this insert is where an invitation would fail — in production, silently, for
-- every board account somebody tried to create.
insert into public.memberships (user_id, tenant_id, role) values
  ('b1000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','board'),
  ('b1000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','board'),
  ('b1000000-0000-0000-0000-00000000000d','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','operations_manager'),
  ('b1000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

select ok(true, 'the memberships column accepts the board role');

insert into public.boards (id, tenant_id, user_id, code, name) values
  ('bb000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'b1000000-0000-0000-0000-000000000001','BOARD1','Board 1'),
  ('bb000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'b1000000-0000-0000-0000-000000000002','BOARD2','Board 2');
insert into public.boards (id, tenant_id, code, name) values
  ('bb000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','BOARD1','Their Board');

-- A driver, unlinked to any login. Kept deliberately: a board is a round and a
-- driver is a person, and the run records which person operated it.
insert into public.drivers (id, tenant_id, full_name) values
  ('dd000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Mario Forte');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Hotel'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Southern Cafe');

insert into public.daily_routes (id, tenant_id, route_date, code, name, board_id, operated_by_driver_id) values
  ('50000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '2026-08-21','BOARD1-1','Board 1','bb000000-0000-0000-0000-000000000001',
   'dd000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '2026-08-21','BOARD2-1','Board 2','bb000000-0000-0000-0000-000000000002',null),
  ('50000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '2026-08-21','BOARD1-1','Their Board','bb000000-0000-0000-0000-0000000000bb',null);

insert into public.jobs (id, tenant_id, route_id, customer_id, job_number, scheduled_date, sequence, service_type) values
  ('10000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-00000000000a','JOB00001','2026-08-21',1,'delivery'),
  ('10000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-00000000000a','JOB00002','2026-08-21',1,'delivery');

insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, status, delivery_required,
   expected_delivery_date, assigned_board_id, assigned_delivery_date, stop_id) values
  ('d0000000-0000-0000-0000-0000000000a1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00001','assigned', true, '2026-08-21',
   'bb000000-0000-0000-0000-000000000001','2026-08-21','10000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-0000000000a2','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00002','assigned', true, '2026-08-21',
   'bb000000-0000-0000-0000-000000000002','2026-08-21','10000000-0000-0000-0000-000000000002');

-- ------------------------------------------------------------------ anon ----
-- 0029: `anon` holds no table privilege in `public`, and a table added later
-- must not reopen that. Asserted twice — the privilege, and the attempt — since
-- 42501 alone proves nothing here: our own membership guards raise it too.
select ok(not has_table_privilege('anon', 'public.boards', 'SELECT'),
          'anon holds no SELECT privilege on boards');
select ok(not has_function_privilege('anon', 'public.current_board_id(uuid)', 'EXECUTE'),
          'anon cannot execute current_board_id');
select ok(not has_function_privilege('anon', 'public.is_board_only(uuid)', 'EXECUTE'),
          'anon cannot execute is_board_only');

set local role anon;
select throws_ok(
  $$select id from public.boards$$,
  '42501',
  'permission denied for table boards',
  'an unauthenticated caller cannot read the board list');
reset role;

set local role authenticated;

-- --------------------------------------------------------- the board itself --
set local "request.jwt.claim.sub" = 'b1000000-0000-0000-0000-000000000001';

select is(public.current_board_id('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          'bb000000-0000-0000-0000-000000000001'::uuid,
          'a board login resolves to its own board');
select ok(public.is_board_only('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          'a board membership is board-scoped');
select ok(not public.is_driver_only('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          'a board is not narrowed by the driver clause as well');

-- **It can see its own.** The half of this that a broken policy still passes
-- if you only assert what must be hidden.
select is((select count(*) from public.daily_routes)::int, 1,
          'a board sees its own run');
select is((select count(*) from public.jobs)::int, 1,
          'a board sees the stops on its own run');
select is((select count(*) from public.laundry_orders)::int, 1,
          'a board sees the laundry assigned to it');
select is((select order_number from public.laundry_orders limit 1), 'LJ00001',
          'and it is the right laundry');

-- **It cannot see the other round's.**
select is((select count(*) from public.daily_routes
            where id = '50000000-0000-0000-0000-000000000002')::int, 0,
          'a board cannot see another board''s run');
select is((select count(*) from public.laundry_orders
            where order_number = 'LJ00002')::int, 0,
          'a board cannot see laundry on another board''s round');

-- 0025's restrictive layer, carved out for the board. Without the clause 0031
-- adds, this update matches zero rows and raises nothing — the job stays out for
-- delivery for ever and nobody is told why.
select lives_ok(
  $$update public.laundry_orders set status = 'out_for_delivery'
     where order_number = 'LJ00001'$$,
  'a board can send its own job out');
select lives_ok(
  $$update public.laundry_orders set status = 'completed'
     where order_number = 'LJ00001'$$,
  'a board can finish its own delivery');
select is((select status from public.laundry_orders where order_number = 'LJ00001'),
          'completed',
          'and the write actually landed rather than matching zero rows');

-- ------------------------------------------------------- the other board ----
set local "request.jwt.claim.sub" = 'b1000000-0000-0000-0000-000000000002';
select is((select count(*) from public.laundry_orders)::int, 1,
          'the other board sees exactly its own one job');
select is((select order_number from public.laundry_orders limit 1), 'LJ00002',
          'and it is the other job');

-- ------------------------------------------------------------ the office ----
-- The narrowing is *only* for a board. An office role still sees the whole
-- laundry, which is what makes the reorder and reassign screens possible.
set local "request.jwt.claim.sub" = 'b1000000-0000-0000-0000-00000000000d';
select is((select count(*) from public.laundry_orders)::int, 2,
          'the office manager still sees every job in the laundry');
select is((select count(*) from public.boards)::int, 2,
          'and every board in it');

-- ----------------------------------------------------------- other tenant ---
set local "request.jwt.claim.sub" = 'b1000000-0000-0000-0000-0000000000bb';
select is((select count(*) from public.boards)::int, 1,
          'the other tenant sees only its own board');
select is((select count(*) from public.laundry_orders)::int, 0,
          'and none of this laundry''s jobs, board clause or not');

select finish();
rollback;
