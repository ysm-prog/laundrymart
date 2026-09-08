-- Proof: a customer's standing collection day is recorded on the customer, is
-- bounded by the database rather than by the form, and cannot name a round that
-- belongs to somebody else.
--
-- Three things are being defended.
--
-- The first is the **range**. `customers` is published on /rest/v1/customers, so
-- the weekday arrives from a browser as often as from a form. A 0 or an 8 stored
-- there is not an error anybody sees — it is a customer who is silently never
-- due, for ever, on a screen whose whole job is saying who is due today.
--
-- The second is the **round link**, which is a foreign reference written from a
-- form and therefore makes the three refusals every other such writer in this
-- schema makes (`sync_invoice_line_account` 0036, `guard_job_charge_account`
-- 0039, `guard_charge_type_account` 0044, `guard_supplier_expense_account` 0045):
-- not another laundry's row, not one that does not exist, not one retired.
--
-- The third is what is deliberately **allowed**, and it is the half a later
-- reader is most likely to "fix": a day with no round is legal. That is not an
-- incomplete schedule, it is exactly the *due, but nobody is going* list the
-- screen exists to show — so the two assertions below pin it as a decision.
begin;
select plan(16);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner-a@example.com'),
  ('22222222-2222-2222-2222-222222222222','owner-b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

-- One round in each laundry, plus one that has been retired, so every refusal
-- below is proved against a real row rather than a made-up uuid.
insert into public.boards (id, tenant_id, code, name) values
  ('b0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','BOARD1','Board 1'),
  ('b0000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','BOARD1','Their Board 1');
insert into public.boards (id, tenant_id, code, name, deleted_at) values
  ('b0000000-0000-0000-0000-00000000dead','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','OLD','Retired round', now());

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Hotel'),
  ('c0000000-0000-0000-0000-00000000000b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00002','Zink Hair'),
  ('c0000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Their Customer');

-- ================================================ the arrangement, as a session
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select lives_ok(
  $$update public.customers
       set collection_weekday = 2, collection_board_id = 'b0000000-0000-0000-0000-00000000000a'
     where id = 'c0000000-0000-0000-0000-00000000000a'$$,
  'a customer can be put on a standing Tuesday collection');

select is(
  (select collection_weekday from public.customers
    where id = 'c0000000-0000-0000-0000-00000000000a'), 2::smallint,
  'and the day is stored, not merely accepted');

-- The whole point of the column: one query answers "who is due today?".
select is(
  (select count(*)::int from public.customers
    where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and collection_weekday = 2), 1,
  'the due list is one filtered read');

-- ------------------------------------------------------------ the range ---
select throws_ok(
  $$update public.customers set collection_weekday = 0
     where id = 'c0000000-0000-0000-0000-00000000000b'$$,
  '23514', null,
  'day 0 is refused: ISO weekdays start at Monday = 1');

select throws_ok(
  $$update public.customers set collection_weekday = 8
     where id = 'c0000000-0000-0000-0000-00000000000b'$$,
  '23514', null,
  'day 8 is refused, so a customer cannot be silently never due');

select lives_ok(
  $$update public.customers set collection_weekday = 7
     where id = 'c0000000-0000-0000-0000-00000000000b'$$,
  'Sunday is a working day for a laundry, and 7 is it');

-- ------------------------------------------------------- the round link ---
select throws_ok(
  $$update public.customers set collection_board_id = 'b0000000-0000-0000-0000-0000000000bb'
     where id = 'c0000000-0000-0000-0000-00000000000b'$$,
  'that round belongs to another business',
  'another laundry''s round is refused, so a schedule cannot cross the boundary');

select throws_ok(
  $$update public.customers set collection_board_id = 'b0000000-0000-0000-0000-0000000000fe'
     where id = 'c0000000-0000-0000-0000-00000000000b'$$,
  'that round could not be found',
  'an id that is no round at all is refused');

select throws_ok(
  $$update public.customers set collection_board_id = 'b0000000-0000-0000-0000-00000000dead'
     where id = 'c0000000-0000-0000-0000-00000000000b'$$,
  'that round has been removed, so it cannot be given a collection day',
  'a retired round cannot be given new work');

-- ------------------------------------ what is deliberately still allowed ---
-- The state the screen exists to surface. Refusing it here would make the "due
-- but nobody is going" list unreachable — an owner would have to invent a round
-- before they could record that a customer is collected at all.
select is(
  (select collection_board_id from public.customers
    where id = 'c0000000-0000-0000-0000-00000000000b'), null::uuid,
  'a day with no round is a legal schedule, and is the list the office works from');

-- The reverse half is left to the application on purpose: a round with no day is
-- meaningless rather than dangerous, and a sentence on a form reads better than
-- a raise at the boundary.
select lives_ok(
  $$update public.customers set collection_board_id = 'b0000000-0000-0000-0000-00000000000a'
     where id = 'c0000000-0000-0000-0000-00000000000b'$$,
  'and the database does not police the meaningless half');

-- The guard fires only when the link changes, so ordinary edits to a scheduled
-- customer are never re-judged — which is what keeps history safe when the rules
-- change under it.
select lives_ok(
  $$update public.customers set phone = '08 1234 5678'
     where id = 'c0000000-0000-0000-0000-00000000000a'$$,
  'editing anything else on a scheduled customer does not re-judge the round');

-- --------------------------------------------------- retiring the round ---
-- `on delete set null`: retiring a board degrades the schedule to "no round yet"
-- rather than blocking the delete or dangling an id.
select lives_ok(
  $$delete from public.boards where id = 'b0000000-0000-0000-0000-00000000000a'$$,
  'a round can be deleted while customers are pointed at it');

select is(
  (select count(*)::int from public.customers
    where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and collection_weekday is not null and collection_board_id is null), 2,
  'and both customers stay due, with no round — the state the office must fix');

-- ------------------------------------------------------------- tenancy ---
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

select is(
  (select count(*)::int from public.customers where collection_weekday is not null), 0,
  'the other laundry sees none of it');

update public.customers set collection_weekday = 3
 where id = 'c0000000-0000-0000-0000-00000000000a';
select is(
  (select count(*)::int from public.customers
    where id = 'c0000000-0000-0000-0000-00000000000a' and collection_weekday = 3), 0,
  'and cannot set one — the write matches no row rather than raising');

select finish();
rollback;
