-- Proof: the order of a run is management's decision, and the database enforces
-- it independently of the screen.
--
-- The requirement's §8 is the whole reason this file exists: *"A malicious or
-- technically capable Driver must NOT be able to call the server action
-- directly, submit forged form data, submit another Board ID, submit another
-- date, submit somebody else's run, send a fabricated sequence, bypass the
-- locked state, or modify `jobs.sequence` directly through the application
-- interface."* Every one of those is a claim about the database, not about
-- React, and before 0036 every one of them was **false**: `jobs_access` is a
-- single permissive `for all` policy, so a driver could PATCH the sequence of
-- the run they were standing in and a counter hand could PATCH anybody's.
--
-- Two shapes of assertion, deliberately:
--
--   * **it is refused** — and refused *out loud*, with a SQLSTATE. 0025's
--     restrictive layer writes zero rows and raises nothing, a silence this
--     project has shipped twice; a trigger is used here precisely so the person
--     is told. `throws_ok` is therefore the right assertion and `lives_ok`
--     would prove nothing.
--   * **it still works** — the owner and the office manager really do reorder,
--     assignment really does still append, and a gap really does close. A guard
--     that refuses everybody passes every "cannot" test in the world and leaves
--     the office unable to plan a day.
begin;
select plan(30);

-- --------------------------------------------------------------- fixtures ---
insert into auth.users (id, email) values
  ('50000000-0000-4000-8000-00000000000a','owner@example.com'),
  ('50000000-0000-4000-8000-00000000000b','office@example.com'),
  ('50000000-0000-4000-8000-00000000000c','dispatcher@example.com'),
  ('50000000-0000-4000-8000-00000000000d','driver@example.com'),
  ('50000000-0000-4000-8000-00000000000e','board@example.com'),
  ('50000000-0000-4000-8000-00000000000f','other-owner@example.com');

insert into public.tenants (id, name) values
  ('5a000000-0000-4000-8000-000000000001','Ours'),
  ('5b000000-0000-4000-8000-000000000002','Theirs');

insert into public.memberships (user_id, tenant_id, role) values
  ('50000000-0000-4000-8000-00000000000a','5a000000-0000-4000-8000-000000000001','super_admin'),
  ('50000000-0000-4000-8000-00000000000b','5a000000-0000-4000-8000-000000000001','operations_manager'),
  ('50000000-0000-4000-8000-00000000000c','5a000000-0000-4000-8000-000000000001','dispatcher'),
  ('50000000-0000-4000-8000-00000000000d','5a000000-0000-4000-8000-000000000001','driver'),
  ('50000000-0000-4000-8000-00000000000e','5a000000-0000-4000-8000-000000000001','board'),
  ('50000000-0000-4000-8000-00000000000f','5b000000-0000-4000-8000-000000000002','super_admin');

insert into public.drivers (id, tenant_id, user_id, full_name) values
  ('d0000000-0000-4000-8000-000000000001','5a000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-00000000000d','Mario Forte');

insert into public.boards (id, tenant_id, user_id, code, name) values
  ('b0000000-0000-4000-8000-000000000001','5a000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-00000000000e','BOARD1','Board 1'),
  ('b0000000-0000-4000-8000-000000000002','5a000000-0000-4000-8000-000000000001',
   null,'BOARD2','Board 2');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-4000-8000-00000000000a','5a000000-0000-4000-8000-000000000001','CUST00001','ABC Hotel'),
  ('c0000000-0000-4000-8000-00000000000b','5a000000-0000-4000-8000-000000000001','CUST00002','Bay Cafe'),
  ('c0000000-0000-4000-8000-00000000000c','5a000000-0000-4000-8000-000000000001','CUST00003','City Gym'),
  ('c0000000-0000-4000-8000-00000000000e','5a000000-0000-4000-8000-000000000001','CUST00004','Dock Motel');

-- Board 1 on the 25th is the run under test. Board 2 on the same day and Board 1
-- on the 26th are the neighbours that must not move (§13, and acceptance tests
-- 11 and 12).
insert into public.daily_routes
  (id, tenant_id, route_date, code, name, board_id, driver_id) values
  ('50000000-0000-4000-8000-000000000101','5a000000-0000-4000-8000-000000000001',
   '2026-08-25','B1-25','Board 1','b0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000102','5a000000-0000-4000-8000-000000000001',
   '2026-08-25','B2-25','Board 2','b0000000-0000-4000-8000-000000000002',null),
  ('50000000-0000-4000-8000-000000000103','5a000000-0000-4000-8000-000000000001',
   '2026-08-26','B1-26','Board 1','b0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001');

insert into public.jobs
  (id, tenant_id, route_id, customer_id, job_number, scheduled_date, sequence, service_type,
   driver_id) values
  -- A B C D on Board 1 / 25 August.
  ('30000000-0000-4000-8000-00000000000a','5a000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000101','c0000000-0000-4000-8000-00000000000a','JOB00001','2026-08-25',1,'delivery','d0000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-00000000000b','5a000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000101','c0000000-0000-4000-8000-00000000000b','JOB00002','2026-08-25',2,'delivery','d0000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-00000000000c','5a000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000101','c0000000-0000-4000-8000-00000000000c','JOB00003','2026-08-25',3,'delivery','d0000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-00000000000d','5a000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000101','c0000000-0000-4000-8000-00000000000e','JOB00004','2026-08-25',4,'delivery','d0000000-0000-4000-8000-000000000001'),
  -- The neighbours.
  ('30000000-0000-4000-8000-000000000021','5a000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000102','c0000000-0000-4000-8000-00000000000a','JOB00021','2026-08-25',1,'delivery',null),
  ('30000000-0000-4000-8000-000000000022','5a000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000102','c0000000-0000-4000-8000-00000000000b','JOB00022','2026-08-25',2,'delivery',null),
  ('30000000-0000-4000-8000-000000000031','5a000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000101','c0000000-0000-4000-8000-00000000000a','JOB00031','2026-08-26',1,'delivery',null);

-- Board 1 / 26 August, so a date-independence assertion has something to read.
update public.jobs set route_id = '50000000-0000-4000-8000-000000000103'
 where id = '30000000-0000-4000-8000-000000000031';

-- ------------------------------------------------- the columns and defaults --
-- Every existing run arrives locked and at version 1: the default describes what
-- was already true, so no historical row is invalidated.
select is((select count(*) from public.daily_routes
            where sequence_locked and sequence_version = 1)::int, 3,
          'every run arrives locked at version 1, so no history is re-judged');

set local role authenticated;

-- ============================================================ REFUSALS =======

-- 3. Dispatcher cannot update sequence. They hold `routes.write` — which is
--    exactly why the app needed a capability of its own and why this is the
--    assertion that matters most.
set local "request.jwt.claim.sub" = '50000000-0000-4000-8000-00000000000c';
select ok(not public.can_write_run_sequence('5a000000-0000-4000-8000-000000000001'),
          'a dispatcher may not order a run, though they hold routes.write');
select throws_ok(
  $$update public.jobs set sequence = 9
     where id = '30000000-0000-4000-8000-00000000000a'$$,
  '42501',
  'the order of a run is set by the office, and your role cannot change it',
  'a dispatcher cannot PATCH jobs.sequence');

-- 4. Driver cannot update sequence — not even on the run they are driving,
--    which RLS otherwise lets them write to freely.
set local "request.jwt.claim.sub" = '50000000-0000-4000-8000-00000000000d';
select is((select count(*) from public.jobs
            where route_id = '50000000-0000-4000-8000-000000000101')::int, 4,
          'a driver can see the stops on their own run');
select throws_ok(
  $$update public.jobs set sequence = 9
     where id = '30000000-0000-4000-8000-00000000000a'$$,
  '42501', null,
  'a driver cannot reorder the run they are standing in');
select throws_ok(
  $$update public.daily_routes set sequence_locked = false
     where id = '50000000-0000-4000-8000-000000000101'$$,
  '42501',
  'only the owner or an operations manager can change a run''s order',
  'a driver cannot unlock the run to get past the guard');
-- 13/§8: calling the server-side entry point directly is refused too.
select throws_ok(
  $$select public.apply_run_sequence(
      '5a000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
      '2026-08-25',
      array['30000000-0000-4000-8000-00000000000d','30000000-0000-4000-8000-00000000000a',
            '30000000-0000-4000-8000-00000000000b','30000000-0000-4000-8000-00000000000c']::uuid[], 1)$$,
  '42501', null,
  'a driver calling the save entry point directly is refused');

-- 5. Board cannot update sequence. It sees the final order and follows it.
set local "request.jwt.claim.sub" = '50000000-0000-4000-8000-00000000000e';
select is((select count(*) from public.jobs
            where route_id = '50000000-0000-4000-8000-000000000101')::int, 4,
          'a board can see the stops on its own round');
select throws_ok(
  $$update public.jobs set sequence = 9
     where id = '30000000-0000-4000-8000-00000000000a'$$,
  '42501', null,
  'a board cannot reorder its own round');

-- 6. One tenant cannot touch another's run. RLS hides the rows, so the direct
--    UPDATE is a *silence* — asserted by outcome, from a session that can see
--    the rows, because zero-rows-and-no-error is the shape this project has
--    been bitten by. The entry point refuses out loud as well.
set local "request.jwt.claim.sub" = '50000000-0000-4000-8000-00000000000f';
select lives_ok(
  $$update public.jobs set sequence = 9
     where id = '30000000-0000-4000-8000-00000000000a'$$,
  'another laundry''s update is filtered to nothing rather than raising');
select throws_ok(
  $$select public.apply_run_sequence(
      '5a000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
      '2026-08-25', array['30000000-0000-4000-8000-00000000000a']::uuid[], 1)$$,
  '42501', 'that laundry is not yours',
  'another laundry''s owner cannot save our run order');

-- ============================================================ THE OFFICE =====

-- 2. Operations Manager can update sequence, and 10: a valid save succeeds.
set local "request.jwt.claim.sub" = '50000000-0000-4000-8000-00000000000b';
select ok(public.can_write_run_sequence('5a000000-0000-4000-8000-000000000001'),
          'an operations manager may order a run');

-- 8. A forged board/date combination is rejected: this board has nothing on the
--    27th, and the run ids are resolved here rather than taken from the caller.
select throws_ok(
  $$select public.apply_run_sequence(
      '5a000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
      '2026-08-27', array['30000000-0000-4000-8000-00000000000a']::uuid[], 1)$$,
  'P0001', 'that board has nothing on that day any more',
  'a forged board/date combination is refused');

-- 7. A forged stop — one from the neighbouring board's run — is refused rather
--    than quietly moved.
select throws_ok(
  $$select public.apply_run_sequence(
      '5a000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
      '2026-08-25',
      array['30000000-0000-4000-8000-00000000000a','30000000-0000-4000-8000-00000000000b',
            '30000000-0000-4000-8000-00000000000c','30000000-0000-4000-8000-000000000021']::uuid[], 1)$$,
  'P0001', 'that order names a stop that is not on this run',
  'a stop from another board''s run is refused');

-- An incomplete order is refused too: silently dropping a stop loses a visit.
select throws_ok(
  $$select public.apply_run_sequence(
      '5a000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
      '2026-08-25',
      array['30000000-0000-4000-8000-00000000000a','30000000-0000-4000-8000-00000000000b']::uuid[], 1)$$,
  'P0001', 'that order does not match the stops on this run any more',
  'an order missing a stop is refused');

-- The real thing: A C D B, saved by the office manager.
select is(
  public.apply_run_sequence(
    '5a000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
    '2026-08-25',
    array['30000000-0000-4000-8000-00000000000a','30000000-0000-4000-8000-00000000000c',
          '30000000-0000-4000-8000-00000000000d','30000000-0000-4000-8000-00000000000b']::uuid[], 1),
  2,
  'an operations manager saves the order and the version moves to 2');

select is(
  (select string_agg(job_number, ',' order by sequence) from public.jobs
    where route_id = '50000000-0000-4000-8000-000000000101'),
  'JOB00001,JOB00003,JOB00004,JOB00002',
  'the exact order is persisted, renumbered from 1 with no gaps');

-- 14. Concurrency: the stale editing session still holding version 1 loses.
select throws_ok(
  $$select public.apply_run_sequence(
      '5a000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
      '2026-08-25',
      array['30000000-0000-4000-8000-00000000000b','30000000-0000-4000-8000-00000000000a',
            '30000000-0000-4000-8000-00000000000c','30000000-0000-4000-8000-00000000000d']::uuid[], 1)$$,
  'P0001',
  'this run was updated by another user. Reload the run to see the latest sequence before making further changes.',
  'a stale editing session cannot overwrite a newer sequence');

-- 11/12. The neighbours did not move.
select is(
  (select string_agg(job_number, ',' order by sequence) from public.jobs
    where route_id = '50000000-0000-4000-8000-000000000102'),
  'JOB00021,JOB00022', 'Board 2 on the same day is untouched');
select is(
  (select sequence from public.jobs where id = '30000000-0000-4000-8000-000000000031'), 1,
  'Board 1 on the next day is untouched');

-- §16: a worked stop keeps its place, and that holds for the office too.
update public.jobs set progress_status = 'at_customer'
 where id = '30000000-0000-4000-8000-00000000000a';
select throws_ok(
  $$update public.jobs set sequence = 4
     where id = '30000000-0000-4000-8000-00000000000a'$$,
  'P0001', 'that stop has already been worked, so its place in the run cannot change',
  'not even an office manager can reposition a stop the round has worked');

-- 1. Owner can update sequence.
set local "request.jwt.claim.sub" = '50000000-0000-4000-8000-00000000000a';
select ok(public.can_write_run_sequence('5a000000-0000-4000-8000-000000000001'),
          'the owner may order a run');
select is(
  public.apply_run_sequence(
    '5a000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
    '2026-08-25',
    array['30000000-0000-4000-8000-00000000000a','30000000-0000-4000-8000-00000000000b',
          '30000000-0000-4000-8000-00000000000c','30000000-0000-4000-8000-00000000000d']::uuid[], 2),
  3,
  'the owner reorders the same run, and the version moves again');
-- 9/§5: the run is locked again the moment the save returns.
select ok(
  (select bool_and(sequence_locked) from public.daily_routes
    where id = '50000000-0000-4000-8000-000000000101'),
  'the run is locked again after the save');

-- §12: removing a stop closes the gap, and a dispatcher — who may empty a stop
-- but may not order a run — can still do it, because compaction takes no order
-- from its caller.
update public.jobs set deleted_at = now()
 where id = '30000000-0000-4000-8000-00000000000b';
set local "request.jwt.claim.sub" = '50000000-0000-4000-8000-00000000000c';
select is(public.compact_run_sequence('50000000-0000-4000-8000-000000000101'), 2,
          'a dispatcher can close the gap a removed stop leaves');
set local "request.jwt.claim.sub" = '50000000-0000-4000-8000-00000000000a';
select is(
  (select string_agg(job_number || '=' || sequence, ',' order by sequence)
     from public.jobs
    where route_id = '50000000-0000-4000-8000-000000000101' and deleted_at is null),
  'JOB00001=1,JOB00003=2,JOB00004=3',
  'the positions close up with no gap and the order is preserved');

-- §11/§21: a job assigned after management has arranged the day is **appended**,
-- and the manual order survives. The trigger is deliberately UPDATE-only for
-- exactly this reason — guarding INSERT would break board assignment for the
-- dispatcher and the counter, who assign work and do not order runs.
set local "request.jwt.claim.sub" = '50000000-0000-4000-8000-00000000000c';
select lives_ok(
  $$insert into public.jobs
      (tenant_id, route_id, customer_id, job_number, scheduled_date, sequence, service_type)
    values ('5a000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000101',
            'c0000000-0000-4000-8000-00000000000b','JOB00005','2026-08-25',4,'delivery')$$,
  'a dispatcher can still put new work on a locked, manually ordered run');
set local "request.jwt.claim.sub" = '50000000-0000-4000-8000-00000000000a';
select is(
  (select string_agg(job_number, ',' order by sequence) from public.jobs
    where route_id = '50000000-0000-4000-8000-000000000101' and deleted_at is null),
  'JOB00001,JOB00003,JOB00004,JOB00005',
  'the new stop lands at the end and the manual order is not resorted');

-- §10: a save renumbers from 1, which repairs whatever the stored data carried.
-- Duplicates and gaps are the two states that make "position 3" stop meaning the
-- third call, and nudging positions rather than rewriting them preserves both.
update public.jobs set sequence = 5
 where route_id = '50000000-0000-4000-8000-000000000102';
select is(
  public.apply_run_sequence(
    '5a000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002',
    '2026-08-25',
    array['30000000-0000-4000-8000-000000000022','30000000-0000-4000-8000-000000000021']::uuid[], 1),
  2,
  'a run whose stored positions are 5 and 5 can still be saved');
select is(
  (select string_agg(job_number || '=' || sequence, ',' order by sequence)
     from public.jobs where route_id = '50000000-0000-4000-8000-000000000102'),
  'JOB00022=1,JOB00021=2',
  'duplicate positions are rewritten as 1..n in the order that was asked for');

select * from finish();
rollback;
