-- Proof: the money on a job is the database's business, not the screen's.
--
-- Three things are defended here, and each one is a claim the brief makes that
-- would be worthless if it were only true in React.
--
--  1. **Completion never bills anybody.** Finishing the work sets
--     `billing_status = awaiting_review` and stops. Nothing generates an
--     invoice, and no path skips review.
--  2. **An approved price is immutable.** Once frozen, a charge row cannot be
--     updated or deleted by anyone, whatever they hold — because "changing a
--     customer's rate tomorrow must never change an invoice from yesterday" is
--     only true if the historical rows are actually unwritable.
--  3. **Operational roles cannot read money.** A driver and a dispatcher hold a
--     real session and the anon key reaches PostgREST directly, so "dispatch
--     sees no pricing" has to be an RLS fact. Asserted by *reading as them*,
--     not by inspecting policy text.
--
-- Plus the one-job-one-invoice constraint, and the release path that makes
-- voiding a wrong invoice possible without stranding the work.
begin;
select plan(54);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','finance@example.com'),
  ('22222222-2222-2222-2222-222222222222','dispatch@example.com'),
  ('33333333-3333-3333-3333-333333333333','driver@example.com'),
  ('44444444-4444-4444-4444-444444444444','other@example.com');

insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');

insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dispatcher'),
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('44444444-4444-4444-4444-444444444444','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.customers (id, tenant_id, customer_number, business_name, billing_method) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'CUST00001','Harbourview Hotel','monthly_consolidated'),
  ('c0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'CUST00001','Southern Cafe','invoice_per_job'),
  -- A second customer in tenant A, so the rate-card ownership guard can be
  -- tested where it actually bites: inside one tenant, both rows visible.
  ('c0000000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'CUST00002','Quay Bistro','invoice_per_job');

-- A rate card: an agreement version, which is the pricing model this app
-- already had. Nothing new was invented for pricing.
insert into public.service_agreements
  (id, tenant_id, customer_id, agreement_number, version, status, start_date) values
  ('e0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','AGR00001', 1, 'active', '2026-01-01');

insert into public.service_agreement_lines
  (id, tenant_id, agreement_id, charge_type, pricing_model, unit_price, laundry_item_type) values
  ('f0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'e0000000-0000-0000-0000-00000000000a','wash_only','per_item', 2.50, 'towels');

-- A customer-pickup job, so it can reach `completed` without a driver.
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

-- ------------------------------------------------------------------ anon ----
-- PostgREST hands an unauthenticated request to `anon`. Asserted twice: the
-- privilege itself, and the attempt matched on its message — 42501 alone proves
-- nothing here, because our own membership guards raise it too.
select ok(not has_table_privilege('anon', 'public.job_charge_snapshots', 'SELECT'),
          'anon holds no SELECT privilege on job_charge_snapshots');
select ok(not has_table_privilege('anon', 'public.invoice_source_jobs', 'SELECT'),
          'anon holds no SELECT privilege on invoice_source_jobs');
select ok(not has_function_privilege('anon', 'public.save_job_charge_snapshot(uuid, jsonb)', 'EXECUTE'),
          'anon cannot execute save_job_charge_snapshot');
select ok(not has_function_privilege('anon', 'public.freeze_job_charges(uuid)', 'EXECUTE'),
          'anon cannot execute freeze_job_charges');
select ok(not has_function_privilege('anon', 'public.can_read_billing(uuid)', 'EXECUTE'),
          'anon cannot ask can_read_billing about anybody');

set local role anon;
select throws_ok(
  $$select id from public.job_charge_snapshots$$,
  '42501',
  'permission denied for table job_charge_snapshots',
  'an unauthenticated caller cannot read a job''s charges');
reset role;

-- ==================================== completion never bills ================
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is((select billing_status from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a'), 'pending',
          'a new job is not billable yet');

select lives_ok(
  $$update public.laundry_orders set status = 'in_progress'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'the job starts');
select lives_ok(
  $$update public.laundry_orders set status = 'ready_for_delivery'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'the job is ready');
select lives_ok(
  $$update public.laundry_orders set status = 'completed'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'the customer collects it');

-- **The claim the whole feature rests on.**
select is((select billing_status from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000a'), 'awaiting_review',
          'completing a job puts it in front of a person, not on an invoice');
select is((select count(*) from public.invoices)::int, 0,
          'completing a job generated no invoice');

-- ------------------------------------------------- review cannot be skipped --
select throws_ok(
  $$update public.laundry_orders set billing_status = 'invoice_generated'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'a job cannot go from billing state awaiting_review to invoice_generated',
  'a job cannot be invoiced without being approved first');

-- Approval needs charges to approve.
select throws_ok(
  $$update public.laundry_orders set billing_status = 'approved'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'this job has no charges to approve',
  'approving an unpriced job is refused');

-- Approval needs the work to be finished. LJ00002 is still `new`.
select is((select billing_status from public.laundry_orders
            where id = 'd0000000-0000-0000-0000-00000000000b'), 'pending',
          'the second job is still in the plant');

-- ------------------------------------------------------------- pricing ------
select is(public.save_job_charge_snapshot(
  'd0000000-0000-0000-0000-00000000000a',
  '[{"description":"Towels — 10","charge_type":"wash_only","quantity":10,
     "unit_price":2.50,"amount":25.00,"taxable":true,
     "source_agreement_id":"e0000000-0000-0000-0000-00000000000a",
     "source_agreement_line_id":"f0000000-0000-0000-0000-00000000000a",
     "source_laundry_item_type":"towels","pricing_model":"per_item"}]'::jsonb), 1,
  'the job is priced from its rate card');

select is((select amount from public.job_charge_snapshots
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), 25.00,
          'the charge is what the rate card said');

-- Re-pricing while awaiting review replaces the set, in one transaction.
select is(public.save_job_charge_snapshot(
  'd0000000-0000-0000-0000-00000000000a',
  '[{"description":"Towels — 10","charge_type":"wash_only","quantity":10,
     "unit_price":3.00,"amount":30.00,"taxable":true}]'::jsonb), 1,
  'a job awaiting review can be re-priced');
select is((select count(*) from public.job_charge_snapshots
            where order_id = 'd0000000-0000-0000-0000-00000000000a')::int, 1,
          're-pricing replaces rather than appends');

-- ------------------------------------------- 0039: coding the charge --------
-- MYOB puts the item and the account code on the line as it is written. Before
-- 0039 a charge could name an item (only if the pricer supplied one) and could
-- never name an account, so a hand-added charge reached the invoice uncoded and
-- somebody re-keyed the code there. Asserted by outcome: the writer really
-- carries the column, and the guard refuses the two ways it could be wrong.
insert into public.gl_accounts (id, tenant_id, code, name, account_type, tax_code, level) values
  ('9a000000-0000-4000-8000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '4-1100','Towels - Black','Income','GST',2),
  ('9a000000-0000-4000-8000-00000000000b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '0-INCOME','Income','Income',null,1);
update public.gl_accounts set is_header = true where id = '9a000000-0000-4000-8000-00000000000b';

select is(public.save_job_charge_snapshot(
  'd0000000-0000-0000-0000-00000000000a',
  '[{"description":"Towels — 10","charge_type":"wash_only","quantity":10,
     "unit_price":3.00,"amount":30.00,"taxable":true,
     "gl_account_id":"9a000000-0000-4000-8000-00000000000a"}]'::jsonb), 1,
  'a charge can be coded to an account as it is written');

select is((select gl_account_id from public.job_charge_snapshots
            where order_id = 'd0000000-0000-0000-0000-00000000000a'),
          '9a000000-0000-4000-8000-00000000000a'::uuid,
          'and the writer really carries it — the silent failure this guards against');

-- Uncoded stays legal: the invoice counts the gap rather than refusing the work.
select is(public.save_job_charge_snapshot(
  'd0000000-0000-0000-0000-00000000000a',
  '[{"description":"Towels — 10","charge_type":"wash_only","quantity":10,
     "unit_price":3.00,"amount":30.00,"taxable":true}]'::jsonb), 1,
  'a charge with no account is still accepted');
select is((select gl_account_id from public.job_charge_snapshots
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), null,
          'and carries no code');

select throws_ok(
  $$select public.save_job_charge_snapshot(
      'd0000000-0000-0000-0000-00000000000a',
      '[{"description":"Nonsense","charge_type":"other","quantity":1,
         "unit_price":1,"amount":1,"taxable":true,
         "gl_account_id":"9a000000-0000-4000-8000-00000000000b"}]'::jsonb)$$,
  'P0001',
  'that is a heading, not an account you can code to',
  'nothing can be coded to a classification heading');

select throws_ok(
  $$select public.save_job_charge_snapshot(
      'd0000000-0000-0000-0000-00000000000a',
      '[{"description":"Nonsense","charge_type":"other","quantity":1,
         "unit_price":1,"amount":1,"taxable":true,
         "gl_account_id":"9b000000-0000-4000-8000-00000000000b"}]'::jsonb)$$,
  'P0001',
  'that account could not be found',
  'an id that is not an account of this laundry is refused by name');

-- The trigger function must not be reachable as RPC. 0019 recorded this trap and
-- 0036 shipped without it once; asserted here so a third time fails the suite.
select ok(
  not has_function_privilege('authenticated', 'public.guard_job_charge_account()', 'EXECUTE'),
  'the charge-account guard is not published at /rest/v1/rpc');

-- Put the coded charge back, so the approval block below freezes a coded row.
select is(public.save_job_charge_snapshot(
  'd0000000-0000-0000-0000-00000000000a',
  '[{"description":"Towels — 10","charge_type":"wash_only","quantity":10,
     "unit_price":3.00,"amount":30.00,"taxable":true,
     "gl_account_id":"9a000000-0000-4000-8000-00000000000a"}]'::jsonb), 1,
  'the coded charge is restored for the approval block below');

-- ------------------------------------------------------------ approval ------
select is(public.freeze_job_charges('d0000000-0000-0000-0000-00000000000a'), 1,
          'approval freezes the charge lines');
select lives_ok(
  $$update public.laundry_orders set billing_status = 'approved'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'a completed, priced job can be approved');
select isnt((select billing_approved_at from public.laundry_orders
              where id = 'd0000000-0000-0000-0000-00000000000a'), NULL,
          'approval stamps when it happened');

-- ============================== the frozen price is immutable ===============
-- The heart of it. `super_admin` is running these — the most privileged role
-- there is — and it still cannot rewrite history.
select throws_ok(
  $$update public.job_charge_snapshots set unit_price = 0.01
     where order_id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'this job''s charges were approved and can no longer be changed',
  'an approved charge cannot be re-priced, even by a super admin');

select throws_ok(
  $$delete from public.job_charge_snapshots
     where order_id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'this job''s charges were approved and can no longer be removed',
  'an approved charge cannot be deleted');

select throws_ok(
  $$select public.save_job_charge_snapshot('d0000000-0000-0000-0000-00000000000a', '[]'::jsonb)$$,
  'P0001',
  'charges can only be set while a job is awaiting review',
  're-pricing an approved job is refused at the door');

-- **Changing the rate card does not move the approved price.** This is the
-- literal sentence from the brief, asserted.
select lives_ok(
  $$update public.service_agreement_lines set unit_price = 99.00
     where id = 'f0000000-0000-0000-0000-00000000000a'$$,
  'tomorrow''s rate can be changed');
select is((select unit_price from public.job_charge_snapshots
            where order_id = 'd0000000-0000-0000-0000-00000000000a'), 3.00,
          'yesterday''s approved job keeps the price it was approved at');

-- ================================= one job, one invoice =====================
insert into public.invoices
  (id, tenant_id, customer_id, invoice_number, invoice_type, status) values
  ('a1000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','INV00001','per_job','draft'),
  ('a1000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','INV00002','per_job','draft');

select lives_ok(
  $$insert into public.invoice_source_jobs (tenant_id, invoice_id, order_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'a1000000-0000-0000-0000-000000000001',
            'd0000000-0000-0000-0000-00000000000a')$$,
  'the approved job goes onto an invoice');

select throws_ok(
  $$insert into public.invoice_source_jobs (tenant_id, invoice_id, order_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'a1000000-0000-0000-0000-000000000002',
            'd0000000-0000-0000-0000-00000000000a')$$,
  '23505'::char(5), NULL,
  'the same job cannot be invoiced twice');

-- `invoices.source_job_id` and the link table are two records of one fact, so
-- the guard refuses any way they could disagree.
select throws_ok(
  $$update public.invoices set source_job_id = 'd0000000-0000-0000-0000-00000000000b'
     where id = 'a1000000-0000-0000-0000-000000000001'$$,
  'P0001',
  'an invoice''s source job must be one of the jobs it bills',
  'an invoice cannot name a source job it does not carry');

select lives_ok(
  $$update public.invoices set source_job_id = 'd0000000-0000-0000-0000-00000000000a'
     where id = 'a1000000-0000-0000-0000-000000000001'$$,
  'an invoice may name a job it actually bills');

select lives_ok(
  $$update public.laundry_orders set billing_status = 'invoice_generated'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'the job moves to invoice generated');

-- Generating is not sending: nothing here says the customer has been told.
select is((select emailed_at from public.invoices
            where id = 'a1000000-0000-0000-0000-000000000001'), NULL,
          'generating an invoice sent nothing');

-- ----------------------------------------------- release, only after a void --
select throws_ok(
  $$update public.laundry_orders set billing_status = 'approved'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'this job is still on an invoice — void that invoice first',
  'an invoiced job cannot be quietly re-billed');

select lives_ok(
  $$delete from public.invoice_source_jobs
     where order_id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'voiding an invoice unlinks its jobs');

select lives_ok(
  $$update public.laundry_orders set billing_status = 'approved'
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'once nothing invoices it, the work is billable again');

-- --------------------------------------------------- the rate card belongs --
-- Deliberately *within* one tenant. A cross-tenant attempt is stopped by RLS
-- long before the guard, so it would prove nothing about the guard: the update
-- would simply match no rows and succeed silently. The real risk this defends
-- against is a mis-typed id naming the customer next door — same tenant, fully
-- visible, and it would freeze somebody else's negotiated rates onto this
-- customer's jobs permanently.
select throws_ok(
  $$update public.customers
       set rate_card_agreement_id = 'e0000000-0000-0000-0000-00000000000a'
     where id = 'c0000000-0000-0000-0000-00000000000c'$$,
  'P0001',
  'a rate card must belong to the customer it prices',
  'a customer cannot be priced on another customer''s rate card');

select lives_ok(
  $$update public.customers
       set rate_card_agreement_id = 'e0000000-0000-0000-0000-00000000000a'
     where id = 'c0000000-0000-0000-0000-00000000000a'$$,
  'a customer can be pointed at their own rate card');

-- ============================ operational roles read no money ===============
-- Not "the button is hidden" — read as them and count the rows.
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is((select count(*) from public.job_charge_snapshots)::int, 0,
          'a dispatcher reads no job charges');
select is((select count(*) from public.invoices)::int, 0,
          'a dispatcher reads no invoices');
select is((select count(*) from public.service_agreement_lines)::int, 0,
          'a dispatcher reads no rate lines');
-- The agreement *header* stays readable: when a customer is served and on what
-- pattern is operational information dispatch genuinely needs.
select is((select count(*) from public.service_agreements)::int, 1,
          'a dispatcher still reads the contract itself');
-- And the job, minus its money — dispatch plans this work.
select is((select count(*) from public.laundry_orders)::int, 2,
          'a dispatcher still reads the jobs themselves');

set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
select is((select count(*) from public.job_charge_snapshots)::int, 0,
          'a driver reads no job charges');
select is((select count(*) from public.invoices)::int, 0,
          'a driver reads no invoices');

-- ---------------------------------------------------------- cross-tenant ----
set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';
select is((select count(*) from public.job_charge_snapshots)::int, 0,
          'another tenant''s super admin reads no charges of ours');

select * from finish();
rollback;
