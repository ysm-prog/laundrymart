-- Proof: a text is stamped on the invoice by the people who can send one, and
-- nobody else can see or write the number it went to.
begin;
select plan(7);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','owner@example.com'),
  ('22222222-2222-2222-2222-222222222222','driver@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver');
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Harbourview Hotel');
insert into public.invoices (id, tenant_id, customer_id, invoice_number, invoice_type, status, issue_date) values
  ('e0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c0000000-0000-0000-0000-00000000000a','INV00001','consolidated','issued','2026-11-02');

select has_column('public','invoices','sms_sent_at','the time a text went is recorded');
select has_column('public','invoices','sms_sent_to','the mobile it went to is recorded');
select col_is_null('public','invoices','sms_sent_at','an invoice never texted reads null');
select col_is_null('public','invoices','sms_sent_to','an invoice never texted reads null');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

update public.invoices set sms_sent_at = now(), sms_sent_to = '+61412345678'
 where id = 'e0000000-0000-0000-0000-00000000000a';
select is((select sms_sent_to from public.invoices where id = 'e0000000-0000-0000-0000-00000000000a'),
  '+61412345678', 'the owner can stamp a text on an issued invoice');

set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

select is((select count(*)::int from public.invoices), 0, 'a driver cannot read the invoice or its mobile');
update public.invoices set sms_sent_to = '+61400000000'
 where id = 'e0000000-0000-0000-0000-00000000000a';

reset role;
select is((select sms_sent_to from public.invoices where id = 'e0000000-0000-0000-0000-00000000000a'),
  '+61412345678', 'a driver cannot rewrite it');

select * from finish();
rollback;
