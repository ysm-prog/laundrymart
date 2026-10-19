-- Proof: 0058. The billing tables' write policies name their verbs, and
-- nobody's access moved.
--
--   * No permissive `for all` is left on the eight money tables, and each has
--     exactly one permissive policy granting SELECT: the advisor's finding.
--   * The roles that write still write, through every verb.
--   * The roles that read still read. Finance and sales are in the write set
--     and lost the redundant SELECT the `for all` granted, so they are asserted
--     reading through `<t>_read` alone.
--   * The roles that could not write still cannot, and an archived invoice is
--     still outside every write. The archive clause came across from the old
--     policy.
--
-- Refusals are asserted by outcome. An UPDATE that a USING clause excludes
-- matches no row and raises nothing, so it is counted afterwards from a session
-- that can see the row (the trap charge_accounts.test.sql records).
begin;
select plan(17);

insert into auth.users (id, email) values
  ('05800000-0000-4000-8000-000000000001','owner@example.com'),
  ('05800000-0000-4000-8000-000000000002','finance@example.com'),
  ('05800000-0000-4000-8000-000000000003','sales@example.com'),
  ('05800000-0000-4000-8000-000000000004','dispatch@example.com');

insert into public.tenants (id, name) values
  ('05800000-0000-4000-8000-0000000000aa','Laundry A');
insert into public.memberships (user_id, tenant_id, role) values
  ('05800000-0000-4000-8000-000000000001','05800000-0000-4000-8000-0000000000aa','super_admin'),
  ('05800000-0000-4000-8000-000000000002','05800000-0000-4000-8000-0000000000aa','finance'),
  ('05800000-0000-4000-8000-000000000003','05800000-0000-4000-8000-0000000000aa','sales'),
  ('05800000-0000-4000-8000-000000000004','05800000-0000-4000-8000-0000000000aa','dispatcher');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('05800000-0000-4000-8000-0000000000c1','05800000-0000-4000-8000-0000000000aa','CUST00001','Harbourview Hotel');
insert into public.service_agreements (id, tenant_id, customer_id, agreement_number, start_date) values
  ('05800000-0000-4000-8000-0000000000e1','05800000-0000-4000-8000-0000000000aa',
   '05800000-0000-4000-8000-0000000000c1','AGR00001','2026-01-01');
insert into public.service_agreement_lines (tenant_id, agreement_id, charge_type, pricing_model, unit_price) values
  ('05800000-0000-4000-8000-0000000000aa','05800000-0000-4000-8000-0000000000e1','wash_only','per_item', 2.50);
insert into public.invoices (id, tenant_id, customer_id, invoice_number, status) values
  ('05800000-0000-4000-8000-0000000000f1','05800000-0000-4000-8000-0000000000aa',
   '05800000-0000-4000-8000-0000000000c1','INV00001','draft'),
  ('05800000-0000-4000-8000-0000000000f2','05800000-0000-4000-8000-0000000000aa',
   '05800000-0000-4000-8000-0000000000c1','INV00002','draft');
update public.invoices set archived_at = now() where id = '05800000-0000-4000-8000-0000000000f2';

-- ------------------------------------------------------------- the shape ---
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and permissive = 'PERMISSIVE' and cmd = 'ALL'
      and tablename in ('credit_note_lines','credit_notes','invoice_lines','invoice_source_jobs',
                        'invoices','job_charge_snapshots','payments','service_agreement_lines')),
  0, 'no permissive for-all policy is left on the money tables');

select is(
  (select count(*)::int from (
     select tablename from pg_policies
      where schemaname = 'public' and permissive = 'PERMISSIVE' and cmd in ('SELECT','ALL')
        and tablename in ('credit_note_lines','credit_notes','invoice_lines','invoice_source_jobs',
                          'invoices','job_charge_snapshots','payments','service_agreement_lines')
      group by tablename having count(*) = 1) one),
  8, 'each money table has exactly one permissive policy granting SELECT');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and permissive = 'PERMISSIVE'
      and cmd in ('INSERT','UPDATE','DELETE') and policyname like '%\_write\_%' escape '\'
      and tablename in ('credit_note_lines','credit_notes','invoice_lines','invoice_source_jobs',
                        'invoices','job_charge_snapshots','payments','service_agreement_lines')),
  24, 'three write policies per table, one verb each');

set local role authenticated;

-- ----------------------------------------------------- the Owner still writes ---
set local "request.jwt.claim.sub" = '05800000-0000-4000-8000-000000000001';
select lives_ok(
  $$insert into public.invoice_lines (tenant_id, invoice_id, description, quantity, unit_price)
    values ('05800000-0000-4000-8000-0000000000aa','05800000-0000-4000-8000-0000000000f1','Towels', 2, 5)$$,
  'the Owner can add a line');
with u as (update public.invoices set notes = 'checked'
               where id = '05800000-0000-4000-8000-0000000000f1' returning 1)
select is((select count(*)::int from u), 1, 'the Owner''s update touches the invoice');
with d as (delete from public.invoice_lines
               where invoice_id = '05800000-0000-4000-8000-0000000000f1' returning 1)
select is((select count(*)::int from d), 1, 'the Owner''s delete removes the line');
with u as (update public.invoices set notes = 'archived?'
               where id = '05800000-0000-4000-8000-0000000000f2' returning 1)
select is((select count(*)::int from u), 0, 'an archived invoice is still outside the Owner''s update');
with u as (update public.service_agreement_lines set unit_price = 2.75
               where agreement_id = '05800000-0000-4000-8000-0000000000e1' returning 1)
select is((select count(*)::int from u), 1, 'the Owner can still re-price a contract line');

-- ------------------------------------------- the write set still reads ---
set local "request.jwt.claim.sub" = '05800000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.invoices), 1,
  'finance still reads the live invoice, through the read policy alone');
select is((select count(*)::int from public.service_agreement_lines), 1,
  'finance still reads the contract''s prices');
select throws_ok(
  $$insert into public.invoice_lines (tenant_id, invoice_id, description)
    values ('05800000-0000-4000-8000-0000000000aa','05800000-0000-4000-8000-0000000000f1','x')$$,
  '42501', null, 'finance is still refused a line by 0025''s restrictive layer');

set local "request.jwt.claim.sub" = '05800000-0000-4000-8000-000000000003';
select is((select count(*)::int from public.service_agreement_lines), 1,
  'sales still reads the contract''s prices');
select is((select count(*)::int from public.invoices), 0,
  'sales still reads no invoice');

-- -------------------------------------- the dispatcher is still outside ---
set local "request.jwt.claim.sub" = '05800000-0000-4000-8000-000000000004';
select is((select count(*)::int from public.invoices), 0, 'the dispatcher reads no invoice');
select throws_ok(
  $$insert into public.invoices (tenant_id, customer_id, invoice_number)
    values ('05800000-0000-4000-8000-0000000000aa','05800000-0000-4000-8000-0000000000c1','INV09999')$$,
  '42501', null, 'the dispatcher cannot raise an invoice');
update public.invoices set notes = 'dispatcher' where id = '05800000-0000-4000-8000-0000000000f1';
delete from public.service_agreement_lines where agreement_id = '05800000-0000-4000-8000-0000000000e1';

reset role;
select is((select notes from public.invoices where id = '05800000-0000-4000-8000-0000000000f1'),
  'checked', 'the dispatcher''s update changed nothing');
select is((select count(*)::int from public.service_agreement_lines
            where agreement_id = '05800000-0000-4000-8000-0000000000e1'),
  1, 'the dispatcher''s delete removed nothing');

select * from finish();
rollback;
