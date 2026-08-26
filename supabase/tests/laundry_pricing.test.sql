-- Proof: a price list is tenant-scoped, role-gated and unambiguous.
--
-- Three things are defended here, and none of them can be defended by the screen
-- that renders the price list.
--
-- The obvious one is tenancy: what one laundry charges is commercially private,
-- and the `with check` half has to refuse a row addressed to another tenant.
--
-- The second is the role gate. 0018 gives `laundry_prices` the same shape 0006
-- gives the invoice tables — every member may read, only a finance/admin role
-- may write — because anyone holding a session and the anon key can POST to
-- /rest/v1/laundry_prices directly. A counter hand who can re-price the work is
-- a finance control that exists only in the navigation.
--
-- The third is the one that would be silently wrong rather than loudly wrong:
-- the unique index has to treat the *default* list (customer_id is null) as a
-- single row per kind of laundry. Under the plain unique-index rule every NULL
-- is distinct, so the default price — the row every unpriced customer falls back
-- to — would be exactly the one that could be duplicated, and which of the two
-- copies answered would depend on the plan.
begin;
select plan(15);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@example.com'),
  ('22222222-2222-2222-2222-222222222222','b@example.com'),
  ('33333333-3333-3333-3333-333333333333','counter@example.com'),
  ('44444444-4444-4444-4444-444444444444','board@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin'),
  -- The counter: `customer_service` takes laundry in and hands it back, and
  -- holds no invoices capability at all.
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customer_service'),
  -- The round. An operational login since 0031, holding no pricing capability
  -- whatsoever — and the reason the read gate below is not academic.
  ('44444444-4444-4444-4444-444444444444','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','board');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Harbourview Hotel'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','CUST00001','Southern Cafe');

-- A's default price for towels, A's own price for one customer, and B's default
-- at a different figure. Both tenants price 'towels': the point is that neither
-- can see the other's number.
insert into public.laundry_prices (tenant_id, customer_id, item_type, unit_price) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'towels', 2.00),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a','towels', 1.50),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'towels', 9.00);

-- ------------------------------------------------------------------ anon ----
-- PostgREST hands an unauthenticated request to `anon`. Asserted by privilege
-- and by attempt: 42501 on its own proves nothing here, since our own guards
-- raise the same SQLSTATE.
select ok(not has_table_privilege('anon', 'public.laundry_prices', 'SELECT'),
          'anon holds no SELECT privilege on laundry_prices');

set local role anon;
select throws_ok(
  $$select id from public.laundry_prices$$,
  '42501',
  'permission denied for table laundry_prices',
  'an unauthenticated caller cannot read a price list');
reset role;

-- --------------------------------------------------------------- tenancy ----
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is((select count(*) from public.laundry_prices)::int, 2,
          'A sees its own two prices and nothing else');
select is((select count(*) from public.laundry_prices
            where tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')::int, 0,
          'B''s price is invisible, not merely unlinked');

-- The tenant-hop: a well-formed row addressed to someone else. The using clause
-- has nothing to say about an insert, so the with check is what has to refuse.
select throws_ok(
  $$insert into public.laundry_prices (tenant_id, item_type, unit_price)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','sheets', 0.10)$$,
  '42501',
  'new row violates row-level security policy for table "laundry_prices"',
  'A cannot write a price into B''s list');

-- ------------------------------------------------------- one default row ----
-- `nulls not distinct` is what makes this fail. Without it the insert succeeds
-- and the customer falling back to the default gets whichever copy the planner
-- reaches first.
select throws_ok(
  $$insert into public.laundry_prices (tenant_id, item_type, unit_price)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','towels', 3.00)$$,
  '23505',
  null,
  'the default list cannot hold two prices for the same kind of laundry');

select throws_ok(
  $$insert into public.laundry_prices (tenant_id, customer_id, item_type, unit_price)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'c0000000-0000-0000-0000-00000000000a','towels', 3.00)$$,
  '23505',
  null,
  'a customer cannot hold two prices for the same kind of laundry');

-- A customer price and a default price are different rows, which is the whole
-- override mechanism.
select is((select count(*) from public.laundry_prices
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
              and item_type = 'towels')::int, 2,
          'the default and one customer''s override coexist');

-- A price that no line of laundry could ever match prices nothing.
select throws_ok(
  $$insert into public.laundry_prices (tenant_id, item_type, unit_price)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','tablecloths', 1.00)$$,
  '23514',
  null,
  'a price must name one of the nine kinds of laundry a job can carry');

-- ------------------------------------------------------------- role gate ----
-- 0033: a price list is a finance record, so the read is `can_read_pricing()`
-- and not `is_member()`.
--
-- This block asserted the opposite until then — *the counter can read the
-- tenant's prices*, count 2 — which is how 0018 shipped the identical hole 0017
-- had closed on `invoices` a migration earlier, and why it survived a green
-- suite for two days. A proof that encodes the defect defends it.
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';

select is((select count(*) from public.laundry_prices)::int, 0,
          'the counter cannot read what anybody is charged');

select throws_ok(
  $$insert into public.laundry_prices (tenant_id, item_type, unit_price)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','sheets', 0.05)$$,
  '42501',
  'new row violates row-level security policy for table "laundry_prices"',
  'the counter cannot add a price');

-- An UPDATE the write policy's `using` clause excludes matches no rows — it is
-- refused silently rather than by an error, which is precisely why this is
-- asserted on the data rather than on a raised exception.
update public.laundry_prices set unit_price = 0 where item_type = 'towels';
-- Read back as the owner: since 0033 the counter cannot see the row it failed
-- to change, so counting as them would pass for the wrong reason.
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select is((select count(*) from public.laundry_prices where unit_price = 0)::int, 0,
          'the counter cannot re-price the work');

-- The board is the case that made this visible: an operational round with its
-- own login, holding `run.execute` and nothing financial.
set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';
select is((select count(*) from public.laundry_prices)::int, 0,
          'a board cannot read the price list');

reset role;

-- The half that is easy to miss. A permissive `for all` policy's USING clause
-- grants SELECT as well, so leaving 0018's write policy in place would have
-- kept the whole list readable to `dispatcher` past the narrowed read gate —
-- the same trap §22 records for 0017, one table later.
select is((select count(*) from pg_policy
            where polrelid = 'public.laundry_prices'::regclass
              and polcmd = '*' and polpermissive)::int, 0,
          'no permissive `for all` policy is a second door onto SELECT');

-- --------------------------------------------------- the billed-once link ---
-- Without this column the monthly run has no way to tell laundry it has already
-- invoiced from laundry it has not, and a second run bills the same job again.
select has_column('public', 'invoice_lines', 'laundry_order_id',
                  'an invoice line records the laundry job it bills');

select * from finish();
rollback;
