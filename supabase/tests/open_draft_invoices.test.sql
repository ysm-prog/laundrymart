-- Proof: one running draft per customer per period, and a closed invoice is closed.
--
-- Two rules, and both of them have to be facts about the database rather than
-- about the screen — because `invoices` and `invoice_lines` are both published
-- on `/rest/v1/…`, and because the whole point of the running draft is that
-- several approvals race each other onto the same document.
--
--  1. **At most one open draft per (tenant, customer, period).** A reader that
--     merely looks first is a race, not a rule: two reviewers approving two jobs
--     for one customer in the same second both find nothing and both insert. The
--     partial unique index is what makes the second one lose, and losing is what
--     lets the caller re-read and join the winner. Every term in its WHERE clause
--     is asserted here, because a term too many silently stops enforcing and a
--     term too few blocks a per-job invoice that should have been allowed.
--
--  2. **A line cannot change on an invoice that is no longer a draft.** Before
--     0040 this was checked nowhere: `addInvoiceLine` and `removeInvoiceLine`
--     check the caller's capability and never the invoice's status, and the
--     write policy on `invoice_lines` is a role gate. A line could be added to an
--     issued, sent, paid or **voided** invoice from a browser's network tab, and
--     the customer's copy and ours would disagree with nothing raising.
--
-- Asserted by *doing it*, never by reading policy text — and the refusals are
-- checked for their SQLSTATE, because the failure this class produces is a
-- statement that succeeds and touches nothing.
begin;
select plan(21);

insert into auth.users (id, email) values
  ('d1111111-1111-1111-1111-111111111111','owner@example.com');

insert into public.tenants (id, name) values
  ('daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Draft Laundry');

insert into public.memberships (user_id, tenant_id, role) values
  ('d1111111-1111-1111-1111-111111111111','daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin');

insert into public.customers (id, tenant_id, customer_number, business_name, billing_method) values
  ('dc000000-0000-0000-0000-00000000000a','daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'CUST00001','Acme Hotels','monthly_consolidated'),
  ('dc000000-0000-0000-0000-00000000000b','daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'CUST00002','Beta Cafe','monthly_consolidated');

-- ============================================================ the schema ==
select has_column('public', 'invoice_lines', 'origin',
  'a line records where it came from');

select is(
  (select column_default from information_schema.columns
    where table_schema='public' and table_name='invoice_lines' and column_name='origin'),
  '''manual''::text',
  'an unmarked line defaults to manual — the origin nothing may delete');

select ok(
  exists (select 1 from pg_constraint
           where conrelid='public.invoice_lines'::regclass
             and conname='invoice_lines_origin_check'),
  'origin is constrained to the three writers');

select ok(
  (select indisunique from pg_index
    where indexrelid = 'public.uq_invoices_open_draft'::regclass),
  'the open-draft key is a unique index, not merely an index');

select ok(
  exists (select 1 from pg_trigger
           where tgrelid='public.invoice_lines'::regclass
             and tgname='guard_invoice_lines_draft_only'),
  'the draft-only guard is attached to invoice_lines');

-- The trap 0019 recorded and 0036 repeated: a SECURITY DEFINER trigger function
-- published at /rest/v1/rpc for every signed-in user, where it can only error.
select ok(
  not has_function_privilege('authenticated', 'public.guard_invoice_line_draft_only()', 'execute'),
  'the trigger function is not on the RPC surface for authenticated');
select ok(
  not has_function_privilege('anon', 'public.guard_invoice_line_draft_only()', 'execute'),
  'the trigger function is not on the RPC surface for anon');

-- ==================================================== one draft per period ==
insert into public.invoices
  (id, tenant_id, customer_id, invoice_number, invoice_type, status, period_start, period_end)
values
  ('d0000000-0000-0000-0000-00000000000a','daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'dc000000-0000-0000-0000-00000000000a','INV00001','consolidated','draft',
   '2026-08-01','2026-08-31');

select throws_ok(
  $$ insert into public.invoices
       (tenant_id, customer_id, invoice_number, invoice_type, status, period_start, period_end)
     values ('daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dc000000-0000-0000-0000-00000000000a',
             'INV00002','consolidated','draft','2026-08-01','2026-08-31') $$,
  '23505', null,
  'a second open draft for the same customer and period is refused');

-- Every one of the four terms in the index's WHERE clause has to earn its place,
-- so each is proved to *permit* the case it exists to permit.
select lives_ok(
  $$ insert into public.invoices
       (tenant_id, customer_id, invoice_number, invoice_type, status, period_start, period_end)
     values ('daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dc000000-0000-0000-0000-00000000000a',
             'INV00003','consolidated','draft','2026-09-01','2026-09-30') $$,
  'the next period opens its own draft');

select lives_ok(
  $$ insert into public.invoices
       (tenant_id, customer_id, invoice_number, invoice_type, status, period_start, period_end)
     values ('daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dc000000-0000-0000-0000-00000000000b',
             'INV00004','consolidated','draft','2026-08-01','2026-08-31') $$,
  'another customer''s August draft is a different draft');

select lives_ok(
  $$ insert into public.invoices
       (tenant_id, customer_id, invoice_number, invoice_type, status, period_start, period_end)
     values ('daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dc000000-0000-0000-0000-00000000000a',
             'INV00005','per_job','draft','2026-08-01','2026-08-31') $$,
  'a per-job invoice never collides with the running draft');

-- **Issuing closes the draft**, which is what lets the owner bill whenever they
-- like: the next approval for the same period opens a fresh one rather than
-- being refused by an invoice the customer has already been sent.
update public.invoices set status = 'issued'
 where id = 'd0000000-0000-0000-0000-00000000000a';

select lives_ok(
  $$ insert into public.invoices
       (id, tenant_id, customer_id, invoice_number, invoice_type, status, period_start, period_end)
     values ('d0000000-0000-0000-0000-00000000000b','daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'dc000000-0000-0000-0000-00000000000a','INV00006','consolidated','draft',
             '2026-08-01','2026-08-31') $$,
  'issuing closes the draft, so the same period can open another');

select is(
  (select count(*)::int from public.invoices
    where customer_id = 'dc000000-0000-0000-0000-00000000000a'
      and period_start = '2026-08-01' and status = 'draft'
      and invoice_type = 'consolidated'),
  1,
  'and there is still exactly one open one');

-- ============================================ a closed invoice is closed ==
select lives_ok(
  $$ insert into public.invoice_lines
       (id, tenant_id, invoice_id, description, quantity, unit_price, amount, origin)
     values ('d1000000-0000-0000-0000-00000000000a','daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'd0000000-0000-0000-0000-00000000000b','Bath towel',100,0.22,22.00,'job') $$,
  'a line goes onto a draft');

select throws_ok(
  $$ insert into public.invoice_lines
       (tenant_id, invoice_id, description, quantity, unit_price, amount)
     values ('daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-00000000000a',
             'Slipped in later',1,99.00,99.00) $$,
  '42501', null,
  'a line cannot be added to an issued invoice');

-- The lines already on the now-issued invoice are equally fixed. Written while
-- it was a draft, then frozen with it.
insert into public.invoice_lines
  (id, tenant_id, invoice_id, description, quantity, unit_price, amount, origin)
values ('d1000000-0000-0000-0000-00000000000b','daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'd0000000-0000-0000-0000-00000000000b','Fuel levy',1,4.00,4.00,'job');

update public.invoices set status = 'issued'
 where id = 'd0000000-0000-0000-0000-00000000000b';

select throws_ok(
  $$ update public.invoice_lines set amount = 1.00
      where id = 'd1000000-0000-0000-0000-00000000000b' $$,
  '42501', null,
  'a line on an issued invoice cannot be edited');

select throws_ok(
  $$ delete from public.invoice_lines
      where id = 'd1000000-0000-0000-0000-00000000000b' $$,
  '42501', null,
  'a line on an issued invoice cannot be deleted');

-- A void is a record of what was said, so it is frozen too. This is the case a
-- status check written as `status <> 'issued'` would have missed.
update public.invoices set status = 'void'
 where id = 'd0000000-0000-0000-0000-00000000000b';

select throws_ok(
  $$ delete from public.invoice_lines
      where id = 'd1000000-0000-0000-0000-00000000000b' $$,
  '42501', null,
  'a void invoice''s lines are frozen too');

select is(
  (select count(*)::int from public.invoice_lines
    where invoice_id = 'd0000000-0000-0000-0000-00000000000b'),
  2,
  'and nothing was quietly removed by any of those refusals');

-- **The cascade still works.** The guard has to let a child delete through when
-- its parent is already gone, or an invoice becomes undeletable — the generator
-- unwinds its own failed insert this way.
select lives_ok(
  $$ delete from public.invoices where id = 'd0000000-0000-0000-0000-00000000000b' $$,
  'deleting an invoice still cascades to its lines');

select is(
  (select count(*)::int from public.invoice_lines
    where invoice_id = 'd0000000-0000-0000-0000-00000000000b'),
  0,
  'and the lines went with it');

select * from finish();
rollback;
