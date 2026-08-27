-- Proof: a kind of charge knows where its money lands, and only the people who
-- keep the books may say so — and a frozen charge's *code* may still be
-- corrected while the invoice is a draft, though nothing about its money can.
--
-- Three things are being defended.
--
-- The first is **the gate**. `charge_type_accounts` holds nothing but account
-- ids, and 0036 put the chart of accounts behind `purchases.read` after a board
-- login was proved to read all 268 accounts and rename one. A map pointing into
-- that chart, gated more weakly than the chart, would be a side channel onto it.
-- So this is asserted by *outcome* as five real sessions, not by reading policy
-- text: a refused SELECT is an empty result and a refused INSERT is 42501.
--
-- The second is **the coherence rule** every writer of an account id obeys: not
-- a heading, not another laundry's, and not one that does not exist. Stated a
-- third time in the schema because this is a third writer, and a rule enforced
-- in two places of three is a rule with a hole in it.
--
-- The third is the **narrowing of the frozen-charge guard**, which is the half
-- that could go wrong quietly. 0017 froze an approved charge whole. 0044 lets
-- `gl_account_id` — and nothing else — still move, because the running draft
-- re-derives every job line from the charges, so a code written onto the line
-- would be discarded the next time somebody approved a job. The assertions below
-- prove both directions: the money is exactly as immutable as it was, and the
-- code stops being changeable the moment the invoice leaves the building.
begin;
select plan(19);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner-a@example.com'),
  ('33333333-3333-3333-3333-333333333333','driver-a@example.com'),
  ('44444444-4444-4444-4444-444444444444','auditor-a@example.com'),
  ('22222222-2222-2222-2222-222222222222','owner-b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('44444444-4444-4444-4444-444444444444','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','auditor'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','ABC Hotel');

-- A postable income account, a heading, and one belonging to the other laundry,
-- so every refusal below is proved against a real row rather than a made-up uuid.
insert into public.gl_accounts (id, tenant_id, code, name, account_type, is_header) values
  ('ac000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '4-2000','Delivery Fees Collected','Income',false),
  ('ac000000-0000-0000-0000-00000000000c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '4-9000','Other Income','Income',false),
  ('ac000000-0000-0000-0000-0000000000fe','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '4-0000','Income','Income',true),
  ('ac000000-0000-0000-0000-0000000000bb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '4-2000','Their Delivery Fees','Income',false);

-- An approved job carrying one frozen fuel levy: the exact line the report was
-- made about, which names no item and so had no tier to be coded from.
insert into public.laundry_orders
    (id, tenant_id, customer_id, order_number, status, billing_status,
     received_at, delivery_required, expected_delivery_date, delivery_address)
  values ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'c0000000-0000-0000-0000-00000000000a','LJ00007','completed','approved',
          now(), true, current_date + 1, '1 Test St');
insert into public.job_charge_snapshots
    (id, tenant_id, order_id, description, charge_type, quantity, unit_price, amount,
     taxable, frozen_at)
  values ('cc000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'd0000000-0000-0000-0000-00000000000a','fuel','fuel_levy',1,50,50,true,now());

-- ================================================== the gate, as sessions ===
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select lives_ok(
  $$insert into public.charge_type_accounts (tenant_id, charge_type, gl_account_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','fuel_levy',
            'ac000000-0000-0000-0000-00000000000a')$$,
  'the owner may say where a fuel levy lands');

select is(
  (select count(*)::int from public.charge_type_accounts), 1,
  'and reads it back');

select throws_ok(
  $$insert into public.charge_type_accounts (tenant_id, charge_type, gl_account_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','minimum_service_fee',
            'ac000000-0000-0000-0000-0000000000fe')$$,
  'that is a heading, not an account you can code to',
  'a heading is not an account anything can be coded to');

select throws_ok(
  $$insert into public.charge_type_accounts (tenant_id, charge_type, gl_account_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','minimum_service_fee',
            'ac000000-0000-0000-0000-0000000000bb')$$,
  'that account belongs to another business',
  'another laundry''s account is refused, so the map cannot cross the boundary');

select throws_ok(
  $$insert into public.charge_type_accounts (tenant_id, charge_type, gl_account_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','fuel_levy',
            'ac000000-0000-0000-0000-00000000000c')$$,
  '23505', null,
  'one answer per kind of charge, so "which account?" cannot depend on the plan');

-- A driver holds no `purchases.*` at all. This is the session 0036 was written
-- after, and the reason the read is gated at all.
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
select is(
  (select count(*)::int from public.charge_type_accounts), 0,
  'a driver reads none of it');
select throws_ok(
  $$insert into public.charge_type_accounts (tenant_id, charge_type, gl_account_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bag_charge',
            'ac000000-0000-0000-0000-00000000000a')$$,
  '42501', null,
  'and cannot decide where the laundry''s money posts');

-- The auditor is the whole reason read and write are two role lists.
set local "request.jwt.claim.sub" = '44444444-4444-4444-4444-444444444444';
select is(
  (select count(*)::int from public.charge_type_accounts), 1,
  'the auditor reads the map');
-- **By outcome, not by `throws_ok`, and the first draft of this proof got it
-- wrong.** An UPDATE a policy's USING clause excludes matches no rows and raises
-- *nothing at all* — the silent zero-rows failure this repo has shipped twice —
-- so an assertion that waits for 42501 passes the moment the gate is removed.
-- An INSERT is different: its WITH CHECK really does raise, which is why the
-- driver's insert above is asserted the other way.
update public.charge_type_accounts set gl_account_id = 'ac000000-0000-0000-0000-00000000000c';
select is(
  (select gl_account_id from public.charge_type_accounts where charge_type = 'fuel_levy'),
  'ac000000-0000-0000-0000-00000000000a'::uuid,
  'and cannot change it — the write matches no row rather than raising');

set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select is(
  (select count(*)::int from public.charge_type_accounts), 0,
  'the other laundry sees nothing of it');

-- ======================================= a tidied chart, not a broken one ===
set local role postgres;
delete from public.gl_accounts where id = 'ac000000-0000-0000-0000-00000000000a';
select is(
  (select gl_account_id from public.charge_type_accounts where charge_type = 'fuel_levy'), null,
  'deleting the account clears the default rather than leaving a dangling id');
select is(
  (select count(*)::int from public.charge_type_accounts where charge_type = 'fuel_levy'), 1,
  'the row survives, so nothing has to guess whether a default was ever set');

-- ================================ the frozen charge: money, and code apart ==
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select throws_ok(
  $$update public.job_charge_snapshots set amount = 999
     where id = 'cc000000-0000-0000-0000-00000000000a'$$,
  'P0001', 'this job''s charges were approved and can no longer be changed',
  'the money on an approved charge is exactly as immutable as it was');

select throws_ok(
  $$delete from public.job_charge_snapshots
     where id = 'cc000000-0000-0000-0000-00000000000a'$$,
  'P0001', 'this job''s charges were approved and can no longer be removed',
  'and it still cannot be deleted');

select lives_ok(
  $$update public.job_charge_snapshots
       set gl_account_id = 'ac000000-0000-0000-0000-00000000000c'
     where id = 'cc000000-0000-0000-0000-00000000000a'$$,
  'but where it lands may still be corrected');

-- **The row count, not `lives_ok`.** A restrictive policy refusing a caller
-- writes zero rows with no error at all — the silence this project has shipped
-- twice — so the assertion that matters is that the write actually landed.
select is(
  (select gl_account_id from public.job_charge_snapshots
    where id = 'cc000000-0000-0000-0000-00000000000a'),
  'ac000000-0000-0000-0000-00000000000c'::uuid,
  'and the correction really landed, rather than matching no rows in silence');

-- --------------------------------------------- on a draft, then once issued --
insert into public.invoices
    (id, tenant_id, customer_id, invoice_number, status, invoice_type, issue_date, due_date)
  values ('ee000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'c0000000-0000-0000-0000-00000000000a','INV00001','draft','consolidated',
          current_date, current_date + 14);
insert into public.invoice_source_jobs (tenant_id, invoice_id, order_id)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ee000000-0000-0000-0000-00000000000a',
          'd0000000-0000-0000-0000-00000000000a');
update public.laundry_orders set billing_status = 'invoice_generated'
 where id = 'd0000000-0000-0000-0000-00000000000a';

select lives_ok(
  $$update public.job_charge_snapshots set gl_account_id = null
     where id = 'cc000000-0000-0000-0000-00000000000a'$$,
  'a charge on a running draft may still be re-coded — which is the whole point');

select throws_ok(
  $$update public.job_charge_snapshots set unit_price = 12
     where id = 'cc000000-0000-0000-0000-00000000000a'$$,
  -- The *frozen* refusal, not the invoiced one: the charge was approved long
  -- before it reached a draft, so that check is the one that fires first. Which
  -- sentence a person is shown matters less than that the money did not move.
  'P0001', 'this job''s charges were approved and can no longer be changed',
  'while its money is refused on the same row, in the same breath');

update public.invoices set status = 'issued' where id = 'ee000000-0000-0000-0000-00000000000a';

select throws_ok(
  $$update public.job_charge_snapshots
       set gl_account_id = 'ac000000-0000-0000-0000-00000000000c'
     where id = 'cc000000-0000-0000-0000-00000000000a'$$,
  'P0001',
  'this job is on an invoice that has already been issued, so its coding can no longer be changed',
  'and once the customer has the invoice, the coding stops moving too');

select * from finish();
rollback;
