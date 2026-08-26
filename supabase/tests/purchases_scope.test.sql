-- Proof: the payable side is tenant-scoped, and its integrity checks hold.
--
-- What another tenant must never see here is not a linen count — it is who this
-- business buys from and what it pays them, which is the commercially sensitive
-- half of the books. So the same two properties every tenant table has to
-- demonstrate: an outsider reads nothing, and a well-formed row addressed to
-- someone else is refused on the way in rather than merely hidden afterwards.
--
-- The document checks are asserted too, because both are load-bearing in a way
-- that is easy to get backwards: a bill's balance is legally negative (a
-- supplier debit note is money owed back to us), while its due date is not
-- legally before its issue date.
begin;
select plan(25);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@example.com'),
  ('22222222-2222-2222-2222-222222222222','b@example.com'),
  -- 0036: the payable side is `purchases.*`, not "any member". Both sides of
  -- that line get a real login, because the only way to prove a read policy is
  -- to read as somebody.
  ('33333333-3333-3333-3333-333333333333','finance@example.com'),
  ('44444444-4444-4444-4444-444444444444','board@example.com'),
  ('55555555-5555-5555-5555-555555555555','counter@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin'),
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','finance'),
  ('44444444-4444-4444-4444-444444444444','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','board'),
  ('55555555-5555-5555-5555-555555555555','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customer_service');

insert into public.suppliers (id, tenant_id, supplier_number, name) values
  ('5000000a-0000-4000-8000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','SUP00001','Pak-Rite'),
  ('5000000b-0000-4000-8000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','SUP00001','Cy Linen Supply');

insert into public.supplier_bills
  (tenant_id, supplier_id, bill_number, issue_date, due_date, amount, balance_due, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','5000000a-0000-4000-8000-00000000000a',
   '00014983','2026-07-01','2026-07-31',1065.20,1065.20,'open'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','5000000b-0000-4000-8000-00000000000b',
   '00012912','2026-07-02','2026-08-01',592.00,-2.00,'debit');

insert into public.gl_accounts (tenant_id, code, name, account_type, tax_code, level) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','5-1000','Towel Purchases','Cost of sales','GST',2),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','5-1000','Towel Purchases','Cost of sales','GST',2);

-- ------------------------------------------------------------------ anon ----
-- PostgREST hands an unauthenticated request to `anon`. Asserted by privilege
-- and by attempt: 42501 on its own proves nothing, since our own guards raise
-- the same SQLSTATE.
select ok(not has_table_privilege('anon', 'public.supplier_bills', 'SELECT'),
          'anon holds no SELECT privilege on supplier_bills');
select ok(not has_table_privilege('anon', 'public.suppliers', 'SELECT'),
          'anon holds no SELECT privilege on suppliers');

set local role anon;
select throws_ok(
  $$select id from public.supplier_bills$$,
  '42501',
  'permission denied for table supplier_bills',
  'an unauthenticated caller cannot read what we owe');
reset role;

-- --------------------------------------------------------------- tenancy ----
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is((select count(*) from public.suppliers)::int, 1,
          'A sees only its own suppliers');
select is((select count(*) from public.supplier_bills)::int, 1,
          'A sees only its own bills');
select is((select count(*) from public.gl_accounts)::int, 1,
          'A sees only its own chart of accounts');
select is((select count(*) from public.supplier_bills
            where tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')::int, 0,
          'B''s bill is invisible, not merely unlinked');

-- The tenant-hop. The using clause has nothing to say about an insert, so the
-- with check is what has to refuse it.
select throws_ok(
  $$insert into public.suppliers (tenant_id, supplier_number, name)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','SUP09999','Injected')$$,
  '42501',
  'new row violates row-level security policy for table "suppliers"',
  'with check blocks a supplier planted in another tenant');

-- --------------------------------------------------------- document rules ----
-- A supplier debit note is money owed back to us, so a negative balance has to
-- survive. This is asserted rather than assumed because the obvious "amounts
-- are positive" check would have silently dropped 10 real bills on import.
insert into public.supplier_bills
  (tenant_id, supplier_id, bill_number, issue_date, amount, balance_due, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','5000000a-0000-4000-8000-00000000000a',
        '00014623','2026-05-12',-71.76,-71.76,'debit');
select is((select balance_due from public.supplier_bills where bill_number = '00014623'),
          -71.76::numeric,
          'a supplier debit note keeps its negative balance');

select throws_ok(
  $$insert into public.supplier_bills
      (tenant_id, supplier_id, bill_number, issue_date, due_date, amount)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','5000000a-0000-4000-8000-00000000000a',
            '00099999','2026-07-31','2026-07-01',10.00)$$,
  '23514',
  null,
  'a bill cannot fall due before it was issued');

-- Two tenants legitimately run the same numbering, which is why every unique
-- index here is on (tenant_id, …) and never on the number alone.
select throws_ok(
  $$insert into public.supplier_bills
      (tenant_id, supplier_id, bill_number, issue_date, amount)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','5000000a-0000-4000-8000-00000000000a',
            '00014983','2026-07-01',1.00)$$,
  '23505',
  null,
  'a bill number cannot repeat inside one tenant');


-- ------------------------------------------- 0036: who the books are for ----
-- The whole payable side shipped on `apply_tenant_policy` — one permissive
-- `for all … using is_member(tenant_id)` policy, so **every member of the
-- laundry could read it and write it**: the chart of accounts with the owner's
-- equity and every loan balance on it, 192 suppliers, 1,515 bills. The identical
-- shape 0006 put on `invoices`, 0017 replaced, 0018 repeated on `laundry_prices`
-- and 0033 replaced. This is the third time, so it is asserted by outcome here
-- rather than left to a policy read.
--
-- Asserted as real sessions, because a refused SELECT is an empty result and a
-- refused UPDATE is a silence — neither raises anything to catch.

-- A round delivering laundry.
set local role authenticated;
set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';
select is((select count(*) from public.gl_accounts)::int, 0,
          'a board reads none of the chart of accounts');
select is((select count(*) from public.supplier_bills)::int, 0,
          'a board reads none of what the business owes');
select is((select count(*) from public.suppliers)::int, 0,
          'a board reads none of who the business buys from');

-- The write half, which was the worse of the two: a `for all` policy grants
-- INSERT, UPDATE and DELETE as well, so a delivery round could rename an account
-- in the chart. Counted afterwards from a session that can see the row, since
-- an update matching nothing raises nothing.
update public.gl_accounts set name = 'Renamed by a board'
  where code = '5-1000' and tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- The counter, who holds `orders.*` and no `purchases.*`.
set local "request.jwt.claim.sub" = '55555555-5555-5555-5555-555555555555';
select is((select count(*) from public.gl_accounts)::int, 0,
          'the counter reads none of the chart of accounts');

-- Finance, whose job this is.
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
select is((select count(*) from public.gl_accounts)::int, 1,
          'finance reads its own laundry''s chart of accounts');
-- Two, not one: the document-rules block above added tenant A's debit note.
-- Stated rather than worked around, because a probe that writes re-scopes every
-- count below it and a test that quietly expects the wrong number is the trap
-- 0034's proof recorded.
select is((select count(*) from public.supplier_bills)::int, 2,
          'finance reads its own laundry''s bills, the debit note included');
select is((select name from public.gl_accounts where code = '5-1000'),
          'Towel Purchases',
          'the board''s rename touched nothing');

-- No permissive `for all` policy survives on any of the six, or its USING half
-- is a second door onto SELECT and every assertion above is decoration. The
-- trap 0033 recorded, checked here rather than trusted.
reset role;
select is(
  (select count(*)::int from pg_policy
    where polrelid in ('public.gl_accounts'::regclass, 'public.suppliers'::regclass,
                       'public.supplier_bills'::regclass, 'public.purchase_orders'::regclass,
                       'public.supplier_payments'::regclass,
                       'public.import_activation_state'::regclass)
      and polcmd = '*' and polpermissive),
  0,
  'no permissive `for all` policy is left standing on the payable side');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

-- ------------------------------------ 0036: an invoice line names an account -
-- Two records of one fact, so the trigger has to refuse every way they could
-- disagree — the arrangement 0016 uses for the assignment and 0032 for an item's
-- category.
insert into public.customers (id, tenant_id, customer_number, business_name)
values ('c0000001-0000-4000-8000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'CUST00001','Cafe Roma');
insert into public.invoices (id, tenant_id, customer_id, invoice_number, invoice_type, status)
values ('a0000001-0000-4000-8000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'c0000001-0000-4000-8000-00000000000a','INV00001','manual','draft');
insert into public.gl_accounts (id, tenant_id, code, name, account_type, tax_code, level)
values ('9000000a-0000-4000-8000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '4-1100','Towels - Black','Income','GST',2);
insert into public.gl_accounts (id, tenant_id, code, name, account_type, is_header, level)
values ('9000000b-0000-4000-8000-00000000000b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '0-INCOME','Income','Income',true,1);

-- The code is derived, never posted: a caller cannot stamp 4-1100 on a line
-- pointing somewhere else, because it never gets to say what the code is.
insert into public.invoice_lines
  (tenant_id, invoice_id, gl_account_id, description, quantity, unit_price, amount)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','a0000001-0000-4000-8000-00000000000a',
        '9000000a-0000-4000-8000-00000000000a','Bath towels',10,3.00,30.00);
select is((select account_code from public.invoice_lines where description = 'Bath towels'),
          '4-1100',
          'the account code is derived from the account, not taken from the caller');

-- The free-text line the client asked for: neither an item nor a code, and
-- legal. Refusing it would push that work back onto a spreadsheet; the invoice
-- screen counts it instead.
insert into public.invoice_lines
  (tenant_id, invoice_id, description, quantity, unit_price, amount)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','a0000001-0000-4000-8000-00000000000a',
        'Replacement tablecloth, damaged in transit',1,42.00,42.00);
select is((select account_code from public.invoice_lines
            where description like 'Replacement%'),
          null,
          'a line with no account is legal and carries no code');

select throws_ok(
  $$insert into public.invoice_lines
      (tenant_id, invoice_id, gl_account_id, description, quantity, unit_price, amount)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','a0000001-0000-4000-8000-00000000000a',
            '9000000b-0000-4000-8000-00000000000b','Nonsense',1,1.00,1.00)$$,
  'P0001',
  'that is a heading, not an account you can code to',
  'nothing can be coded to a classification heading');

-- The tenant check inside the trigger, which fires before RLS would have
-- anything to say — the account id is simply invisible to this session, so the
-- guard is what turns that into a sentence rather than a foreign-key error.
select throws_ok(
  $$insert into public.invoice_lines
      (tenant_id, invoice_id, gl_account_id, description, quantity, unit_price, amount)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','a0000001-0000-4000-8000-00000000000a',
            '5000000b-0000-4000-8000-00000000000b','Nonsense',1,1.00,1.00)$$,
  'P0001',
  'that account could not be found',
  'an id that is not an account of this laundry is refused by name');

-- The snapshot outlives the link. `on delete set null` fires the trigger with
-- the account going to null, and the whole point of keeping the text is that a
-- sent invoice still says what it was coded to.
reset role;
delete from public.gl_accounts where id = '9000000a-0000-4000-8000-00000000000a';
select is((select account_code from public.invoice_lines where description = 'Bath towels'),
          '4-1100',
          'deleting the account leaves the code the invoice was written with');
select is((select gl_account_id from public.invoice_lines where description = 'Bath towels'),
          null,
          'and the link is cleared rather than dangling');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select * from finish();
rollback;
