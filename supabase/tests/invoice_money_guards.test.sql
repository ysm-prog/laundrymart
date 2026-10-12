-- Proof: 0052 — a credit note counts, a paid invoice stays paid.
--
-- The 12 October end-to-end test on INV00006 found three things the database
-- let through: a paid and credited invoice voided, two credit notes adding up
-- to more than the invoice, and a credit note that left the balance where it
-- was. Each is asserted here by running the guard against real rows.
begin;
select plan(16);

insert into public.tenants (id, name, gst_rate) values
  ('a0000000-0000-4000-8000-0000000000e2','Laundry A', 0.10);
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-4000-8000-0000000000e2','a0000000-0000-4000-8000-0000000000e2',
   'CUST00001','ZZ Test Demo Laundry');
insert into public.invoices
  (id, tenant_id, customer_id, invoice_number, issue_date, status, subtotal, total) values
  ('40000000-0000-4000-8000-0000000000e2','a0000000-0000-4000-8000-0000000000e2',
   'c0000000-0000-4000-8000-0000000000e2','INV00006', current_date, 'issued', 74.80, 74.80);

-- --------------------------------------------- a credit reduces the balance
insert into public.payments (tenant_id, invoice_id, customer_id, amount) values
  ('a0000000-0000-4000-8000-0000000000e2','40000000-0000-4000-8000-0000000000e2',
   'c0000000-0000-4000-8000-0000000000e2', 30.00);
update public.invoices set amount_paid = 30.00 where id='40000000-0000-4000-8000-0000000000e2';

insert into public.credit_notes
  (id, tenant_id, customer_id, invoice_id, credit_note_number, status, subtotal, tax_amount, total) values
  ('50000000-0000-4000-8000-0000000000e1','a0000000-0000-4000-8000-0000000000e2',
   'c0000000-0000-4000-8000-0000000000e2','40000000-0000-4000-8000-0000000000e2',
   'CN00001','issued', 11.00, 1.00, 11.00);

select is((select amount_credited from public.invoices where id='40000000-0000-4000-8000-0000000000e2'),
          11.00::numeric, 'an issued credit note is carried on the invoice');
select is((select balance from public.invoices where id='40000000-0000-4000-8000-0000000000e2'),
          33.80::numeric, 'and reduces the balance: 74.80 - 30 paid - 11 credited, not 44.80');

-- ------------------------------------------------- the cumulative cap ------
select throws_like(
  $$insert into public.credit_notes
      (tenant_id, customer_id, invoice_id, credit_note_number, status, subtotal, tax_amount, total)
    values ('a0000000-0000-4000-8000-0000000000e2','c0000000-0000-4000-8000-0000000000e2',
            '40000000-0000-4000-8000-0000000000e2','CN00002','issued', 70, 6.36, 70)$$,
  '%would total $81.00, more than the $44.80 still owed%',
  'a second credit that takes the total past what is owed is refused — the $11 + $70 case');

-- Opened at zero and totalled later (how the action writes one): the growth is judged.
insert into public.credit_notes
  (id, tenant_id, customer_id, invoice_id, credit_note_number, status, subtotal, tax_amount, total) values
  ('50000000-0000-4000-8000-0000000000e2','a0000000-0000-4000-8000-0000000000e2',
   'c0000000-0000-4000-8000-0000000000e2','40000000-0000-4000-8000-0000000000e2',
   'CN00003','issued', 0, 0, 0);
select throws_like(
  $$update public.credit_notes set subtotal = 40, total = 40
     where id = '50000000-0000-4000-8000-0000000000e2'$$,
  '%still owed%',
  'raising a note''s total past the cap is refused just as an insert is');
select lives_ok(
  $$update public.credit_notes set subtotal = 33.80, total = 33.80
     where id = '50000000-0000-4000-8000-0000000000e2'$$,
  'crediting exactly what is still owed is allowed');
select is((select balance from public.invoices where id='40000000-0000-4000-8000-0000000000e2'),
          0.00::numeric, 'and leaves nothing owing');

-- ------------------------------------------------ a paid invoice is not voided
select throws_like(
  $$update public.invoices set status = 'void', void_reason = 'test'
     where id = '40000000-0000-4000-8000-0000000000e2'$$,
  '%has payments recorded against it%',
  'an invoice with a payment cannot be voided');

delete from public.payments where invoice_id = '40000000-0000-4000-8000-0000000000e2';
update public.invoices set amount_paid = 0 where id='40000000-0000-4000-8000-0000000000e2';

select throws_like(
  $$update public.invoices set status = 'void', void_reason = 'test'
     where id = '40000000-0000-4000-8000-0000000000e2'$$,
  '%credit notes issued against it%',
  'nor one with an issued credit note');

-- Voiding a credit note is always possible — it only ever shrinks the credit.
select lives_ok(
  $$update public.credit_notes set status = 'void' where invoice_id = '40000000-0000-4000-8000-0000000000e2'$$,
  'voiding the credit notes is allowed');
select is((select amount_credited from public.invoices where id='40000000-0000-4000-8000-0000000000e2'),
          0.00::numeric, 'and takes them off the invoice again');
select lives_ok(
  $$update public.invoices set status = 'void', void_reason = 'test'
     where id = '40000000-0000-4000-8000-0000000000e2'$$,
  'with no money against it, the invoice voids');

select throws_like(
  $$insert into public.credit_notes
      (tenant_id, customer_id, invoice_id, credit_note_number, status, subtotal, tax_amount, total)
    values ('a0000000-0000-4000-8000-0000000000e2','c0000000-0000-4000-8000-0000000000e2',
            '40000000-0000-4000-8000-0000000000e2','CN00004','issued', 1, 0, 1)$$,
  '%is void, so it cannot be credited%',
  'a void invoice cannot be credited');

-- --------------------------------------- a reversed payment un-pays the job
insert into public.invoices
  (id, tenant_id, customer_id, invoice_number, issue_date, status, subtotal, total, amount_paid) values
  ('40000000-0000-4000-8000-0000000000e3','a0000000-0000-4000-8000-0000000000e2',
   'c0000000-0000-4000-8000-0000000000e2','INV00007', current_date, 'paid', 20, 20, 20);
insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, delivery_required, expected_collection_date,
   billing_status) values
  ('d0000000-0000-4000-8000-0000000000e3','a0000000-0000-4000-8000-0000000000e2',
   'c0000000-0000-4000-8000-0000000000e2','LJ00027', false, current_date, 'paid');
insert into public.invoice_source_jobs (tenant_id, invoice_id, order_id) values
  ('a0000000-0000-4000-8000-0000000000e2','40000000-0000-4000-8000-0000000000e3',
   'd0000000-0000-4000-8000-0000000000e3');

select throws_like(
  $$update public.laundry_orders set billing_status = 'invoice_sent'
     where id = 'd0000000-0000-4000-8000-0000000000e3'$$,
  '%invoice is still paid%',
  'a job on a paid invoice stays paid');

update public.invoices set status = 'part_paid', amount_paid = 0
 where id = '40000000-0000-4000-8000-0000000000e3';
select lives_ok(
  $$update public.laundry_orders set billing_status = 'invoice_sent'
     where id = 'd0000000-0000-4000-8000-0000000000e3'$$,
  'once its invoice is no longer paid, the job goes back to invoice sent');
select throws_like(
  $$update public.laundry_orders set billing_status = 'approved'
     where id = 'd0000000-0000-4000-8000-0000000000e3'$$,
  '%still on an invoice%',
  '0017''s release rule survived the rebuild');

select is((select count(*)::int from pg_proc
            where proname in ('sync_invoice_credits','guard_invoice_void')
              and has_function_privilege('authenticated', oid, 'execute')),
          0, 'neither SECURITY DEFINER guard is on the RPC surface');

select * from finish();
rollback;
