-- Proof: the warehouse guards from §7.16 live in the database.
--
-- The manifest is what every stock movement was calculated from, so the rules
-- that keep it honest cannot be a client-side convention — a batch edited from
-- a second tab, a retried request or a psql session has to hit the same wall.
begin;
select plan(8);

insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A');
insert into public.items (id, tenant_id, sku, name) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','TOW-01','Bath Towel');
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Cafe A');

insert into public.production_batches (id, tenant_id, batch_number) values
  ('b0000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','BATCH00001');

-- An empty batch reaching the washers is a batch someone will look for and
-- never find.
select throws_ok(
  $$update public.production_batches set stage = 'washing'
     where id = 'b0000000-0000-0000-0000-000000000001'$$,
  'P0001',
  'add at least one line before starting the batch',
  'a batch cannot start washing with an empty manifest');

-- Customer-owned linen with no customer is unreturnable.
select throws_ok(
  $$insert into public.production_batch_lines
      (tenant_id, batch_id, item_id, owner_type, quantity)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','b0000000-0000-0000-0000-000000000001',
            '11111111-1111-1111-1111-111111111111','customer_owned',10)$$,
  '23514',
  null,
  'customer-owned linen cannot be booked in without a customer');

insert into public.production_batch_lines
  (id, tenant_id, batch_id, item_id, quantity)
values ('11110000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'b0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',40);

update public.production_batches set stage = 'washing'
 where id = 'b0000000-0000-0000-0000-000000000001';

select isnt((select started_at from public.production_batches
              where id = 'b0000000-0000-0000-0000-000000000001'), null,
            'starting the batch stamps started_at');

-- Frozen manifest: the quantity drove a movement, so it cannot move now.
select throws_ok(
  $$update public.production_batch_lines set quantity = 80
     where id = '11110000-0000-0000-0000-000000000001'$$,
  'P0001',
  'a batch manifest can only be changed while the batch is in receiving',
  'a line quantity cannot be edited once the batch has left receiving');

select throws_ok(
  $$delete from public.production_batch_lines
     where id = '11110000-0000-0000-0000-000000000001'$$,
  'P0001',
  'a batch manifest can only be changed while the batch is in receiving',
  'a line cannot be removed once the batch has left receiving');

-- Rejects are the deliberate exception: damage is found during processing.
update public.production_batch_lines set rejected_quantity = 3
 where id = '11110000-0000-0000-0000-000000000001';
select is((select rejected_quantity from public.production_batch_lines
            where id = '11110000-0000-0000-0000-000000000001'), 3,
          'rejects can still be recorded mid-process');

-- Completion is only meaningful from the end of the line.
select throws_ok(
  $$update public.production_batches set stage = 'completed'
     where id = 'b0000000-0000-0000-0000-000000000001'$$,
  'P0001',
  'a batch can only be completed from ready_for_dispatch',
  'a batch cannot skip from washing straight to completed');

update public.production_batches set stage = 'ready_for_dispatch'
 where id = 'b0000000-0000-0000-0000-000000000001';
update public.production_batches set stage = 'completed'
 where id = 'b0000000-0000-0000-0000-000000000001';

select throws_ok(
  $$update public.production_batches set stage = 'washing'
     where id = 'b0000000-0000-0000-0000-000000000001'$$,
  'P0001',
  'a completed batch cannot be reopened',
  'a finished batch cannot be dragged back onto the floor');

select * from finish();
rollback;
