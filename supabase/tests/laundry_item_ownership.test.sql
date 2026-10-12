-- Proof: each laundry row says whose linen it is, through the one writer the job
-- form uses, and the answer is held to the two words the screen offers.
--
-- Pricing is not touched by 0051, so there is nothing here about money. What
-- this defends is the round trip: the counter picks Rental or Own, the job form
-- posts it in the JSON row, `save_laundry_order_items()` writes it, and a row
-- with no answer stays null rather than becoming one.
begin;
select plan(7);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner-a@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin');
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Hotel');
insert into public.laundry_orders (id, tenant_id, customer_id, order_number) values
  ('a0000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00001');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is(
  public.save_laundry_order_items('a0000000-0000-0000-0000-000000000001', $j$[
    {"item_type":"linen","quantity_type":"exact","exact_quantity":12,"ownership":"rental"},
    {"item_type":"uniforms","quantity_type":"exact","exact_quantity":4,"ownership":"own"},
    {"item_type":"towels","quantity_type":"exact","exact_quantity":9}
  ]$j$::jsonb),
  3, 'the job form''s writer saves three rows');

select is(
  (select ownership from public.laundry_order_items
    where order_id = 'a0000000-0000-0000-0000-000000000001' and item_type = 'linen'),
  'rental', 'a row marked Rental is stored as rental');

select is(
  (select ownership from public.laundry_order_items
    where order_id = 'a0000000-0000-0000-0000-000000000001' and item_type = 'uniforms'),
  'own', 'a row marked Own is stored as own');

select is(
  (select ownership from public.laundry_order_items
    where order_id = 'a0000000-0000-0000-0000-000000000001' and item_type = 'towels'),
  null, 'a row with no answer stays null rather than being read as either');

select is(
  public.save_laundry_order_items('a0000000-0000-0000-0000-000000000001', $j$[
    {"item_type":"linen","quantity_type":"exact","exact_quantity":12,"ownership":""}
  ]$j$::jsonb),
  1, 'a blank answer is saved as no answer');

select throws_ok(
  $$select public.save_laundry_order_items('a0000000-0000-0000-0000-000000000001',
      '[{"item_type":"linen","quantity_type":"exact","exact_quantity":1,"ownership":"borrowed"}]'::jsonb)$$,
  '23514', null, 'any other word is refused by the check constraint');

reset role;
select ok(
  not has_function_privilege('anon', 'public.save_laundry_order_items(uuid, jsonb)', 'EXECUTE'),
  'anon still cannot reach the writer');

select * from finish();
rollback;
