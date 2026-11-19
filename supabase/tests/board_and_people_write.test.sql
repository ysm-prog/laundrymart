-- Proof for 0064: a round cannot take another round, and only the Owner changes
-- who is in the laundry.
--
-- Both holes were found as real sessions on the live project on 2026-11-19:
-- Board 2's login re-pointed Board 1 at itself and read all of Board 1's jobs,
-- and both Office-manager logins promoted themselves to Owner. Refusals are
-- asserted by **outcome** — a refused UPDATE under RLS matches zero rows and
-- raises nothing, so `lives_ok` would pass over the very hole. Each refused write
-- is read back afterwards from a session that can see the row.
--
-- And the other half, which is what keeps this from being a login that works and
-- shows nothing: a board still reads **its own** board row and its own job, and
-- the office still reads every board and can still change one.
begin;
select plan(18);

insert into auth.users (id, email) values
  ('c4000000-0000-0000-0000-000000000001','board1@example.com'),
  ('c4000000-0000-0000-0000-000000000002','board2@example.com'),
  ('c4000000-0000-0000-0000-00000000000a','owner@example.com'),
  ('c4000000-0000-0000-0000-00000000000b','manager@example.com'),
  ('c4000000-0000-0000-0000-00000000000c','newstarter@example.com');

insert into public.tenants (id, name) values
  ('c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A');

insert into public.memberships (user_id, tenant_id, role) values
  ('c4000000-0000-0000-0000-000000000001','c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','board'),
  ('c4000000-0000-0000-0000-000000000002','c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','board'),
  ('c4000000-0000-0000-0000-00000000000a','c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('c4000000-0000-0000-0000-00000000000b','c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','operations_manager');

insert into public.boards (id, tenant_id, user_id, code, name) values
  ('c4b00000-0000-0000-0000-000000000001','c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c4000000-0000-0000-0000-000000000001','BOARD1','Board 1'),
  ('c4b00000-0000-0000-0000-000000000002','c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c4000000-0000-0000-0000-000000000002','BOARD2','Board 2'),
  ('c4b00000-0000-0000-0000-000000000003','c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   null,'BOARD3','Board 3');

set local role authenticated;

-- ------------------------------------------------------------- Board 2 ------
set local "request.jwt.claim.sub" = 'c4000000-0000-0000-0000-000000000002';

select is((select count(*) from public.boards)::int, 1,
          'a board reads exactly one board row');
select is((select string_agg(code, ',') from public.boards), 'BOARD2',
          'and it is its own');
select is(public.current_board_id('c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          'c4b00000-0000-0000-0000-000000000002'::uuid,
          'current_board_id still resolves the board to its own round');

-- The takeover, as probed live: clear your own link, then claim another round.
update public.boards set user_id = null where code = 'BOARD2';
update public.boards set user_id = 'c4000000-0000-0000-0000-000000000002' where code = 'BOARD1';
update public.boards set status = 'inactive' where code = 'BOARD3';
select is(public.current_board_id('c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          'c4b00000-0000-0000-0000-000000000002'::uuid,
          'after trying to take Board 1, the board is still Board 2');

select throws_ok(
  $$insert into public.boards (tenant_id, code, name)
    values ('c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','BOARD9','Rogue')$$,
  '42501', null,
  'a board cannot create a board');

select throws_ok(
  $$insert into public.memberships (user_id, tenant_id, role)
    values ('c4000000-0000-0000-0000-000000000002','c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin')$$,
  '42501', null,
  'a board cannot add itself to the laundry as an Owner');

-- --------------------------------------------------------- read back -------
set local "request.jwt.claim.sub" = 'c4000000-0000-0000-0000-00000000000a';
select is((select user_id from public.boards where code = 'BOARD1'),
          'c4000000-0000-0000-0000-000000000001'::uuid,
          'Board 1 is still linked to its own login');
select is((select user_id from public.boards where code = 'BOARD2'),
          'c4000000-0000-0000-0000-000000000002'::uuid,
          'Board 2 did not manage to unlink itself either');
select is((select status from public.boards where code = 'BOARD3'), 'active',
          'and Board 3 was not retired');

-- ------------------------------------------------------ the Office manager --
set local "request.jwt.claim.sub" = 'c4000000-0000-0000-0000-00000000000b';

select is((select count(*) from public.boards)::int, 3,
          'the Office manager reads every board');
select is((select count(*) from public.memberships)::int, 4,
          'and still reads the people in the laundry');

update public.memberships set role = 'super_admin'
 where user_id = 'c4000000-0000-0000-0000-00000000000b';
delete from public.memberships
 where user_id = 'c4000000-0000-0000-0000-000000000001';

select throws_ok(
  $$insert into public.memberships (user_id, tenant_id, role)
    values ('c4000000-0000-0000-0000-000000000002','c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','operations_manager')$$,
  '42501', null,
  'the Office manager cannot add a member');

update public.boards set name = 'Board 3 (north)' where code = 'BOARD3';
select is((select name from public.boards where code = 'BOARD3'), 'Board 3 (north)',
          'the Office manager can still change a board — the write landed');

-- --------------------------------------------------------- read back -------
set local "request.jwt.claim.sub" = 'c4000000-0000-0000-0000-00000000000a';
select is((select role from public.memberships where user_id = 'c4000000-0000-0000-0000-00000000000b'),
          'operations_manager',
          'the Office manager did not promote themselves to Owner');
select is((select count(*) from public.memberships
            where user_id = 'c4000000-0000-0000-0000-000000000001')::int, 1,
          'and did not remove Board 1 from the laundry');

-- ----------------------------------------------------------------- Owner ----
update public.memberships set role = 'dispatcher'
 where user_id = 'c4000000-0000-0000-0000-00000000000b';
select is((select role from public.memberships where user_id = 'c4000000-0000-0000-0000-00000000000b'),
          'dispatcher',
          'the Owner can still change somebody''s role — the write landed');
select lives_ok(
  $$insert into public.memberships (user_id, tenant_id, role)
    values ('c4000000-0000-0000-0000-00000000000c','c4aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customer_service')$$,
  'the Owner can still add somebody to the laundry');
select is((select count(*) from public.boards)::int, 3,
          'and reads every board');

select finish();
rollback;
