-- Proof: the two steps an import finishes with (0016).
--
-- Both deserve a proof rather than a code review. `clear_superseded_openings`
-- zeroes money columns, so the interesting question is not whether it works but
-- whether it is *confined* — to the caller's own tenant, and to openings a
-- document actually accounts for. `park_number_sequence` guards the invoice and
-- customer numbering, where the failure mode is a duplicate number handed out
-- months later, long after anyone would connect it to an import.
begin;
select plan(8);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@example.com'),
  ('22222222-2222-2222-2222-222222222222','b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

-- Two customers in A: one whose debt an invoice now carries, one whose does not.
insert into public.customers (id, tenant_id, customer_number, business_name,
                              opening_balance, opening_balance_overdue) values
  ('c0000001-0000-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'CUST00001','Documented Pty Ltd', 240.00, 240.00),
  ('c0000002-0000-4000-8000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'CUST00002','Undocumented Pty Ltd', 55.00, 0.00);
insert into public.invoices (tenant_id, customer_id, invoice_number, issue_date, total, amount_paid)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000001-0000-4000-8000-000000000001',
        '00413595','2026-08-12', 240.00, 0.00);

-- B carries an opening that a document also accounts for. A's call must not
-- touch it: that is the whole tenant boundary, expressed in money.
insert into public.customers (id, tenant_id, customer_number, business_name, opening_balance) values
  ('c0000003-0000-4000-8000-000000000003','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'CUST00001','Other Tenant Pty Ltd', 999.00);
insert into public.invoices (tenant_id, customer_id, invoice_number, issue_date, total, amount_paid)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','c0000003-0000-4000-8000-000000000003',
        '00500001','2026-08-12', 999.00, 0.00);

insert into public.suppliers (id, tenant_id, supplier_number, name, opening_balance) values
  ('50000001-0000-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'SUP00001','Pak-Rite', 3668.57);
insert into public.supplier_bills (tenant_id, supplier_id, bill_number, issue_date, amount, balance_due)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','50000001-0000-4000-8000-000000000001',
        'PB0001','2026-08-01', 3668.57, 3668.57);

-- ------------------------------------------------------------------ anon ----
-- 0011's rule: PostgREST publishes `public` as RPC, so a grant here is an
-- unauthenticated endpoint. `rls_coverage` asserts the privilege; this asserts
-- the two by name, because these are the ones that write money columns.
select ok(not has_function_privilege('anon', 'public.clear_superseded_openings(uuid)', 'EXECUTE'),
          'anon cannot execute clear_superseded_openings');
select ok(not has_function_privilege('anon', 'public.park_number_sequence(uuid, text, text, integer)', 'EXECUTE'),
          'anon cannot execute park_number_sequence');

-- ------------------------------------------------------------- membership ---
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select throws_ok(
  $$select public.clear_superseded_openings('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501',
  null,
  'a member of A cannot clear openings in B');

-- ---------------------------------------------------------------- clearing ---
select is(public.clear_superseded_openings('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 2,
          'exactly the two parties whose debt a document carries are cleared');

select is(
  (select opening_balance + opening_balance_overdue from public.customers
    where id = 'c0000001-0000-4000-8000-000000000001'),
  0::numeric,
  'an opening is cleared once an invoice accounts for the same money');

select is(
  (select opening_balance from public.customers where id = 'c0000002-0000-4000-8000-000000000002'),
  55.00::numeric,
  'and kept where no document does — the figure is not simply discarded');

reset role;
select is(
  (select opening_balance from public.customers where id = 'c0000003-0000-4000-8000-000000000003'),
  999.00::numeric,
  'B''s opening is untouched by a call made from A');

-- ---------------------------------------------------------------- numbering ---
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select public.park_number_sequence('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'customer', 'CUST', 509);
-- A smaller export must never wind the sequence back over numbers already
-- handed out, or the app reissues a customer number that is already in use.
select is(public.park_number_sequence('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'customer', 'CUST', 12), 509,
          'a later, smaller import cannot wind a number sequence backwards');

select * from finish();
rollback;
