-- Proof: Send back for review works, and it is the only thing that loosened.
--
-- `job_billing.test.sql` proves an approved charge cannot be deleted. That stays
-- true and is re-proved here. What was missing is the other half of
-- `reopenJobCharges`, run as that action runs it: move the job back, then clear
-- the charges. Without 0060 the clear is refused, and the job sits in review with
-- charges nobody can edit or re-price.
begin;
select plan(13);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','finance@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin');
insert into public.customers (id, tenant_id, customer_number, business_name, billing_method) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'CUST00001','Harbourview Hotel','invoice_per_job');
insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, delivery_required, expected_collection_date) values
  ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00001', false, '2026-08-21'),
  ('d0000000-0000-0000-0000-00000000000b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','LJ00002', false, '2026-08-22');
insert into public.laundry_order_items
  (tenant_id, order_id, item_type, quantity_type, exact_quantity) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-00000000000a','towels','exact',10),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-00000000000b','towels','exact',4);

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

-- Both jobs: finished, priced, frozen, approved.
update public.laundry_orders set status = 'in_progress' where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
update public.laundry_orders set status = 'ready_for_delivery' where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
update public.laundry_orders set status = 'completed' where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select public.save_job_charge_snapshot('d0000000-0000-0000-0000-00000000000a',
  '[{"description":"Towels — 10","charge_type":"wash_only","quantity":10,
     "unit_price":2.20,"amount":22.00,"taxable":true}]'::jsonb);
select public.save_job_charge_snapshot('d0000000-0000-0000-0000-00000000000b',
  '[{"description":"Towels — 4","charge_type":"wash_only","quantity":4,
     "unit_price":2.20,"amount":8.80,"taxable":true}]'::jsonb);
select public.freeze_job_charges('d0000000-0000-0000-0000-00000000000a');
select public.freeze_job_charges('d0000000-0000-0000-0000-00000000000b');
update public.laundry_orders set billing_status = 'approved' where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- ======================================== approved stays exactly as locked ==
select throws_ok(
  $$delete from public.job_charge_snapshots
     where order_id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001', 'this job''s charges were approved and can no longer be removed',
  'a frozen charge on an approved job still cannot be deleted');

-- ============================================ reopenJobCharges, as it runs ==
select lives_ok(
  $$update public.laundry_orders
       set billing_status = 'awaiting_review', billing_approved_at = null, billing_approved_by = null
     where id = 'd0000000-0000-0000-0000-00000000000a' and billing_status = 'approved'$$,
  'an approved job can be sent back');

select throws_ok(
  $$update public.job_charge_snapshots set unit_price = 0.01
     where order_id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001', 'this job''s charges were approved and can no longer be changed',
  'sent back or not, the numbers on a frozen row cannot be rewritten in place');

select lives_ok(
  $$delete from public.job_charge_snapshots
     where order_id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'the frozen charges clear once the job is back in review');
select is((select count(*) from public.job_charge_snapshots
            where order_id = 'd0000000-0000-0000-0000-00000000000a')::int, 0,
          'and they are really gone: an RLS-silent delete would pass the line above');

-- ============================ a job left stuck by the old action recovers ==
-- Back in review with its frozen rows still on it, which is the state the bug left.
update public.laundry_orders
   set billing_status = 'awaiting_review', billing_approved_at = null, billing_approved_by = null
 where id = 'd0000000-0000-0000-0000-00000000000b';

select is(public.save_job_charge_snapshot('d0000000-0000-0000-0000-00000000000b',
  '[{"description":"Towels — 4","charge_type":"wash_only","quantity":4,
     "unit_price":2.00,"amount":8.00,"taxable":false}]'::jsonb), 1,
  'saving charges by hand replaces the frozen set');
select is((select unit_price from public.job_charge_snapshots
            where order_id = 'd0000000-0000-0000-0000-00000000000b'), 2.00::numeric,
          'the corrected rate is what is stored');
select is((select taxable from public.job_charge_snapshots
            where order_id = 'd0000000-0000-0000-0000-00000000000b'), false,
          'and the GST answer with it');
select is((select frozen_at from public.job_charge_snapshots
            where order_id = 'd0000000-0000-0000-0000-00000000000b'), null,
          'the replacement is not frozen until it is approved again');

-- ============================================= approve again, then invoice ==
select is(public.freeze_job_charges('d0000000-0000-0000-0000-00000000000b'), 1,
          'the corrected charge freezes on the second approval');
select lives_ok(
  $$update public.laundry_orders set billing_status = 'approved'
     where id = 'd0000000-0000-0000-0000-00000000000b'$$,
  'and the job is approved again');

insert into public.invoices
  (id, tenant_id, customer_id, invoice_number, invoice_type, status) values
  ('a1000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','INV00001','per_job','draft');
insert into public.invoice_source_jobs (tenant_id, invoice_id, order_id)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'a1000000-0000-0000-0000-000000000001',
          'd0000000-0000-0000-0000-00000000000b');
update public.laundry_orders set billing_status = 'invoice_generated'
 where id = 'd0000000-0000-0000-0000-00000000000b';

select throws_ok(
  $$delete from public.job_charge_snapshots
     where order_id = 'd0000000-0000-0000-0000-00000000000b'$$,
  'P0001', 'this job''s charges were approved and can no longer be removed',
  'once invoiced, a frozen charge cannot be deleted');
select throws_ok(
  $$update public.laundry_orders set billing_status = 'awaiting_review'
     where id = 'd0000000-0000-0000-0000-00000000000b'$$,
  NULL, NULL,
  'and an invoiced job cannot be sent back to reach that delete');

select * from finish();
rollback;
