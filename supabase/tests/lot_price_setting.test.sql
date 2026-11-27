-- Proof: the standard lot price is a setting (0067). The Owner and the Office
-- manager change it; pricing roles read it; a booking takes the price of the
-- day it was booked and keeps it when the setting moves.
begin;
select plan(16);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','counter@example.com'),
  ('22222222-2222-2222-2222-222222222222','owner@example.com'),
  ('33333333-3333-3333-3333-333333333333','office@example.com'),
  ('44444444-4444-4444-4444-444444444444','driver@example.com'),
  ('55555555-5555-5555-5555-555555555555','auditor@example.com'),
  ('66666666-6666-6666-6666-666666666666','other@example.com');

insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Lots laundry'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Another laundry');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customer_service'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','operations_manager'),
  ('44444444-4444-4444-4444-444444444444','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('55555555-5555-5555-5555-555555555555','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','auditor'),
  ('66666666-6666-6666-6666-666666666666','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Hotel');

set local role authenticated;

-- ------------------------------------------- no setting means the default --
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
insert into public.laundry_orders (id, tenant_id, customer_id, order_number, booking_type, lot_count)
values ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'c0000000-0000-0000-0000-00000000000a','LJ00001','lot',10);

set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is((select unit_price_ex_gst from public.laundry_order_lot_prices
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), 40.00::numeric(12,2),
          'with no setting, a lot is booked at the default $40.00');

-- ------------------------------------------------ the owner sets $45.00 --
select lives_ok(
  $$insert into public.tenant_lot_prices (tenant_id, unit_price_ex_gst)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 45.00)$$,
  'the Owner can set the lot price');
select is((select unit_price_ex_gst from public.tenant_lot_prices
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 45.00::numeric(12,2),
          'and it reads back');

-- The counter books a new job: it takes the new price.
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
insert into public.laundry_orders (id, tenant_id, customer_id, order_number, booking_type, lot_count)
values ('d0000000-0000-0000-0000-00000000000b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'c0000000-0000-0000-0000-00000000000a','LJ00002','lot',10);

set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is((select unit_price_ex_gst || ':' || total_ex_gst || '/' || gst_amount || '/' || total_inc_gst
             from public.laundry_order_lot_prices
            where order_id = 'd0000000-0000-0000-0000-00000000000b'), '45.00:450.00/45.00/495.00',
          'a lot booked after the change takes $45.00: 10 lots = $450 + $45 GST = $495');
select is((select unit_price_ex_gst from public.laundry_order_lot_prices
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), 40.00::numeric(12,2),
          'the booking taken before the change keeps $40.00');

-- Changing the earlier booking's count does not move it to the new price.
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
update public.laundry_orders set lot_count = 3 where id = 'd0000000-0000-0000-0000-00000000000a';
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is((select unit_price_ex_gst || ':' || total_inc_gst from public.laundry_order_lot_prices
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), '40.00:132.00',
          'and keeps it when its count changes: 3 lots at $40 = $132.00');

-- ------------------------------------------- the office manager changes it --
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
update public.tenant_lot_prices set unit_price_ex_gst = 42.50
 where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select is((select unit_price_ex_gst from public.tenant_lot_prices
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 42.50::numeric(12,2),
          'the Office manager can change the lot price (the write landed)');

select throws_ok(
  $$update public.tenant_lot_prices set unit_price_ex_gst = 0
     where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  '23514', null, 'a lot price of zero is refused');

-- ------------------------------------------------------- everyone else --
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select is((select count(*) from public.tenant_lot_prices)::int, 0,
          'the counter cannot read the lot price');
select throws_ok(
  $$insert into public.tenant_lot_prices (tenant_id, unit_price_ex_gst)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1)
    on conflict (tenant_id) do update set unit_price_ex_gst = excluded.unit_price_ex_gst$$,
  '42501', null, 'and cannot set one');

set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';
select is((select count(*) from public.tenant_lot_prices)::int, 0, 'a driver reads no lot price');

set local "request.jwt.claim.sub" = '55555555-5555-5555-5555-555555555555';
select is((select count(*) from public.tenant_lot_prices)::int, 1, 'the auditor reads it');
update public.tenant_lot_prices set unit_price_ex_gst = 1
 where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is((select unit_price_ex_gst from public.tenant_lot_prices
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 42.50::numeric(12,2),
          'and the auditor''s update changed nothing');

set local "request.jwt.claim.sub" = '66666666-6666-6666-6666-666666666666';
select is((select count(*) from public.tenant_lot_prices)::int, 0,
          'another laundry''s owner reads no lot price');
select throws_ok(
  $$insert into public.tenant_lot_prices (tenant_id, unit_price_ex_gst)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1)$$,
  '42501', null, 'and cannot set this laundry''s');

-- -------------------------------------------------------------- posture --
reset role;
select ok(not has_table_privilege('authenticated', 'public.tenant_lot_prices', 'truncate'),
          'authenticated cannot truncate the setting');

select * from finish();
rollback;
