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
select plan(11);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@example.com'),
  ('22222222-2222-2222-2222-222222222222','b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

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

select * from finish();
rollback;
