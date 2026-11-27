-- Proof: a lot booking (0066) carries its price, fixed at the day it was
-- booked, and only a pricing role can read it.
--
-- Run as real members (`authenticated` with a `sub`): the price row is written
-- by a SECURITY DEFINER trigger on the job, and the point of that is that the
-- counter — who may take laundry in and may not read a price — can book a lot
-- without being granted any write on the price table.
begin;
select plan(20);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','counter@example.com'),
  ('22222222-2222-2222-2222-222222222222','owner@example.com'),
  ('33333333-3333-3333-3333-333333333333','driver@example.com'),
  ('44444444-4444-4444-4444-444444444444','other@example.com');

insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Lots laundry'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Another laundry');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customer_service'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('44444444-4444-4444-4444-444444444444','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Hotel');

-- ------------------------------------------------------- the counter books --
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select lives_ok(
  $$insert into public.laundry_orders
      (id, tenant_id, customer_id, order_number, booking_type, lot_count, lot_notes)
    values ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'c0000000-0000-0000-0000-00000000000a','LJ00001','lot',10,'Two lots wet')$$,
  'the counter can book a job by the lot');

select is((select booking_type || ':' || lot_count || ':' || lot_notes from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a'), 'lot:10:Two lots wet',
          'the booking reads back as written');

select is((select count(*) from public.laundry_order_lot_prices)::int, 0,
          'the counter cannot read what it costs');

select throws_ok(
  $$insert into public.laundry_order_lot_prices (order_id, tenant_id, unit_price_ex_gst, gst_rate)
    values ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, 0)$$,
  '42501', null, 'and cannot write a price of its own');

select throws_ok(
  $$insert into public.laundry_orders
      (tenant_id, customer_id, order_number, booking_type, lot_count)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a','LJ00002','lot',0)$$,
  '23514', null, 'zero lots is refused');

select throws_ok(
  $$insert into public.laundry_orders
      (tenant_id, customer_id, order_number, booking_type)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a','LJ00002','lot')$$,
  '23514', null, 'a lot booking without a count is refused');

select throws_ok(
  $$insert into public.laundry_orders
      (tenant_id, customer_id, order_number, lot_count)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a','LJ00002',3)$$,
  '23514', null, 'a standard job cannot carry a lot count');

-- ------------------------------------------------------ the owner reads it --
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

select is((select unit_price_ex_gst from public.laundry_order_lot_prices
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), 40.00::numeric(12,2),
          'the standard price is $40.00 a lot excluding GST');
select is((select total_ex_gst || '/' || gst_amount || '/' || total_inc_gst
             from public.laundry_order_lot_prices
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), '400.00/40.00/440.00',
          '10 lots: $400.00 + $40.00 GST = $440.00');

-- The counter changes the count; the totals follow it.
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
update public.laundry_orders set lot_count = 2 where id = 'd0000000-0000-0000-0000-00000000000a';
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is((select total_ex_gst || '/' || gst_amount || '/' || total_inc_gst
             from public.laundry_order_lot_prices
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), '80.00/8.00/88.00',
          'changing the count to 2 recomputes the totals: $80 + $8 = $88');

select is((select count(*) from public.laundry_order_lot_prices)::int, 1,
          'the owner reads the price; there is one row per lot booking');

-- A historical price survives a change to the standard one. Simulated by
-- setting the stored unit price as the superuser, as a past booking would hold it.
reset role;
update public.laundry_order_lot_prices set unit_price_ex_gst = 35.00
 where order_id = 'd0000000-0000-0000-0000-00000000000a';
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
update public.laundry_orders set lot_count = 5 where id = 'd0000000-0000-0000-0000-00000000000a';
select is((select unit_price_ex_gst || ':' || total_ex_gst || '/' || gst_amount || '/' || total_inc_gst
             from public.laundry_order_lot_prices
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), '35.00:175.00/17.50/192.50',
          'an existing booking keeps the price it was booked at when its count changes');

select throws_ok(
  $$update public.laundry_order_lot_prices set unit_price_ex_gst = 1
     where order_id = 'd0000000-0000-0000-0000-00000000000a'$$,
  '42501', null, 'not even the owner edits a price row directly');

-- ---------------------------------------------------- standard and back --
update public.laundry_orders set booking_type = 'standard', lot_count = null, lot_notes = null
 where id = 'd0000000-0000-0000-0000-00000000000a';
select is((select count(*) from public.laundry_order_lot_prices
            where order_id = 'd0000000-0000-0000-0000-00000000000a')::int, 0,
          'a job that stops being a lot booking loses its price row');

update public.laundry_orders set booking_type = 'lot', lot_count = 20
 where id = 'd0000000-0000-0000-0000-00000000000a';
select is((select unit_price_ex_gst || ':' || total_inc_gst from public.laundry_order_lot_prices
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), '40.00:880.00',
          'booked by the lot again, it takes today''s standard price: 20 lots = $880.00');

-- ------------------------------------------------------- the other roles --
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
select is((select count(*) from public.laundry_order_lot_prices)::int, 0,
          'a driver reads no lot price');

set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';
select is((select count(*) from public.laundry_order_lot_prices)::int, 0,
          'another laundry''s owner reads no lot price');

-- -------------------------------------------------------------- posture --
reset role;
select ok(not has_table_privilege('anon', 'public.laundry_order_lot_prices', 'select'),
          'anon holds no grant on the lot price table');
select ok(not has_function_privilege('authenticated', 'public.sync_lot_booking_price()', 'execute'),
          'the trigger function is not on the RPC surface');
select is((select count(*) from public.laundry_orders where booking_type is null)::int, 0,
          'every job has a booking type');

select * from finish();
rollback;
