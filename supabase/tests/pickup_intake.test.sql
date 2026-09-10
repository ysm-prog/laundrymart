-- Proof: a collection becomes a laundry job exactly once, for the customer it
-- was collected from, and cancelling the job releases it again.
--
-- Three things are being defended, and the first is the reason the column exists
-- at all rather than a screen simply remembering.
--
-- **Taken in once.** Since 0040 an approved job's charges land on the customer's
-- *running* monthly draft and merge into one line per item — so a collection
-- taken in twice does not show up as two entries anybody could spot. It shows up
-- as a quantity that is quietly double. A screen that looks first is a race: two
-- counter hands with the same list open both find nothing and both save.
--
-- **The same customer's collection.** `source_pickup_id` and `customer_id` are
-- two facts that can disagree, and a job pointing at somebody else's collection
-- would put one customer's linen on another's invoice with nothing on either
-- screen showing it. That is the integrity rule the guard exists for.
--
-- **Cancelling releases it.** A job taken in against the wrong customer is
-- cancelled, and the collection is then still sitting there needing to be taken
-- in. The index is partial for exactly this, the same shape
-- `uq_invoice_source_jobs_once` uses so voiding an invoice releases its jobs —
-- and it is the half a later reader is most likely to "tidy up" into a plain
-- unique constraint, which would strand the collection for ever.
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

-- Two customers in laundry A, so "a different customer" is proved inside one
-- laundry: across two, RLS would refuse the read long before the guard is asked
-- and the assertion would prove nothing about the guard.
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Hotel'),
  ('c0000000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00002','Zink Hair'),
  ('c0000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Their Customer');

insert into public.jobs (id, tenant_id, customer_id, job_number, scheduled_date, service_type) values
  ('50000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','JOB00001', current_date, 'pickup'),
  ('50000000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000c','JOB00002', current_date, 'pickup'),
  ('50000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'c0000000-0000-0000-0000-0000000000bb','JOB00001', current_date, 'pickup');

-- One collection per stop: the hotel's, another customer's in the same laundry,
-- and one belonging to the other business entirely.
insert into public.pickups (id, tenant_id, job_id, customer_id, bag_count) values
  ('60000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-00000000000a','c0000000-0000-0000-0000-00000000000a', 3),
  ('60000000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '50000000-0000-0000-0000-00000000000c','c0000000-0000-0000-0000-00000000000c', 1),
  ('60000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '50000000-0000-0000-0000-0000000000bb','c0000000-0000-0000-0000-0000000000bb', 2);

-- ================================================ taken in, as a real session
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select lives_ok(
  $$insert into public.laundry_orders
      (id, tenant_id, customer_id, order_number, source_pickup_id)
    values ('a0000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'c0000000-0000-0000-0000-00000000000a','LJ00001',
            '60000000-0000-0000-0000-00000000000a')$$,
  'a collection can be taken in as a laundry job');

select is(
  (select source_pickup_id from public.laundry_orders
    where id = 'a0000000-0000-0000-0000-000000000001'),
  '60000000-0000-0000-0000-00000000000a'::uuid,
  'and the job records which collection it came from, not merely that it was taken in');

-- The reverse lookup the Collections list runs for a whole page of collections:
-- "which of these are already on a job?" is one filtered read, not one per row.
select is(
  (select count(*)::int from public.laundry_orders
    where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and source_pickup_id = '60000000-0000-0000-0000-00000000000a'
      and status <> 'cancelled'), 1,
  'and "has this been taken in?" is answered by one filtered read');

-- ------------------------------------------------------------ taken in once ---
select throws_ok(
  $$insert into public.laundry_orders
      (tenant_id, customer_id, order_number, source_pickup_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a',
            'LJ00002','60000000-0000-0000-0000-00000000000a')$$,
  'P0001', null,
  'the same collection cannot be taken in twice');

select throws_like(
  $$insert into public.laundry_orders
      (tenant_id, customer_id, order_number, source_pickup_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a',
            'LJ00002','60000000-0000-0000-0000-00000000000a')$$,
  '%LJ00001%',
  'and the refusal names the job it is already on, not a constraint');

-- ------------------------------------------------------- whose collection ---
select throws_ok(
  $$insert into public.laundry_orders
      (tenant_id, customer_id, order_number, source_pickup_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a',
            'LJ00003','60000000-0000-0000-0000-00000000000c')$$,
  'P0001', 'that collection was from a different customer, so it cannot be taken in on this job',
  'a collection from another customer is refused: it would bill one customer for another''s linen');

select throws_ok(
  $$insert into public.laundry_orders
      (tenant_id, customer_id, order_number, source_pickup_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a',
            'LJ00003','60000000-0000-0000-0000-0000000000bb')$$,
  'P0001', 'that collection belongs to another business',
  'another laundry''s collection is refused by the guard, not merely hidden by RLS');

select throws_ok(
  $$insert into public.laundry_orders
      (tenant_id, customer_id, order_number, source_pickup_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a',
            'LJ00003','60000000-0000-0000-0000-00000000dead')$$,
  'P0001', 'that collection could not be found',
  'a collection that does not exist is refused');

-- ------------------------------------------------- cancelling releases it ---
-- The whole reason the index is partial. A job taken in by mistake is cancelled,
-- and the collection is still sitting there needing to be taken in.
select lives_ok(
  $$update public.laundry_orders set status = 'cancelled', cancellation_reason = 'wrong customer'
     where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'the job taken in by mistake can be cancelled');

select lives_ok(
  $$insert into public.laundry_orders
      (id, tenant_id, customer_id, order_number, source_pickup_id)
    values ('a0000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'c0000000-0000-0000-0000-00000000000a','LJ00004',
            '60000000-0000-0000-0000-00000000000a')$$,
  'and the collection can then be taken in again — cancelling releases the work');

select is(
  (select count(*)::int from public.laundry_orders
    where source_pickup_id = '60000000-0000-0000-0000-00000000000a' and status <> 'cancelled'), 1,
  'leaving exactly one live job on that collection, and the cancelled one as history');

-- ------------------------------------------- an ordinary job is untouched ---
-- The claim this whole migration rests on: a job typed at the counter behaves
-- exactly as it did before, because the guard returns immediately on a null.
select lives_ok(
  $$insert into public.laundry_orders (id, tenant_id, customer_id, order_number)
    values ('a0000000-0000-0000-0000-000000000003','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'c0000000-0000-0000-0000-00000000000c','LJ00005')$$,
  'a job typed at the counter still saves with no collection behind it');

select is(
  (select source_pickup_id from public.laundry_orders
    where id = 'a0000000-0000-0000-0000-000000000003'), null::uuid,
  'and reads as not taken in from a collection, which is what every existing job reads');

-- An update that does not touch the link is not re-judged. Without the guard's
-- early return, every status change on a job carrying a collection would re-run
-- the whole check — and a collection since archived would then make the job
-- unmovable, on a screen with no way to explain why.
select lives_ok(
  $$update public.laundry_orders set priority = 'urgent'
     where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'a change that does not touch the collection link is not re-judged');

select throws_ok(
  $$update public.laundry_orders set source_pickup_id = '60000000-0000-0000-0000-0000000000bb'
     where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'P0001', 'that collection belongs to another business',
  'and moving a job onto another laundry''s collection is refused on the update path too');

-- ------------------------------------------------------------- tenancy ---
-- The new column is a second way to reach a job, so the boundary is re-asserted
-- over it rather than assumed from the policies it inherited.
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is(
  (select count(*)::int from public.laundry_orders
    where source_pickup_id = '60000000-0000-0000-0000-00000000000a'), 0,
  'the other laundry cannot read a job through the collection link either');

select * from finish();
rollback;
