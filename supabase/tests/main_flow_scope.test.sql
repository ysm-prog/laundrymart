-- Proof for 0025: the job→invoice flow is writable by the Owner and the Office
-- manager, and by nobody else — enforced in the database, not just the screens.
--
-- The app already refuses to *show* the flow to anyone else. This asserts the
-- layer underneath: a warehouse operator holding a real login and talking
-- straight to PostgREST still cannot move a job or touch an invoice.
begin;
select plan(18);

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
  ('66666666-6666-6666-6666-666666666666','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver');

insert into public.drivers (id, tenant_id, user_id, full_name) values
  ('66660000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '66666666-6666-6666-6666-666666666666','Mario');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Cafe A');

insert into public.laundry_orders (id, tenant_id, customer_id, order_number, received_at)
values ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'c0000000-0000-0000-0000-00000000000a','LJ00001', now());

insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, received_at, status,
   delivery_required, expected_delivery_date, assigned_driver_id, assigned_delivery_date)
values ('d0000000-0000-0000-0000-00000000000b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'c0000000-0000-0000-0000-00000000000a','LJ00002', now(), 'out_for_delivery',
        true, current_date, '66660000-0000-0000-0000-00000000000a', current_date);

insert into public.invoices (id, tenant_id, customer_id, invoice_number) values
  ('e0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','INV00001');

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
select lives_ok(
  $$ insert into public.items (tenant_id, sku, name)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','SKU-1','Bath Towel') $$,
  'the floor still runs its own screens');

-- ---------------------------------------------------------- the counter -----
set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';
select throws_ok(
  $$ insert into public.laundry_orders
       (tenant_id, customer_id, order_number, received_at)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'c0000000-0000-0000-0000-00000000000a','LJ09998', now()) $$,
  '42501', null, 'the counter cannot take a job in either');

select lives_ok(
  $$ update public.customers set trading_name = 'Cafe A Pty'
      where id = 'c0000000-0000-0000-0000-00000000000a' $$,
  'the counter still keeps the customer record');

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

-- ---------------------------------------------------------- the driver -----
-- The carve-out that keeps the app working. A driver finishing a delivery
-- writes to `laundry_orders` — that is what completeLaundryOrder does — and
-- without this clause the update is refused silently and the job sits at
-- `out_for_delivery` for ever. Executing your own run is not working the
-- office's flow.
set local "request.jwt.claim.sub" = '66666666-6666-6666-6666-666666666666';

update public.laundry_orders set status = 'completed'
 where id = 'd0000000-0000-0000-0000-00000000000b';
select is(
  (select status from public.laundry_orders
    where id = 'd0000000-0000-0000-0000-00000000000b'), 'completed',
  'a driver can finish the delivery assigned to them');

-- And no further than that: a job that is not theirs is not even visible, so
-- the carve-out cannot be turned into a way round the restriction.
select is((select count(*) from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a')::int, 0,
          'a driver cannot see, let alone change, a job that is not theirs');

-- ------------------------------------------------------ reading is open -----
-- Deliberately not restricted: a driver must be able to read the job they are
-- delivering, and the app is what decides who is shown the screens.
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
select is((select count(*) from public.laundry_orders)::int, 2,
          'the floor can still read jobs — SELECT is deliberately not restricted');

set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is((select count(*) from public.invoices)::int, 1,
          'the office manager still reads invoices');

select finish();
rollback;
