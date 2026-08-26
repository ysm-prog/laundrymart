-- Proof: an item carries the code the business uses, and a job's laundry cannot
-- name an item and a category that disagree.
--
-- Two things are being defended.
--
-- The first is the **coherence rule**. `item_type` is what three pricing tiers,
-- every report and every historical row match on; `item_id` is the coded item a
-- job now names. If those two could disagree, a job of TOW001 filed as "sheets"
-- would be priced at the sheet rate and nobody would ever see why. The trigger
-- derives one from the other, so it is true of `save_laundry_order_items()`
-- (which inserts directly), of a future import, and of anything reaching
-- PostgREST — none of which go through the screen.
--
-- The second is that **this migration is additive**. Every job written before
-- the item master has no `item_id`, and the assertions below check that such a
-- row still inserts, still carries its own category, and is untouched.
begin;
select plan(25);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@example.com'),
  ('22222222-2222-2222-2222-222222222222','b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Hotel'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Southern Cafe');

-- TOW001 is laundry a customer hands in; TBL001 is rental linen that is not.
insert into public.items (id, tenant_id, sku, item_code, name, category, laundry_category) values
  ('11110000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'BT-WHT-01','TOW001','Bath Towel','bath_towel','bath_towels'),
  ('11110000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'TC-WHT-01','TBL001','Table Cloth','table_cloth',null);
-- The other laundry's item, so "that item could not be found in this laundry"
-- is proven against a real row rather than a made-up uuid.
insert into public.items (id, tenant_id, sku, item_code, name, category, laundry_category) values
  ('11110000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'BT-WHT-01','TOW001','Their Bath Towel','bath_towel','bath_towels');

insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, delivery_required, expected_delivery_date) values
  ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00001', true, '2026-08-25');

-- ---------------------------------------------------------- the item code ---
select is((select item_code from public.items
            where id = '11110000-0000-0000-0000-00000000000a'), 'TOW001',
          'an item carries the code the business uses');

-- The same code in two laundries is fine and must stay fine: the index is per
-- tenant, and two businesses on one deployment both call their towels TOW001.
select is((select count(*) from public.items where lower(item_code) = 'tow001')::int, 2,
          'two laundries may each hold TOW001');

select throws_ok(
  $$insert into public.items (tenant_id, sku, item_code, name, category)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','BT-WHT-02','tow001','Another Towel','bath_towel')$$,
  '23505', null,
  'the same code twice in one laundry is refused, case-insensitively');

-- --------------------------------------------------- the coherence rule -----
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

-- The case the whole trigger exists for: a caller that names the item *and* the
-- wrong category. The item wins, silently and correctly.
select lives_ok(
  $$insert into public.laundry_order_items
      (tenant_id, order_id, item_id, item_type, quantity_type, exact_quantity)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-00000000000a',
            '11110000-0000-0000-0000-00000000000a','sheets','exact',24)$$,
  'a row may name an item and a category');

select is(
  (select item_type from public.laundry_order_items
    where order_id = 'd0000000-0000-0000-0000-00000000000a'),
  'bath_towels',
  'and the item decides which kind of laundry it is, not the caller');

-- An item that is not laundry a customer hands in leaves the caller's answer,
-- because "this is a rented tablecloth" is not an answer to "what kind of
-- laundry is this" and inventing one would be worse than their guess.
select lives_ok(
  $$update public.laundry_order_items
       set item_id = '11110000-0000-0000-0000-00000000000c', item_type = 'linen'
     where order_id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'an item with no laundry category is accepted');
select is(
  (select item_type from public.laundry_order_items
    where order_id = 'd0000000-0000-0000-0000-00000000000a'),
  'linen',
  'and the caller keeps their own answer');

-- Another laundry's item is not merely rejected — RLS makes it invisible, so it
-- lands here as "could not be found".
select throws_ok(
  $$update public.laundry_order_items
       set item_id = '11110000-0000-0000-0000-0000000000bb'
     where order_id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'that item could not be found in this laundry',
  'a job cannot name another laundry''s item');

-- ----------------------------------------------- the additive guarantee -----
-- Every job written before the item master has no item_id and must be untouched.
select lives_ok(
  $$insert into public.laundry_order_items
      (tenant_id, order_id, item_type, quantity_type, exact_quantity)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-00000000000a',
            'pillowcases','exact',30)$$,
  'a row with no item still inserts, exactly as before');
select is(
  (select item_type from public.laundry_order_items
    where order_id = 'd0000000-0000-0000-0000-00000000000a' and item_id is null),
  'pillowcases',
  'and keeps the kind of laundry it was given');

-- ------------------------------------------- the atomic replace, with items --
select is(
  public.save_laundry_order_items('d0000000-0000-0000-0000-00000000000a', $$[
    {"item_id":"11110000-0000-0000-0000-00000000000a","item_type":"sheets",
     "quantity_type":"exact","exact_quantity":40},
    {"item_type":"uniforms","quantity_type":"exact","exact_quantity":5}
  ]$$::jsonb),
  2,
  'the atomic replace carries the item through');

select is(
  (select item_type from public.laundry_order_items
    where order_id = 'd0000000-0000-0000-0000-00000000000a'
      and item_id = '11110000-0000-0000-0000-00000000000a'),
  'bath_towels',
  'and the trigger still corrects the category inside it');

select is(
  (select count(*) from public.laundry_order_items
    where order_id = 'd0000000-0000-0000-0000-00000000000a')::int, 2,
  'and the replace really replaced');

-- ------------------------------------------------------ pricing by item -----
-- A per-item price and a per-category one coexist. The old unique index was
-- (tenant, customer, item_type) with NULLS NOT DISTINCT, so without 0032's
-- rewrite the second per-item row here would be refused.
reset role;
insert into public.laundry_prices (tenant_id, customer_id, item_type, item_id, unit_price) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'bath_towels', null, 1.00),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'bath_towels',
   '11110000-0000-0000-0000-00000000000a', 2.00);
select is((select count(*) from public.laundry_prices
            where item_type = 'bath_towels')::int, 2,
          'a per-item price sits beside the price for its whole category');

select throws_ok(
  $$insert into public.laundry_prices (tenant_id, customer_id, item_type, item_id, unit_price)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'bath_towels',
            '11110000-0000-0000-0000-00000000000a', 3.00)$$,
  '23505', null,
  'but the same item cannot be priced twice on one list');

-- ------------------------------------------------------------------ anon ----
select ok(not has_table_privilege('anon', 'public.items', 'SELECT'),
          'anon holds no SELECT privilege on the item master');
select ok(not has_function_privilege('anon', 'public.sync_laundry_item_type()', 'EXECUTE'),
          'anon cannot execute the coherence trigger function');


-- ============================================================ 0040: writes ==
-- The item master is read by everybody and changed by two roles.
--
-- Before 0040 `items` carried 0002's single permissive `for all … using
-- is_member(tenant_id)`, so any member could rewrite it off PostgREST — proved
-- against the live project as one of Adelaide's own `board` logins, which
-- renamed the code that laundry bills at $0.22.
--
-- **Every refusal here is asserted by outcome, not by absence of an error.** A
-- policy that excludes a caller makes UPDATE and DELETE touch zero rows *in
-- silence*; only INSERT raises. Counting afterwards is what tells a working
-- boundary apart from a broken statement — the lesson §26 records, where
-- `lives_ok` passed throughout a bug that wrote nothing.
reset role;
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333','plant@example.com');
insert into public.memberships (user_id, tenant_id, role) values
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','warehouse_operator');

-- ------------------------------------------------------- the plant floor ----
set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';

select is((select count(*) from public.items)::int, 2,
          'the plant floor still reads every item in its laundry');
select ok(not public.can_write_items('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          'and is not one of the two roles that may change the list');

update public.items set name = 'Renamed by the plant floor'
 where id = '11110000-0000-0000-0000-00000000000a';
select is((select count(*) from public.items where name = 'Renamed by the plant floor')::int, 0,
          'its rename touched nothing — the silent refusal, counted rather than trusted');

select throws_ok(
  $$insert into public.items (tenant_id, sku, item_code, name, category)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','XX-01','XX001','Invented on the floor','other')$$,
  '42501', null,
  'and its insert is refused out loud');

delete from public.items where id = '11110000-0000-0000-0000-00000000000c';
select is((select count(*) from public.items)::int, 2,
          'and its delete removed nothing');

-- ------------------------------------------------------------- the Owner ----
-- The half that matters as much as the refusals: a gate that stops everybody is
-- not a gate, it is an outage.
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select ok(public.can_write_items('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          'the Owner may change the list');

update public.items set name = 'Bath Towel — White'
 where id = '11110000-0000-0000-0000-00000000000a';
select is((select name from public.items where id = '11110000-0000-0000-0000-00000000000a'),
          'Bath Towel — White',
          'and the Owner''s rename lands');

insert into public.items (tenant_id, sku, item_code, name, category)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','AP-01','APR001','Apron','other');
select is((select count(*) from public.items)::int, 3,
          'and the Owner''s new item lands');

reset role;

select finish();
rollback;
