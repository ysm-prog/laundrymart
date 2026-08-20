-- Proof: money leaving the business is tenant-scoped, and the opening-balance
-- double count is actually closed.
--
-- The second half is the interesting one. A payment record is easy to isolate;
-- what is easy to get wrong is the arithmetic around it — a party's carried-in
-- opening balance and the documents that represent the same debt both sitting
-- in the database, waiting for someone to add them together. 0015 clears the
-- opening once documents exist, and this asserts the rule held both ways: it is
-- cleared where a document accounts for the money, and kept where none does.
begin;
select plan(9);

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
  ('5000000b-0000-4000-8000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','SUP00001','Simba Global');

insert into public.supplier_payments (tenant_id, supplier_id, reference, paid_on, amount) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','5000000a-0000-4000-8000-00000000000a','8709','2026-08-04',1134.61),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','5000000b-0000-4000-8000-00000000000b','8710','2026-08-04',4238.74);

-- ------------------------------------------------------------------ anon ----
select ok(not has_table_privilege('anon', 'public.supplier_payments', 'SELECT'),
          'anon holds no SELECT privilege on supplier_payments');

set local role anon;
select throws_ok(
  $$select id from public.supplier_payments$$,
  '42501',
  'permission denied for table supplier_payments',
  'an unauthenticated caller cannot read what the business paid out');
reset role;

-- --------------------------------------------------------------- tenancy ----
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is((select count(*) from public.supplier_payments)::int, 1,
          'A sees only its own payments');
select is((select count(*) from public.supplier_payments
            where tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')::int, 0,
          'B''s payment is invisible, not merely unlinked');

select throws_ok(
  $$insert into public.supplier_payments (tenant_id, supplier_id, reference, amount)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','5000000b-0000-4000-8000-00000000000b',
            '9999', 10.00)$$,
  '42501',
  'new row violates row-level security policy for table "supplier_payments"',
  'with check blocks a payment planted in another tenant');

-- A reference is how the business and the bank name the same payment, so it
-- cannot repeat inside a tenant — while two tenants may legitimately both use
-- their own "8709", which is why the index is on (tenant_id, reference).
select throws_ok(
  $$insert into public.supplier_payments (tenant_id, supplier_id, reference, amount)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','5000000a-0000-4000-8000-00000000000a',
            '8709', 1.00)$$,
  '23505',
  null,
  'a payment reference cannot repeat inside one tenant');
reset role;

-- ------------------------------------------------- the opening-balance rule ---
-- Two suppliers, identical opening balances. One has an outstanding bill that
-- accounts for the money; the other has nothing but the opening figure.
insert into public.suppliers (id, tenant_id, supplier_number, name, opening_balance) values
  ('5000000c-0000-4000-8000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'SUP00002','Documented Supplier', 500.00),
  ('5000000d-0000-4000-8000-00000000000d','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'SUP00003','Undocumented Supplier', 500.00);
insert into public.supplier_bills
  (tenant_id, supplier_id, bill_number, issue_date, amount, balance_due, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','5000000c-0000-4000-8000-00000000000c',
        '00099001','2026-07-01',500.00,500.00,'open');

-- The same statement 0015 runs, applied to the pair just inserted.
update public.suppliers s set opening_balance = 0
 where exists (select 1 from public.supplier_bills b
                where b.supplier_id = s.id and b.deleted_at is null
                  and b.balance_due <> 0);

select is((select opening_balance from public.suppliers
            where supplier_number = 'SUP00002'), 0::numeric,
          'an opening balance is cleared once a document accounts for the money');
select is((select opening_balance from public.suppliers
            where supplier_number = 'SUP00003'), 500.00::numeric,
          'and kept where no document does — the figure is not simply discarded');

-- The property the whole rule exists for.
select is(
  (select coalesce(sum(s.opening_balance), 0) + coalesce(sum(b.balance_due), 0)
     from public.suppliers s
     full join public.supplier_bills b on b.supplier_id = s.id
    where coalesce(s.tenant_id, b.tenant_id) = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1000.00::numeric,
  'openings and document balances can be added without counting a debt twice');

select * from finish();
rollback;
