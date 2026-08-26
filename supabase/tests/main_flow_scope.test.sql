-- Proof for 0025: the job→invoice flow is writable by the Owner and the Office
-- manager, and by nobody else — enforced in the database, not just the screens.
--
-- The app already refuses to *show* the flow to anyone else. This asserts the
-- layer underneath: a warehouse operator holding a real login and talking
-- straight to PostgREST still cannot move a job or touch an invoice.
begin;
select plan(28);

insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666666','driver@example.com'),
  ('11111111-1111-1111-1111-111111111111','owner@example.com'),
  ('22222222-2222-2222-2222-222222222222','office@example.com'),
  ('33333333-3333-3333-3333-333333333333','floor@example.com'),
  ('44444444-4444-4444-4444-444444444444','counter@example.com'),
  ('55555555-5555-5555-5555-555555555555','money@example.com');

insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A');

insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','operations_manager'),
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','warehouse_operator'),
  ('44444444-4444-4444-4444-444444444444','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customer_service'),
  ('55555555-5555-5555-5555-555555555555','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','finance'),
  -- Since 0031 the round is the operational actor, so this is the role whose
  -- carve-out matters. A `driver` membership still exists and is still scoped
  -- the same way; it is simply no longer what work is assigned to.
  ('66666666-6666-6666-6666-666666666666','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','board');

insert into public.boards (id, tenant_id, user_id, code, name) values
  ('66660000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '66666666-6666-6666-6666-666666666666','BOARD1','Board 1');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Cafe A');

insert into public.laundry_orders (id, tenant_id, customer_id, order_number, received_at)
values ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'c0000000-0000-0000-0000-00000000000a','LJ00001', now());

insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, received_at, status,
   delivery_required, expected_delivery_date, assigned_board_id, assigned_delivery_date)
values ('d0000000-0000-0000-0000-00000000000b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'c0000000-0000-0000-0000-00000000000a','LJ00002', now(), 'out_for_delivery',
        true, current_date, '66660000-0000-0000-0000-00000000000a', current_date);

insert into public.invoices (id, tenant_id, customer_id, invoice_number) values
  ('e0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','INV00001');

-- One item on the master list, so "the floor can still read it" below is a
-- statement about the policy rather than about an empty table.
insert into public.items (id, tenant_id, sku, item_code, name) values
  ('11110000-0000-0000-0000-0000000000f1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'BT-WHT-01','TOW001','Bath Towel');

set local role authenticated;

-- ------------------------------------------------------- the two who may ----
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select lives_ok(
  $$ update public.laundry_orders set priority = 'urgent'
      where id = 'd0000000-0000-0000-0000-00000000000a' $$,
  'owner can change a job');
select lives_ok(
  $$ update public.invoices set purchase_order_number = 'PO-1'
      where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'owner can change an invoice');

set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select lives_ok(
  $$ update public.laundry_orders set priority = 'normal'
      where id = 'd0000000-0000-0000-0000-00000000000a' $$,
  'office manager can change a job');
select lives_ok(
  $$ insert into public.laundry_order_items
       (tenant_id, order_id, item_type, quantity_type, exact_quantity)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'd0000000-0000-0000-0000-00000000000a','towels','exact',3) $$,
  'office manager can add laundry to a job');
select lives_ok(
  $$ update public.invoices set purchase_order_number = 'PO-2'
      where id = 'e0000000-0000-0000-0000-00000000000a' $$,
  'office manager can change an invoice');

-- ------------------------------------------------------ the plant floor -----
-- The role that used to hold `orders.status`. A restrictive policy returns no
-- rows for an UPDATE rather than raising, so the count is the assertion: the
-- statement is allowed to run and changes nothing.
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';

update public.laundry_orders set status = 'in_progress'
 where id = 'd0000000-0000-0000-0000-00000000000a';
select is(
  (select status from public.laundry_orders
    where id = 'd0000000-0000-0000-0000-00000000000a'), 'new',
  'the floor cannot advance a job, even straight through the API');

select throws_ok(
  $$ insert into public.laundry_orders
       (tenant_id, customer_id, order_number, received_at)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'c0000000-0000-0000-0000-00000000000a','LJ09999', now()) $$,
  '42501', null, 'the floor cannot take a job in');

select throws_ok(
  $$ insert into public.laundry_order_items
       (tenant_id, order_id, item_type, quantity_type, exact_quantity)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'd0000000-0000-0000-0000-00000000000a','sheets','exact',1) $$,
  '42501', null, 'the floor cannot add laundry to a job');

-- Its own work is untouched: this is a restriction on the main flow, not a
-- demotion of the role.
--
-- **This assertion used to say the floor could INSERT an item, and that was a
-- proof defending a hole.** `roles.ts` has never given `warehouse_operator`
-- `items.write` — it holds `items.read` — so the statement succeeded only
-- because `items` carried 0002's permissive `for all` and nothing gated the
-- table. It read as "the floor still runs its own screens" while actually
-- asserting that a plant hand could rewrite the master list every price, charge
-- and invoice line resolves through. `0040` closes that, and this is rewritten
-- to the decision rather than satisfied — the third time this repo has had to
-- do that, after `laundry_pricing.test.sql` in 0033.
--
-- What the floor's screens genuinely need from `items` is the **read**, which
-- 0040 deliberately leaves alone.
select is((select count(*) from public.items)::int, 1,
          'the floor still reads the item master its screens list');
select throws_ok(
  $$ insert into public.items (tenant_id, sku, name)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','SKU-1','Bath Towel') $$,
  '42501', null,
  'but it cannot add to the master list, which is the Owner''s and the Office manager''s');

-- ---------------------------------------------------------- the counter -----
-- **Reversed on 2026-08-24** (0034). This asserted that the counter could not
-- take a job in, which was true and was the problem: a laundry wanting counter
-- staff to book jobs had to make them Office manager — 31 screens, the whole
-- ledger, the plant and the activity log — to do the one job the role is named
-- for.
--
-- Every assertion below checks the **outcome**, not that the statement failed
-- to raise. A restrictive policy refusing an UPDATE does not throw: it matches
-- zero rows and returns quietly, so `lives_ok` alone passes just as happily
-- against a counter who can change nothing. That is precisely the bug 0025
-- shipped for the driver and 0031 shipped again for the board, and it is why
-- `roles.ts` alone would have been worse than useless here.
set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';

select lives_ok(
  $$ insert into public.laundry_orders
       (tenant_id, customer_id, order_number, received_at)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'c0000000-0000-0000-0000-00000000000a','LJ09998', now()) $$,
  'the counter can take a job in');

select is(
  (select count(*)::int from public.laundry_orders where order_number = 'LJ09998'),
  1, 'and the job is really there — the insert was not silently refused');

select lives_ok(
  $$ insert into public.laundry_order_items (tenant_id, order_id, item_type, exact_quantity)
     select tenant_id, id, 'towels', 12 from public.laundry_orders
      where order_number = 'LJ09998' $$,
  'the counter can itemise it');

select is(
  (select count(*)::int from public.laundry_order_items i
     join public.laundry_orders o on o.id = i.order_id
    where o.order_number = 'LJ09998'),
  1, 'and the laundry is really on it');

-- The verb that fails silently, asserted by outcome.
update public.laundry_orders set special_instructions = 'No starch'
 where order_number = 'LJ09998';
select is(
  (select special_instructions from public.laundry_orders where order_number = 'LJ09998'),
  'No starch', 'and an edit lands rather than touching zero rows');

select lives_ok(
  $$ update public.customers set trading_name = 'Cafe A Pty'
      where id = 'c0000000-0000-0000-0000-00000000000a' $$,
  'the counter still keeps the customer record');

-- Money did not travel with it. 0034 widens three tables and leaves 0025's
-- other six alone, so the counter can take laundry in and cannot raise, alter
-- or even re-price a bill for it.
update public.invoices set purchase_order_number = 'PO-COUNTER'
 where id = 'e0000000-0000-0000-0000-00000000000a';

select is(
  (select count(*)::int from public.invoices), 0,
  'the counter cannot even read an invoice');

-- Read back as the owner, not as the counter. Asserting the value from inside
-- the counter's own session would compare NULL against 'PO-2' — the row is
-- invisible to them — and pass or fail for the wrong reason. This is the check
-- that the UPDATE above touched nothing.
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select is(
  (select purchase_order_number from public.invoices
    where id = 'e0000000-0000-0000-0000-00000000000a'), 'PO-2',
  'and the update it attempted changed nothing');

-- The counter cannot delete a job — only its items, which is what the atomic
-- child-set replace needs. Asserted by outcome, since a refused DELETE is as
-- quiet as a refused UPDATE.
set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';
delete from public.laundry_orders where order_number = 'LJ09998';
select is(
  (select count(*)::int from public.laundry_orders where order_number = 'LJ09998'),
  1, 'the counter cannot delete a job, only take one in and correct it');

select lives_ok(
  $$ delete from public.laundry_order_items i
      using public.laundry_orders o
      where o.id = i.order_id and o.order_number = 'LJ09998' $$,
  'but it can replace the laundry on one');
select is(
  (select count(*)::int from public.laundry_order_items i
     join public.laundry_orders o on o.id = i.order_id
    where o.order_number = 'LJ09998'),
  0, 'and that delete really lands — save_laundry_order_items needs it');

-- Put the fixture back, as the owner, so every assertion after this section
-- counts what it counted before the counter was let in here.
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
delete from public.laundry_orders where order_number = 'LJ09998';

-- ------------------------------------------------------------- finance ------
-- Loses the receivable side and keeps the payable one. `laundry_prices` counts
-- as billing, so it goes with the invoices.
set local "request.jwt.claim.sub" = '55555555-5555-5555-5555-555555555555';

update public.invoices set purchase_order_number = 'PO-SNEAK'
 where id = 'e0000000-0000-0000-0000-00000000000a';
select is(
  (select purchase_order_number from public.invoices
    where id = 'e0000000-0000-0000-0000-00000000000a'), 'PO-2',
  'finance cannot change an invoice through the API');

select throws_ok(
  $$ insert into public.invoice_lines
       (tenant_id, invoice_id, description, quantity, unit_price, amount)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'e0000000-0000-0000-0000-00000000000a','Sneaky',1,1.00,1.00) $$,
  '42501', null, 'finance cannot add an invoice line');

select throws_ok(
  $$ insert into public.laundry_prices (tenant_id, item_type, unit_price)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','towels',5.00) $$,
  '42501', null, 'finance cannot set the laundry price list');

-- ----------------------------------------------------------- the board -----
-- The carve-out that keeps the app working. A round finishing a delivery writes
-- to `laundry_orders` — that is what completeLaundryOrder does — and without
-- this clause the update is refused silently and the job sits at
-- `out_for_delivery` for ever. Executing your own run is not working the
-- office's flow.
set local "request.jwt.claim.sub" = '66666666-6666-6666-6666-666666666666';

update public.laundry_orders set status = 'completed'
 where id = 'd0000000-0000-0000-0000-00000000000b';
select is(
  (select status from public.laundry_orders
    where id = 'd0000000-0000-0000-0000-00000000000b'), 'completed',
  'a board can finish the delivery assigned to it');

-- And no further than that: a job that is not this round's is not even visible,
-- so the carve-out cannot be turned into a way round the restriction.
select is((select count(*) from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a')::int, 0,
          'a board cannot see, let alone change, a job that is not on its round');

-- ------------------------------------------------------ reading is open -----
-- Deliberately not restricted: a round must be able to read the job it is
-- delivering, and the app is what decides who is shown the screens.
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
select is((select count(*) from public.laundry_orders)::int, 2,
          'the floor can still read jobs — SELECT is deliberately not restricted');

set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is((select count(*) from public.invoices)::int, 1,
          'the office manager still reads invoices');

select finish();
rollback;
