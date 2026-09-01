-- Proof: GST is inside the price, and the client's own invoice comes out right.
--
-- The client supplied a MYOB invoice whose totals block reads:
--
--     Subtotal   $72.70
--     Tax         $6.61
--     Total      $72.70
--
-- The total *equals* the subtotal, because the tax is already inside it —
-- `72.70 / 11 = 6.609…`, rounding to the 6.61 printed. Until 0043 this app added
-- 10% on top and the same three lines came to $79.97.
--
-- That arithmetic lives in `recalculate_invoice()`, which is where an invoice's
-- money is actually decided, so it is asserted by *running the function against
-- real rows* rather than by reading the SQL. `lib/domain/gst.ts` carries the same
-- rule for the screens and is tested against the same invoice.
--
-- Also proved here: the tax code drives `taxable` rather than sitting beside it,
-- freight carries its own tax answer, and neither the discount nor the code will
-- accept a value the app has no meaning for.
begin;
select plan(28);

insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111','owner@example.com');
insert into public.tenants (id, name, gst_rate) values
  ('a0000000-0000-4000-8000-00000000000a','Laundry A', 0.10);
insert into public.memberships (user_id, tenant_id, role) values
  ('a1111111-1111-1111-1111-111111111111','a0000000-0000-4000-8000-00000000000a','super_admin');
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-00000000000a',
   'CUST00001','A Real Customer');
insert into public.invoices (id, tenant_id, customer_id, invoice_number, issue_date, status) values
  ('40000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-00000000000a',
   'c0000000-0000-4000-8000-00000000000a','INV00001', current_date, 'draft');

-- ---------------------------------------------- the client's three lines ----
-- Quantities, prices and amounts exactly as printed on their invoice.
insert into public.invoice_lines
  (tenant_id, invoice_id, description, quantity, unit_price, amount, tax_code, sequence) values
  ('a0000000-0000-4000-8000-00000000000a','40000000-0000-4000-8000-00000000000a',
   'Towels - Black', 100, 0.39, 39.00, 'GST', 1),
  ('a0000000-0000-4000-8000-00000000000a','40000000-0000-4000-8000-00000000000a',
   'White Towels - Client''s Own Towels', 1, 31.50, 31.50, 'GST', 2),
  ('a0000000-0000-4000-8000-00000000000a','40000000-0000-4000-8000-00000000000a',
   'Temporary Fuel Surcharge', 1, 2.20, 2.20, 'GST', 3);

select public.recalculate_invoice('40000000-0000-4000-8000-00000000000a');

select is((select subtotal from public.invoices where id='40000000-0000-4000-8000-00000000000a'),
          72.70::numeric, 'the subtotal is the $72.70 on the client''s invoice');
select is((select tax_amount from public.invoices where id='40000000-0000-4000-8000-00000000000a'),
          6.61::numeric, 'the tax is the $6.61 already inside it');
select is((select total from public.invoices where id='40000000-0000-4000-8000-00000000000a'),
          72.70::numeric, 'the total equals the subtotal: nothing is added');
select isnt((select total from public.invoices where id='40000000-0000-4000-8000-00000000000a'),
            79.97::numeric, 'and is not the $79.97 the old exclusive model produced');

-- ------------------------------------------ the code drives, not the tick ----
select is((select taxable from public.invoice_lines
            where invoice_id='40000000-0000-4000-8000-00000000000a' and sequence=1),
          true, 'a GST line is taxable without anybody setting the flag');

update public.invoice_lines set tax_code = 'FRE'
 where invoice_id='40000000-0000-4000-8000-00000000000a' and sequence=1;
select is((select taxable from public.invoice_lines
            where invoice_id='40000000-0000-4000-8000-00000000000a' and sequence=1),
          false, 'moving the code to FRE turns the flag off by itself');

select public.recalculate_invoice('40000000-0000-4000-8000-00000000000a');
select is((select subtotal from public.invoices where id='40000000-0000-4000-8000-00000000000a'),
          72.70::numeric, 'a GST-free line still counts toward the subtotal');
select is((select tax_amount from public.invoices where id='40000000-0000-4000-8000-00000000000a'),
          3.06::numeric, 'but contributes no tax — 33.70 of 72.70 is taxed');

update public.invoice_lines set tax_code = 'GST'
 where invoice_id='40000000-0000-4000-8000-00000000000a' and sequence=1;

-- ------------------------------------------------------------- freight ------
update public.invoices set freight_amount = 11.00, freight_tax_code = 'GST'
 where id='40000000-0000-4000-8000-00000000000a';
select public.recalculate_invoice('40000000-0000-4000-8000-00000000000a');
select is((select subtotal from public.invoices where id='40000000-0000-4000-8000-00000000000a'),
          83.70::numeric, 'freight adds to the subtotal');
select is((select tax_amount from public.invoices where id='40000000-0000-4000-8000-00000000000a'),
          7.61::numeric, 'and carries its own GST inside it');

update public.invoices set freight_tax_code = 'N-T'
 where id='40000000-0000-4000-8000-00000000000a';
select public.recalculate_invoice('40000000-0000-4000-8000-00000000000a');
select is((select tax_amount from public.invoices where id='40000000-0000-4000-8000-00000000000a'),
          6.61::numeric, 'untaxed freight contributes none, while the lines still do');

update public.invoices set freight_amount = 0, freight_tax_code = null
 where id='40000000-0000-4000-8000-00000000000a';

-- ------------------------------------------------ what will not be stored ----
select throws_ok($$
  update public.invoice_lines set discount_percent = 150
   where invoice_id='40000000-0000-4000-8000-00000000000a' and sequence=1 $$,
  '23514', null, 'a discount over 100% is refused by the database');
select throws_ok($$
  update public.invoice_lines set discount_percent = -5
   where invoice_id='40000000-0000-4000-8000-00000000000a' and sequence=1 $$,
  '23514', null, 'and so is a negative one');
select throws_ok($$
  update public.invoice_lines set tax_code = 'WET'
   where invoice_id='40000000-0000-4000-8000-00000000000a' and sequence=1 $$,
  '23514', null, 'a tax code this app has no meaning for is refused');
select lives_ok($$
  update public.invoice_lines set discount_percent = 0
   where invoice_id='40000000-0000-4000-8000-00000000000a' and sequence=1 $$,
  'zero discount is the ordinary case and is accepted');

-- --------------------------------------------------------- the trap 0019 ----
-- A trigger function left executable by `authenticated` is published on
-- /rest/v1/rpc, where it can only ever error. 0036 shipped exactly that.
select is(has_function_privilege('authenticated','public.sync_tax_code_taxable()','execute'),
          false, 'the tax-code trigger function is not on the RPC surface');

select is((select count(*)::int from pg_trigger
            where tgname in ('sync_invoice_line_tax_code','sync_job_charge_tax_code')
              and not tgisinternal),
          2, 'both tables keep their code and their flag in step');

-- ==================================================== credit notes, 0046 ====
-- A credit note offsets an invoice line, so it has to be read on the same basis
-- as one. Until 0046 it was not: `createCreditNote` computed `tax = amount *
-- gst_rate` in application code — GST added on top — while this file's own
-- invoice assertions above prove the invoice extracts it from within. Offsetting
-- the $72.70 line above needed $66.09 typed, and crediting the full $72.70
-- produced a $79.97 credit note.
--
-- `recalculate_credit_note()` is the twin of `recalculate_invoice()`, so the
-- model now lives in one place for both documents. Asserted by running it
-- against real rows, exactly as the invoice half is.
insert into public.credit_notes
  (id, tenant_id, customer_id, invoice_id, credit_note_number, status,
   subtotal, tax_amount, total)
values
  ('50000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-00000000000a',
   'c0000000-0000-4000-8000-00000000000a','40000000-0000-4000-8000-00000000000a',
   'CN00001','issued', 0, 0, 0);

-- The same figure as the invoice: what the customer is credited, GST inside it.
insert into public.credit_note_lines
  (tenant_id, credit_note_id, description, quantity, unit_price, amount, taxable) values
  ('a0000000-0000-4000-8000-00000000000a','50000000-0000-4000-8000-00000000000a',
   'Short delivery on 12 March', 1, 72.70, 72.70, true);

select public.recalculate_credit_note('50000000-0000-4000-8000-00000000000a');

select is((select subtotal from public.credit_notes where id='50000000-0000-4000-8000-00000000000a'),
          72.70::numeric, 'a credit note''s subtotal is the amount credited');
select is((select tax_amount from public.credit_notes where id='50000000-0000-4000-8000-00000000000a'),
          6.61::numeric, 'and its GST is the $6.61 already inside that amount');
select is((select total from public.credit_notes where id='50000000-0000-4000-8000-00000000000a'),
          72.70::numeric, 'and the total equals the subtotal, as on the invoice');
select isnt((select total from public.credit_notes where id='50000000-0000-4000-8000-00000000000a'),
            79.97::numeric, 'not the $79.97 the old exclusive credit note produced');

-- The property the whole change is for: offsetting an invoice takes the figure
-- printed on it, and the two documents report the same GST for the same money.
select public.recalculate_invoice('40000000-0000-4000-8000-00000000000a');
select is((select c.tax_amount from public.credit_notes c
            where c.id='50000000-0000-4000-8000-00000000000a'),
          (select i.tax_amount from public.invoices i
            where i.id='40000000-0000-4000-8000-00000000000a'),
          'an invoice and a credit note for the same amount agree on the GST');

-- A GST-free credit carries none, and the customer is still credited in full.
update public.credit_note_lines set taxable = false
 where credit_note_id='50000000-0000-4000-8000-00000000000a';
select public.recalculate_credit_note('50000000-0000-4000-8000-00000000000a');
select is((select tax_amount from public.credit_notes where id='50000000-0000-4000-8000-00000000000a'),
          0::numeric, 'a GST-free credit contributes no tax');
select is((select total from public.credit_notes where id='50000000-0000-4000-8000-00000000000a'),
          72.70::numeric, 'and is still credited in full');

-- The header follows the lines rather than a figure the caller passed, which is
-- what moving this into the database bought.
update public.credit_note_lines set taxable = true
 where credit_note_id='50000000-0000-4000-8000-00000000000a';
insert into public.credit_note_lines
  (tenant_id, credit_note_id, description, quantity, unit_price, amount, taxable) values
  ('a0000000-0000-4000-8000-00000000000a','50000000-0000-4000-8000-00000000000a',
   'Second correction', 1, 27.30, 27.30, true);
select public.recalculate_credit_note('50000000-0000-4000-8000-00000000000a');
select is((select subtotal from public.credit_notes where id='50000000-0000-4000-8000-00000000000a'),
          100.00::numeric, 'two credit lines are summed by the database, not by a caller');
select is((select tax_amount from public.credit_notes where id='50000000-0000-4000-8000-00000000000a'),
          9.09::numeric, 'and the GST is found inside the summed total');

-- Callable by a signed-in user because the action reaches it over /rest/v1/rpc,
-- and by nobody else. SECURITY INVOKER, so RLS and 0025 still decide who may
-- move a credit note's totals.
select is(has_function_privilege('anon','public.recalculate_credit_note(uuid)','execute'),
          false, 'anon cannot total a credit note');
select is((select not prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname='recalculate_credit_note'),
          true, 'and it runs as its caller, not as its owner');

select * from finish();
rollback;
