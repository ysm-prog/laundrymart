-- Proof: the fleet and the sites are read by the road and changed by the office.
--
-- Before `0049` all four of these tables carried 0002's single permissive
-- `for all … using is_member(tenant_id)` policy, so **every member of the
-- laundry could rewrite any of it** off `/rest/v1/…`. `roles.ts` gated the
-- screens and nothing gated the tables.
--
-- One of the four is not a disclosure at all. **`drivers.user_id` is the
-- driver-scoped RLS boundary**: `current_driver_id()` resolves the caller's
-- driver row by matching that column against `auth.uid()`, and the
-- `daily_routes` and `jobs` policies narrow a driver-only member to their own
-- `driver_id`. So a driver who could UPDATE `drivers` could point another
-- driver's row at their own login and inherit that driver's runs. That is the
-- escalation this file exists to close, and it is asserted twice — once that
-- the write touches nothing, and once that `current_driver_id()` still answers
-- with the caller's own row afterwards.
--
-- Two properties pull in opposite directions, which is why this file is not
-- symmetric:
--
--  1. **The road must still read.** A driver's own row is how `/run` answers
--     "which run is mine"; the run sheet and the plant's return count name the
--     van; the plant floor picks a depot. None of those roles holds
--     `fleet.read`, so most of the assertions below are that somebody **still
--     reads**, not that they are refused. Taking a read away is a login that
--     works and shows nothing — the failure this project shipped once already.
--  2. **Only the office may change it**, and the site is narrower still: adding
--     or retiring a depot is `admin.write`, because every site picker in the app
--     filters `status = 'active'` and one PATCH empties all seven of them.
--
-- **Refusals are asserted by outcome, not by `throws_ok`.** An UPDATE or DELETE
-- a policy's USING clause excludes matches **no rows and raises nothing at
-- all** — so an assertion waiting for 42501 would pass the moment the gate was
-- removed. Only INSERT is asserted the other way, because its WITH CHECK really
-- does raise.
begin;
select plan(27);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner-a@example.com'),
  ('33333333-3333-3333-3333-333333333333','board-a@example.com'),
  ('44444444-4444-4444-4444-444444444444','auditor-a@example.com'),
  ('55555555-5555-5555-5555-555555555555','dispatcher-a@example.com'),
  ('77777777-7777-7777-7777-777777777777','driver-a@example.com'),
  ('88888888-8888-8888-8888-888888888888','plant-a@example.com'),
  ('22222222-2222-2222-2222-222222222222','owner-b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','board'),
  ('44444444-4444-4444-4444-444444444444','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','auditor'),
  ('55555555-5555-5555-5555-555555555555','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dispatcher'),
  ('77777777-7777-7777-7777-777777777777','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('88888888-8888-8888-8888-888888888888','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','warehouse_operator'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.depots (id, tenant_id, code, name) values
  ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ADL','Adelaide');
insert into public.vehicles (id, tenant_id, depot_id, registration) values
  ('e0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'd0000000-0000-0000-0000-00000000000a','S123ABC');

-- Two driver rows: the caller's own, and somebody else's — the second is what a
-- driver would re-point at their own login if the table were still open.
insert into public.drivers (id, tenant_id, user_id, full_name) values
  ('f0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '77777777-7777-7777-7777-777777777777','Sam Okoye'),
  ('f0000000-0000-0000-0000-00000000000b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   null,'Mario Forte');

insert into public.fuel_logs (id, tenant_id, vehicle_id, litres, cost) values
  ('a1000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'e0000000-0000-0000-0000-00000000000a', 62.5, 118.40);

-- ================================================= the road still has its facts
set local role authenticated;
set local "request.jwt.claim.sub" = '77777777-7777-7777-7777-777777777777';

-- The decisive one. `/run` reads this exact row to decide whether to show the
-- day's work or "your login is not linked to a driver yet", and a driver holds
-- no `fleet.read` whatever.
select is(
  (select full_name from public.drivers where user_id = '77777777-7777-7777-7777-777777777777'),
  'Sam Okoye', 'a driver reads their own driver row — the question /run asks');

select is(
  (select public.current_driver_id('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')),
  'f0000000-0000-0000-0000-00000000000a'::uuid,
  'so their runs and stops still resolve to them');

set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
select is(
  (select registration from public.vehicles where id = 'e0000000-0000-0000-0000-00000000000a'),
  'S123ABC', 'a board reads the van on its run sheet');

set local "request.jwt.claim.sub" = '88888888-8888-8888-8888-888888888888';
select is(
  (select name from public.depots where id = 'd0000000-0000-0000-0000-00000000000a'),
  'Adelaide', 'the plant floor reads the depot it picks stock into');

select is(
  (select registration from public.vehicles where id = 'e0000000-0000-0000-0000-00000000000a'),
  'S123ABC', 'and the registration its return count is embedded with');

-- ---------------------------------------------------- and changes none of it
-- Every write below is against a row the session has **just read back**, so a
-- count of 0 can only mean refused and never "no such row" — the distinction
-- that made an earlier probe in this repo report a pass it had not earned.
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';

update public.depots set name = 'PROBE'
 where id = 'd0000000-0000-0000-0000-00000000000a';
select is(
  (select name from public.depots where id = 'd0000000-0000-0000-0000-00000000000a'),
  'Adelaide', 'a board cannot rename the depot — the write matches no row rather than raising');

update public.depots set status = 'inactive'
 where id = 'd0000000-0000-0000-0000-00000000000a';
select is(
  (select status from public.depots where id = 'd0000000-0000-0000-0000-00000000000a'),
  'active', 'nor retire it, which would empty every site picker in the app');

delete from public.depots where id = 'd0000000-0000-0000-0000-00000000000a';
select is(
  (select count(*)::int from public.depots where id = 'd0000000-0000-0000-0000-00000000000a'), 1,
  'nor delete it outright');

update public.vehicles set maintenance_status = 'out_of_service', registration = 'PROBE'
 where id = 'e0000000-0000-0000-0000-00000000000a';
select is(
  (select registration || ' / ' || maintenance_status from public.vehicles
    where id = 'e0000000-0000-0000-0000-00000000000a'),
  'S123ABC / ok', 'nor take a van off the road');

select throws_ok(
  $$insert into public.vehicles (tenant_id, registration) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','S999ZZZ')$$,
  '42501', null,
  'and an insert is refused out loud, because a WITH CHECK really does raise');

select is(
  (select count(*)::int from public.fuel_logs), 0,
  'a board reads no fuel log — the litres and the cost this closes');

select throws_ok(
  $$insert into public.fuel_logs (tenant_id, vehicle_id, litres, cost) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','e0000000-0000-0000-0000-00000000000a',10,20)$$,
  '42501', null, 'nor write one');

-- ------------------------------------------------------------ the escalation
-- The reason this migration is not merely tidiness. Pointing another driver's
-- row at your own login is how you inherit their runs, because that column is
-- what `current_driver_id()` matches on.
set local "request.jwt.claim.sub" = '77777777-7777-7777-7777-777777777777';
update public.drivers set user_id = '77777777-7777-7777-7777-777777777777'
 where id = 'f0000000-0000-0000-0000-00000000000b';
select is(
  (select user_id from public.drivers where id = 'f0000000-0000-0000-0000-00000000000b'),
  null, 'a driver cannot point another driver''s row at their own login');

select is(
  (select public.current_driver_id('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')),
  'f0000000-0000-0000-0000-00000000000a'::uuid,
  'so the driver-scoped policies still resolve to their own runs and nobody else''s');

-- ================================================ the office can still work ==
-- The half that matters as much as the refusals: a gate that locks out the
-- roles that should hold it is a worse outcome than the hole it closed.
set local "request.jwt.claim.sub" = '55555555-5555-5555-5555-555555555555';

update public.vehicles set maintenance_status = 'due'
 where id = 'e0000000-0000-0000-0000-00000000000a';
select is(
  (select maintenance_status from public.vehicles where id = 'e0000000-0000-0000-0000-00000000000a'),
  'due', 'a dispatcher may still book a van in for a service');

update public.drivers set status = 'on_leave' where id = 'f0000000-0000-0000-0000-00000000000b';
select is(
  (select status from public.drivers where id = 'f0000000-0000-0000-0000-00000000000b'),
  'on_leave', 'and mark a driver on leave');

select lives_ok(
  $$insert into public.fuel_logs (tenant_id, vehicle_id, litres, cost) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','e0000000-0000-0000-0000-00000000000a',40,88)$$,
  'and log a tank of fuel');

select is(
  (select count(*)::int from public.fuel_logs), 2,
  'and read the fleet''s fuel back, which is what fleet.read is for');

-- ------------------------------------------------- the site is the owner's --
-- Narrower than the fleet on purpose, and the same gate `/admin/depots` has
-- always carried. Asserted in both directions, because a gate nobody holds and
-- a gate everybody holds fail in opposite ways.
select throws_ok(
  $$insert into public.depots (tenant_id, code, name) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','SYD','Sydney')$$,
  '42501', null, 'a dispatcher may not add a site');

set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select lives_ok(
  $$insert into public.depots (tenant_id, code, name) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','SYD','Sydney')$$,
  'the owner may');

update public.depots set name = 'Adelaide depot'
 where id = 'd0000000-0000-0000-0000-00000000000a';
select is(
  (select name from public.depots where id = 'd0000000-0000-0000-0000-00000000000a'),
  'Adelaide depot', 'and rename one');

-- The database half of `linkDriverLogin`, which the app gates on `admin.write`
-- while the table gates on `fleet.write`. `admin.write` is a strict subset, so
-- this lands — and if those two role lists ever part company it would instead
-- write **zero rows in silence** and the driver would be told for ever that
-- their login is not linked. `fleet-write-gate.test.ts` pins the containment.
update public.drivers set user_id = '88888888-8888-8888-8888-888888888888'
 where id = 'f0000000-0000-0000-0000-00000000000b';
select is(
  (select user_id from public.drivers where id = 'f0000000-0000-0000-0000-00000000000b'),
  '88888888-8888-8888-8888-888888888888'::uuid,
  'the owner links a login to a driver — what makes "see only your own run" work');

-- --------------------------------------------------------------- the auditor
-- Read and write are two role lists precisely because of this one.
set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';
select is(
  (select count(*)::int from public.fuel_logs), 2, 'the auditor reads the fuel logs');

update public.vehicles set maintenance_status = 'out_of_service'
 where id = 'e0000000-0000-0000-0000-00000000000a';
select is(
  (select maintenance_status from public.vehicles where id = 'e0000000-0000-0000-0000-00000000000a'),
  'due', 'and changes nothing');

-- ================================================================ tenancy ===
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is(
  (select count(*)::int from public.drivers), 0, 'the other laundry sees none of the drivers');
select is(
  (select count(*)::int from public.vehicles), 0, 'nor the vans');
select is(
  (select count(*)::int from public.depots), 0, 'nor the sites');

select finish();
rollback;
