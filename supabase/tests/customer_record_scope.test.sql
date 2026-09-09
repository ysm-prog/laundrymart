-- Proof: a customer's record is read by the round and changed by the office.
--
-- Before `0048` all three of these tables carried 0002's single permissive
-- `for all … using is_member(tenant_id)` policy, so **every member of the
-- laundry could rewrite any of it** off `/rest/v1/…` — proved as one of
-- Adelaide's own `board` logins, which renamed a customer, rewrote a site's
-- address and access notes, deleted the site, and rewrote all 471 contact
-- emails in a single statement. `roles.ts` gated the screens and nothing gated
-- the tables.
--
-- Two properties are being defended and they pull in opposite directions, which
-- is the whole reason this file exists rather than a symmetric one:
--
--  1. **A round must still read.** The business name, the phone, the standing
--     instructions, the address and `access_notes` are its run sheet. Taking
--     that away is a login that works and shows nothing — the failure this
--     project shipped once already, and one that looks like a broken app rather
--     than a refusal. So most of the assertions below are that a **board still
--     reads**, not that it is refused.
--  2. **Only the office may change it.** And `customer_contacts` narrows on
--     both verbs, because exactly one screen reads it and that screen is
--     already gated on `customers.read`.
--
-- **Refusals are asserted by outcome, not by `throws_ok`.** An UPDATE or DELETE
-- a policy's USING clause excludes matches **no rows and raises nothing at
-- all** — so an assertion waiting for 42501 would pass the moment the gate was
-- removed. That is the silent-zero-rows failure this repo has shipped twice.
-- Only INSERT is asserted the other way, because its WITH CHECK really does
-- raise.
begin;
select plan(21);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner-a@example.com'),
  ('33333333-3333-3333-3333-333333333333','board-a@example.com'),
  ('44444444-4444-4444-4444-444444444444','auditor-a@example.com'),
  ('55555555-5555-5555-5555-555555555555','dispatcher-a@example.com'),
  ('66666666-6666-6666-6666-666666666666','counter-a@example.com'),
  ('22222222-2222-2222-2222-222222222222','owner-b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','board'),
  ('44444444-4444-4444-4444-444444444444','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','auditor'),
  ('55555555-5555-5555-5555-555555555555','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dispatcher'),
  ('66666666-6666-6666-6666-666666666666','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customer_service'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.customers (id, tenant_id, customer_number, business_name, special_instructions) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'CUST00001','ABC Hotel','Gate code 1234'),
  ('c0000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'CUST00001','Their Customer', null);
insert into public.customer_locations
    (id, tenant_id, customer_id, name, address_line1, access_notes) values
  ('10000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','Main site','1 Wharf Road','Side door, ring twice');
insert into public.customer_contacts (id, tenant_id, customer_id, name, email) values
  ('20000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','Priya Nair','priya@abchotel.example');

-- ============================================== the round still has a run sheet
set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';

select is(
  (select business_name from public.customers where id = 'c0000000-0000-0000-0000-00000000000a'),
  'ABC Hotel', 'a board reads the customer it is delivering to');

select is(
  (select special_instructions from public.customers where id = 'c0000000-0000-0000-0000-00000000000a'),
  'Gate code 1234', 'and the standing instructions it is meant to act on');

select is(
  (select address_line1 from public.customer_locations where id = '10000000-0000-0000-0000-00000000000a'),
  '1 Wharf Road', 'and the address the van drives to');

select is(
  (select access_notes from public.customer_locations where id = '10000000-0000-0000-0000-00000000000a'),
  'Side door, ring twice', 'and the note saying which door to use');

-- ------------------------------------------------ and cannot change any of it
-- Every write below is against a row this session has **just read back**, so a
-- count of 0 can only mean refused and never "no such row" — the distinction
-- that made an earlier probe in this repo report a pass it had not earned.
update public.customers set business_name = 'PROBE'
 where id = 'c0000000-0000-0000-0000-00000000000a';
select is(
  (select business_name from public.customers where id = 'c0000000-0000-0000-0000-00000000000a'),
  'ABC Hotel', 'a board cannot rename a customer — the write matches no row rather than raising');

update public.customers set special_instructions = 'PROBE'
 where id = 'c0000000-0000-0000-0000-00000000000a';
select is(
  (select special_instructions from public.customers where id = 'c0000000-0000-0000-0000-00000000000a'),
  'Gate code 1234', 'nor rewrite the instructions the next round would act on');

update public.customer_locations set access_notes = 'PROBE', address_line1 = 'PROBE'
 where id = '10000000-0000-0000-0000-00000000000a';
select is(
  (select address_line1 || ' / ' || access_notes from public.customer_locations
    where id = '10000000-0000-0000-0000-00000000000a'),
  '1 Wharf Road / Side door, ring twice',
  'nor send the van to a different door — the sharpest of the five');

delete from public.customer_locations where id = '10000000-0000-0000-0000-00000000000a';
select is(
  (select count(*)::int from public.customer_locations
    where id = '10000000-0000-0000-0000-00000000000a'), 1,
  'nor delete the site outright');

select throws_ok(
  $$insert into public.customers (tenant_id, customer_number, business_name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST09999','Invented')$$,
  '42501', null,
  'and an insert is refused out loud, because a WITH CHECK really does raise');

-- ------------------------------------------- the contacts are not its business
select is(
  (select count(*)::int from public.customer_contacts), 0,
  'a board reads no contact at all — the 471-email read this closes');

update public.customer_contacts set email = 'probe@example.com';

-- **Read back as the owner, and the first draft of this file got it wrong.**
-- Checking as the board itself returns NULL — it cannot see the row — so the
-- assertion would have passed just as happily over a policy that let the write
-- through. The same trap `charge_accounts.test.sql` records one table over.
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select is(
  (select email from public.customer_contacts where id = '20000000-0000-0000-0000-00000000000a'),
  'priya@abchotel.example', 'and cannot rewrite one it cannot see');

-- ================================================ the office can still work ==
-- The half that matters as much as the refusals: a gate that locks out the
-- roles that should hold it is a worse outcome than the hole it closed.
set local "request.jwt.claim.sub" = '55555555-5555-5555-5555-555555555555';
update public.customers set business_name = 'ABC Hotel Group'
 where id = 'c0000000-0000-0000-0000-00000000000a';
select is(
  (select business_name from public.customers where id = 'c0000000-0000-0000-0000-00000000000a'),
  'ABC Hotel Group', 'a dispatcher may still rename a customer');

update public.customer_locations set access_notes = 'Loading bay round the back'
 where id = '10000000-0000-0000-0000-00000000000a';
select is(
  (select access_notes from public.customer_locations where id = '10000000-0000-0000-0000-00000000000a'),
  'Loading bay round the back', 'and correct the access notes');

set local "request.jwt.claim.sub" = '66666666-6666-6666-6666-666666666666';
select lives_ok(
  $$insert into public.customers (tenant_id, customer_number, business_name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00002','Walk-in Cafe')$$,
  'the counter may take a new customer on — the role the screen is named for');

select lives_ok(
  $$insert into public.customer_contacts (tenant_id, customer_id, name, email)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a',
            'Sam Okoye','sam@abchotel.example')$$,
  'and add a contact to one');

-- --------------------------------------------------------------- the auditor
-- Read and write are two role lists precisely because of this one.
set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';
select is(
  (select count(*)::int from public.customer_contacts), 2,
  'the auditor reads the contacts');

update public.customers set business_name = 'PROBE'
 where id = 'c0000000-0000-0000-0000-00000000000a';
select is(
  (select business_name from public.customers where id = 'c0000000-0000-0000-0000-00000000000a'),
  'ABC Hotel Group', 'and changes nothing');

-- ================================================================ tenancy ===
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is(
  (select count(*)::int from public.customers
    where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 0,
  'the other laundry sees none of it');
select is(
  (select count(*)::int from public.customer_locations), 0,
  'nor any of its sites');

-- ========================================================= the 0028 trap ====
-- All three tables are in `archivable_tables()`. A policy written without
-- 0017's clause would make an archived customer readable again, and it would
-- read as this migration working.
set local role postgres;
update public.customers set archived_at = now()
 where id = 'c0000000-0000-0000-0000-00000000000a';
update public.customer_locations set archived_at = now()
 where id = '10000000-0000-0000-0000-00000000000a';

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select is(
  (select count(*)::int from public.customers where id = 'c0000000-0000-0000-0000-00000000000a'), 0,
  'an archived customer is hidden from the owner, as it was before 0048');
select is(
  (select count(*)::int from public.customer_locations), 0,
  'and so is their site');

select finish();
rollback;
