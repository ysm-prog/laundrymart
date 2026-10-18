-- Proof: 0053 — a draft becomes a tax invoice only once the laundry's ABN,
-- address and bank details are set (brief 1.1, 18 October 2026).
--
-- INV00008 was issued with Settings › Invoicing empty and printed "TAX INVOICE"
-- with no ABN, no address and no way to pay it. The app now refuses first; this
-- asserts the layer underneath — a direct status update — refuses the same
-- thing, names what is missing, and leaves every other status move alone.
begin;
select plan(16);

insert into auth.users (id, email) values
  ('0e110000-0000-4000-8000-000000000001','owner@example.com');

insert into public.tenants (id, name) values
  ('0e000000-0000-4000-8000-0000000000aa','Laundry A');
insert into public.memberships (user_id, tenant_id, role) values
  ('0e110000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000aa','super_admin');
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('0ec00000-0000-4000-8000-0000000000aa','0e000000-0000-4000-8000-0000000000aa',
   'CUST00515','ZZ TEST – Claude BA');

insert into public.invoices (id, tenant_id, customer_id, invoice_number, status, total) values
  ('0e100000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-0000000000aa',
   '0ec00000-0000-4000-8000-0000000000aa','INV00008','draft', 25.08),
  ('0e100000-0000-4000-8000-000000000002','0e000000-0000-4000-8000-0000000000aa',
   '0ec00000-0000-4000-8000-0000000000aa','INV00009','draft', 10.00);

-- ------------------------------------------------ nothing set: refused ----
select throws_like(
  $$update public.invoices set status = 'issued' where id = '0e100000-0000-4000-8000-000000000001'$$,
  '%INV00008 cannot be issued until the laundry''s invoice details are complete: add your ABN, your business address, your bank details in Settings%',
  'with nothing in Settings › Invoicing, a draft cannot be issued — and the refusal names all three');

select is((select status from public.invoices where id = '0e100000-0000-4000-8000-000000000001'),
          'draft', 'and it is still a draft');

select throws_like(
  $$update public.invoices set status = 'paid' where id = '0e100000-0000-4000-8000-000000000001'$$,
  '%cannot be issued until%',
  'nor can a draft be written straight to paid — every way out of draft into a document is guarded');

select lives_ok(
  $$update public.invoices set status = 'void', void_reason = 'test data'
     where id = '0e100000-0000-4000-8000-000000000002'$$,
  'voiding a draft stays open whatever the settings say');

-- The MYOB import writes its history straight in as issued; that is not a
-- transition and is deliberately left alone.
select lives_ok(
  $$insert into public.invoices (tenant_id, customer_id, invoice_number, status, total, notes)
    values ('0e000000-0000-4000-8000-0000000000aa','0ec00000-0000-4000-8000-0000000000aa',
            '00321043','issued', 35.00, 'Imported from the MYOB invoices export.')$$,
  'an imported invoice inserted as issued is not refused');
select lives_ok(
  $$update public.invoices set status = 'part_paid', amount_paid = 5
     where invoice_number = '00321043'$$,
  'and an issued invoice still settles with no invoice details set');

-- ------------------------- the live state on 18 October: no bank details ----
update public.tenants
   set abn = '69892278164',
       settings = jsonb_build_object('invoiceProfile', jsonb_build_object(
         'addressLines', jsonb_build_array('1 Example Road', 'Adelaide SA 5000')))
 where id = '0e000000-0000-4000-8000-0000000000aa';

select throws_like(
  $$update public.invoices set status = 'issued' where id = '0e100000-0000-4000-8000-000000000001'$$,
  '%add your bank details in Settings › Invoicing%',
  'with the ABN and address but no bank details, Issue is refused for the bank details alone');

select throws_like(
  $$update public.invoices set status = 'issued' where id = '0e100000-0000-4000-8000-000000000001'$$,
  '%complete: add your bank details in%',
  'and the refusal does not name what is already there');

-- Two of three bank details is not a payment instruction.
update public.tenants
   set settings = jsonb_set(settings, '{invoiceProfile}', settings -> 'invoiceProfile'
         || jsonb_build_object('bsb', '062-000', 'accountNumber', '12345678'))
 where id = '0e000000-0000-4000-8000-0000000000aa';
select throws_like(
  $$update public.invoices set status = 'issued' where id = '0e100000-0000-4000-8000-000000000001'$$,
  '%your bank details%',
  'a BSB and account number with no account name are still refused');

-- ----------------------------------------------------- the ATO checksum ----
update public.tenants
   set abn = '69892278165',
       settings = jsonb_set(settings, '{invoiceProfile,bankAccountName}', '"Laundry A"')
 where id = '0e000000-0000-4000-8000-0000000000aa';
select throws_like(
  $$update public.invoices set status = 'issued' where id = '0e100000-0000-4000-8000-000000000001'$$,
  '%add a valid ABN in Settings%',
  'eleven digits that fail the ATO checksum are refused — a transposed ABN looks right');

-- A hand-edited blob reads as missing, never as an error.
update public.tenants set abn = '69892278164', settings = '{"invoiceProfile": "nonsense"}'
 where id = '0e000000-0000-4000-8000-0000000000aa';
select throws_like(
  $$update public.invoices set status = 'issued' where id = '0e100000-0000-4000-8000-000000000001'$$,
  '%add your business address, your bank details%',
  'a malformed invoice profile blocks issuing rather than breaking it');

-- --------------------------------------------- complete: issued, as the owner
update public.tenants
   set settings = jsonb_build_object('invoiceProfile', jsonb_build_object(
         'addressLines', jsonb_build_array('1 Example Road', 'Adelaide SA 5000'),
         'bankAccountName', 'Laundry A', 'bsb', '062-000', 'accountNumber', '12345678'))
 where id = '0e000000-0000-4000-8000-0000000000aa';

set local role authenticated;
set local "request.jwt.claim.sub" = '0e110000-0000-4000-8000-000000000001';
select lives_ok(
  $$update public.invoices set status = 'issued' where id = '0e100000-0000-4000-8000-000000000001'$$,
  'with the ABN, address and bank details set, the owner issues it');
reset role;

select is((select status from public.invoices where id = '0e100000-0000-4000-8000-000000000001'),
          'issued', 'and it is issued');

-- ---------------------------------------------------- the guard's posture ----
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.invoices'::regclass
            and tgname = 'guard_invoice_issue' and not tgisinternal),
  'the guard is attached to invoices');
select ok(
  not has_function_privilege('authenticated', 'public.guard_invoice_issue()', 'execute')
  and not has_function_privilege('anon', 'public.guard_invoice_issue()', 'execute'),
  'and is not on the RPC surface for anybody');
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.invoices'::regclass
            and tgname = 'guard_invoice_void' and not tgisinternal),
  '0052''s void guard is still beside it');

select * from finish();
rollback;
