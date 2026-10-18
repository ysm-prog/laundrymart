-- Proof: 0054 and 0055 — the database halves of Darshan's BA review, Phase 1
-- (18 October 2026).
--
--   * A receipt dated more than fifteen minutes ahead is refused (brief 1.5),
--     and a row already carrying one is not re-judged by an unrelated edit.
--   * `billing_hold_reason` takes `needs_price` and nothing else (brief 1.3).
--   * `invoices.source` defaults to `app` and is `app` or `import` (brief 1.2).
--   * The Owner can save the `receivables` setting, still nothing unknown (1.9).
--   * The invoice logo bucket is private, readable by the laundry's members and
--     writable by its Owner alone (brief 1.10).
begin;
select plan(15);

insert into auth.users (id, email) values
  ('0f110000-0000-4000-8000-000000000001','owner@example.com'),
  ('0f110000-0000-4000-8000-000000000002','driver@example.com'),
  ('0f110000-0000-4000-8000-000000000003','other-owner@example.com');

insert into public.tenants (id, name) values
  ('0f000000-0000-4000-8000-0000000000aa','Laundry A'),
  ('0f000000-0000-4000-8000-0000000000bb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('0f110000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-0000000000aa','super_admin'),
  ('0f110000-0000-4000-8000-000000000002','0f000000-0000-4000-8000-0000000000aa','driver'),
  ('0f110000-0000-4000-8000-000000000003','0f000000-0000-4000-8000-0000000000bb','super_admin');
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('0fc00000-0000-4000-8000-0000000000aa','0f000000-0000-4000-8000-0000000000aa','CUST00001','Cafe A');

-- ------------------------------------------------------ 1.5 received_at ----
select throws_like(
  $$insert into public.laundry_orders (tenant_id, customer_id, order_number, received_at)
    values ('0f000000-0000-4000-8000-0000000000aa','0fc00000-0000-4000-8000-0000000000aa',
            'LJ09001', now() + interval '2 days')$$,
  '%cannot have been received in the future%',
  'a job received two days from now is refused — LJ00031');

select lives_ok(
  $$insert into public.laundry_orders (tenant_id, customer_id, order_number, received_at)
    values ('0f000000-0000-4000-8000-0000000000aa','0fc00000-0000-4000-8000-0000000000aa',
            'LJ09002', now() + interval '10 minutes')$$,
  'ten minutes ahead is clock drift, not a future date');

-- A future-dated row from before the guard: written with the trigger off, the
-- way such a row came to exist.
alter table public.laundry_orders disable trigger guard_laundry_orders_received_at;
insert into public.laundry_orders (tenant_id, customer_id, order_number, received_at)
values ('0f000000-0000-4000-8000-0000000000aa','0fc00000-0000-4000-8000-0000000000aa',
        'LJ09003', now() + interval '2 days');
alter table public.laundry_orders enable trigger guard_laundry_orders_received_at;

select lives_ok(
  $$update public.laundry_orders set special_instructions = 'ring the bell' where order_number = 'LJ09003'$$,
  'an existing future-dated job is not re-judged by an edit that leaves its date alone');

select throws_like(
  $$update public.laundry_orders set received_at = now() + interval '3 days' where order_number = 'LJ09003'$$,
  '%cannot have been received in the future%',
  'but moving it to another future day is refused');

select lives_ok(
  $$update public.laundry_orders set received_at = now() - interval '1 day' where order_number = 'LJ09003'$$,
  'and correcting it to a real day is allowed');

-- ------------------------------------------------- 1.3 billing_hold_reason --
select lives_ok(
  $$update public.laundry_orders set billing_hold_reason = 'needs_price' where order_number = 'LJ09002'$$,
  'a job can be marked as needing a price');
select throws_ok(
  $$update public.laundry_orders set billing_hold_reason = 'whatever' where order_number = 'LJ09002'$$,
  '23514', null,
  'and nothing else');

-- --------------------------------------------------------- 1.2 source ----
insert into public.invoices (tenant_id, customer_id, invoice_number, status, total)
values ('0f000000-0000-4000-8000-0000000000aa','0fc00000-0000-4000-8000-0000000000aa','INV09001','draft', 25.08);
select is((select source from public.invoices where invoice_number = 'INV09001'), 'app',
          'an invoice raised in the app is an app invoice by default');
select throws_ok(
  $$update public.invoices set source = 'other' where invoice_number = 'INV09001'$$,
  '23514', null,
  'source is app or import, nothing else');

-- ------------------------------------------------ 1.9 receivables setting --
set local role authenticated;
set local "request.jwt.claim.sub" = '0f110000-0000-4000-8000-000000000001';

select lives_ok(
  $$select public.save_tenant_settings('0f000000-0000-4000-8000-0000000000aa', 'receivables',
                                       '{"ar_trusted_from": "2026-10-01"}'::jsonb)$$,
  'the Owner can save when imported balances are trusted from');
select throws_ok(
  $$select public.save_tenant_settings('0f000000-0000-4000-8000-0000000000aa', 'name', '{"x": 1}'::jsonb)$$,
  '22023', null,
  'and still cannot write a key the screen does not own');

-- --------------------------------------------------------- 1.10 the logo ----
select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('tenant-branding','0f000000-0000-4000-8000-0000000000aa/invoice-logo-1.png')$$,
  'the Owner can upload their laundry''s logo');
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('tenant-branding','0f000000-0000-4000-8000-0000000000bb/invoice-logo-1.png')$$,
  '42501', null,
  'but not into another laundry''s folder');

set local "request.jwt.claim.sub" = '0f110000-0000-4000-8000-000000000002';
select is((select count(*)::int from storage.objects where bucket_id = 'tenant-branding'), 1,
          'a driver in the laundry can read its logo — the PDF they open embeds it');
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('tenant-branding','0f000000-0000-4000-8000-0000000000aa/invoice-logo-2.png')$$,
  '42501', null,
  'and cannot replace it');

select * from finish();
rollback;
