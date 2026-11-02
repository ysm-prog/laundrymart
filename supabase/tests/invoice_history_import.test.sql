-- Proof: the MYOB history comes in with its lines, what is owed comes from the
-- opening balance, a second run changes nothing, and nothing else moved.
begin;
select plan(24);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner@example.com'),
  ('22222222-2222-2222-2222-222222222222','counter@example.com');
insert into public.tenants (id, name, abn, settings) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A','51824753556',
   jsonb_build_object('invoiceProfile', jsonb_build_object(
     'addressLines', jsonb_build_array('1 Mill Road'),
     'bankAccountName', 'Laundry A', 'bsb', '062-000', 'accountNumber', '12345678')));
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','customer_service');
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Sloth Cafe');

-- Two MYOB imports the app already holds as headers, and one of its own invoices.
insert into public.invoices
  (id, tenant_id, customer_id, invoice_number, invoice_type, status, source, issue_date, due_date, subtotal, total, amount_paid) values
  ('e0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a',
   '00000100','manual','overdue','import','2026-07-01','2026-07-15',100,100,0),
  ('e0000000-0000-0000-0000-00000000000b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a',
   '00000101','manual','issued','import','2026-08-13','2026-08-20',33.70,33.70,0),
  ('e0000000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a',
   '00000102','manual','issued','app','2026-10-20','2026-11-03',80.20,80.20,0);

create temporary table history_rows as select $json$[
  {"number":"00000099","customer_id":"c0000000-0000-0000-0000-00000000000a","issue_date":"2026-06-01",
   "due_date":"2026-06-08","total":48.40,"tax":4.40,"xero_invoice_id":"x-99","lines":[
     {"sequence":1,"description":"Glass Cloths","quantity":60,"unit_price":0.77,"amount":46.20,"tax_code":"GST"},
     {"sequence":2,"description":"Fuel Surcharge","quantity":1,"unit_price":2.20,"amount":2.20,"tax_code":"GST"}]},
  {"number":"00000100","customer_id":"c0000000-0000-0000-0000-00000000000a","issue_date":"2026-07-01",
   "due_date":"2026-07-15","total":100,"tax":9.09,"xero_invoice_id":"x-100","lines":[
     {"sequence":1,"description":"Towels","quantity":100,"unit_price":1,"amount":100,"tax_code":"GST"}]},
  {"number":"00000101","customer_id":"c0000000-0000-0000-0000-00000000000a","issue_date":"2026-08-13",
   "due_date":"2026-08-20","total":33.70,"tax":3.06,"xero_invoice_id":"x-101","lines":[
     {"sequence":1,"description":"Towels","quantity":10,"unit_price":3.37,"amount":33.70,"tax_code":"GST"}]},
  {"number":"00000102","customer_id":"c0000000-0000-0000-0000-00000000000a","issue_date":"2026-10-20",
   "due_date":"2026-11-03","total":1,"tax":0,"xero_invoice_id":"x-102","lines":[
     {"sequence":1,"description":"Must not land","quantity":1,"unit_price":1,"amount":1,"tax_code":"GST"}]},
  {"number":"00000098","customer_id":null,"issue_date":"2026-06-01","due_date":null,"total":5,"tax":0,
   "xero_invoice_id":"x-98","lines":[]}
]$json$::jsonb as rows;
grant select on history_rows to authenticated;

set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

select throws_ok(
  $$ select public.import_invoice_history('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '[]'::jsonb) $$,
  '42501', null, 'the counter cannot import history');
select throws_ok(
  $$ select public.settle_invoice_history('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', array['00000101']) $$,
  '42501', null, 'nor settle it');

set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is(
  public.import_invoice_history('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', (select rows from history_rows)),
  '{"invoices_added":1,"lines_added_to":2,"invoices_skipped":2}'::jsonb,
  'one new invoice, lines on two headers, the app''s and the customerless row skipped');

select is((select status from public.invoices where invoice_number = '00000099'), 'paid',
  'a history invoice with nothing owed reads paid');
select is((select balance from public.invoices where invoice_number = '00000099'), 0::numeric,
  'and owes nothing');
select is((select source from public.invoices where invoice_number = '00000099'), 'import',
  'and is marked an import, so it is never pushed');
select is((select count(*)::int from public.invoice_lines l join public.invoices i on i.id = l.invoice_id
            where i.invoice_number = '00000099'), 2, 'it carries its lines');
select is((select tax_amount from public.invoices where invoice_number = '00000099'), 4.40::numeric,
  'and Xero''s tax figure');

select is((select status from public.invoices where invoice_number = '00000100'), 'overdue',
  'a header already here keeps its status');
select is((select count(*)::int from public.invoice_lines l join public.invoices i on i.id = l.invoice_id
            where i.invoice_number = '00000100'), 1, 'and gains its lines');
select is((select total from public.invoices where invoice_number = '00000102'), 80.20::numeric,
  'an invoice this app raised is untouched');
select is((select count(*)::int from public.invoice_lines l join public.invoices i on i.id = l.invoice_id
            where i.invoice_number = '00000102'), 0, 'and gains nothing');

select is(
  public.import_invoice_history('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', (select rows from history_rows)),
  '{"invoices_added":0,"lines_added_to":0,"invoices_skipped":5}'::jsonb,
  'a second run adds nothing');
select is((select count(*)::int from public.invoice_lines l join public.invoices i on i.id = l.invoice_id
            where i.invoice_number = '00000099'), 2, 'and doubles no line');

select is(
  public.apply_invoice_openings('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', $json$[
    {"number":"00000100","customer_id":null,"issue_date":"2026-07-01","due_date":"2026-07-15","total":40,"due":40,"xero_invoice_id":"ob-100"},
    {"number":"00000097","customer_id":"c0000000-0000-0000-0000-00000000000a","issue_date":"2026-10-01","due_date":"2026-10-08","total":25,"due":25,"xero_invoice_id":"ob-97"},
    {"number":"00000102","customer_id":null,"issue_date":"2026-10-20","due_date":null,"total":9,"due":9,"xero_invoice_id":"ob-102"}
  ]$json$::jsonb),
  '{"openings_applied":1,"openings_created":1,"openings_over_total":0,"openings_skipped":1}'::jsonb,
  'an opening balance lands on its invoice, makes one that is missing, and skips the app''s');

select is((select balance from public.invoices where invoice_number = '00000100'), 40::numeric,
  'what is owed is the opening balance');
select is((select status from public.invoices where invoice_number = '00000100'), 'part_paid',
  'so that invoice is part paid');
select is((select xero_invoice_id from public.invoices where invoice_number = '00000100'), 'ob-100',
  'and answers to the opening balance''s id');
select is((select balance from public.invoices where invoice_number = '00000097'), 25::numeric,
  'an invoice only Xero knew of comes in owing that');

select is(
  public.settle_invoice_history('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', array['00000101', '00000102']),
  '{"amount":33.70,"invoices":1}'::jsonb,
  'a draft with no opening balance is settled, and the app''s invoice is not');
select is((select status from public.invoices where invoice_number = '00000101'), 'paid', 'it reads paid');
select is((select status from public.invoices where invoice_number = '00000102'), 'issued',
  'the app''s invoice stays issued');

insert into public.invoices (tenant_id, customer_id, invoice_number, status, source, issue_date)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-0000-0000-0000-00000000000a','00000103','draft','app','2026-11-01');
update public.invoices set status = 'issued' where invoice_number = '00000103';
select throws_ok(
  $$ insert into public.invoice_lines (tenant_id, invoice_id, description)
     select tenant_id, id, 'Late line' from public.invoices where invoice_number = '00000103' $$,
  '42501', null, 'the guard still refuses a line on a closed invoice for everybody else');

reset role;
select ok(not has_function_privilege('anon', 'public.import_invoice_history(uuid,jsonb)', 'EXECUTE'),
  'anon cannot call it');

select * from finish();
rollback;
