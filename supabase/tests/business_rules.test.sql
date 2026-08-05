-- Proof of the operational business rules the spec calls non-negotiable (§11):
-- inspection before start, load confirmation before start, unload before close,
-- inventory conservation, sequential numbering, protected items.
begin;
select plan(12);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','ops@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin');
insert into public.depots (id, tenant_id, code, name) values
  ('de000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','SYD','Sydney Depot');
insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CUST00001','Cafe A');
insert into public.items (id, tenant_id, sku, name) values
  ('11100000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','BT-01','Bath Towel');
insert into public.vehicles (id, tenant_id, registration) values
  ('fe000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ABC123');
insert into public.daily_routes (id, tenant_id, route_date, code, name, vehicle_id) values
  ('50000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-03-02','R1','North','fe000000-0000-0000-0000-00000000000a');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

-- ---- run workflow gates --------------------------------------------------
select throws_ok(
  $$ update public.daily_routes set status = 'in_progress'
      where id = '50000000-0000-0000-0000-000000000001' $$,
  'P0001', 'vehicle inspection is required before starting the run',
  'a run cannot start without a vehicle inspection');

insert into public.vehicle_inspections (id, tenant_id, vehicle_id, route_id, result)
values ('a1000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'fe000000-0000-0000-0000-00000000000a','50000000-0000-0000-0000-000000000001','pass');
update public.daily_routes set inspection_id = 'a1000000-0000-0000-0000-000000000001'
 where id = '50000000-0000-0000-0000-000000000001';

select throws_ok(
  $$ update public.daily_routes set status = 'in_progress'
      where id = '50000000-0000-0000-0000-000000000001' $$,
  'P0001', 'load must be confirmed before starting the route',
  'a run cannot start before the load is confirmed');

update public.daily_routes set load_confirmed_at = now()
 where id = '50000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ update public.daily_routes set status = 'in_progress'
      where id = '50000000-0000-0000-0000-000000000001' $$,
  'a run starts once inspection and load confirmation exist');

select isnt((select started_at from public.daily_routes
              where id = '50000000-0000-0000-0000-000000000001'), null,
            'starting the run stamps started_at');

select throws_ok(
  $$ update public.daily_routes set status = 'closed'
      where id = '50000000-0000-0000-0000-000000000001' $$,
  'P0001', 'the run must be unloaded before it can be closed',
  'a run cannot close before it is unloaded');

-- ---- inventory conservation ---------------------------------------------
select isnt(public.move_inventory(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11100000-0000-0000-0000-00000000000a',
  'laundry_owned', 100, null, 'at_customer', 'purchase',
  null, null, null,
  'c0000000-0000-0000-0000-00000000000a', null, null), null,
  'stock can enter the system at a customer');

select is((select public.move_inventory(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11100000-0000-0000-0000-00000000000a',
  'laundry_owned', 20, 'at_customer', 'in_transit', 'pickup',
  'c0000000-0000-0000-0000-00000000000a', null, null,
  null, null, 'fe000000-0000-0000-0000-00000000000a') is not null), true,
  'a pickup moves stock from the customer onto the vehicle');

select results_eq(
  $$ select state, quantity from public.inventory_pools
      where item_id = '11100000-0000-0000-0000-00000000000a' order by state $$,
  $$ values ('at_customer', 80), ('in_transit', 20) $$,
  'pickup reduces customer stock and increases in-transit stock');

-- ---- sequential numbering ------------------------------------------------
select is(public.next_number('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','invoice','INV'),
          'INV00001', 'the first invoice number is INV00001');
select is(public.next_number('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','invoice','INV'),
          'INV00002', 'invoice numbers increment without gaps');

-- next_number runs with definer rights, so its tenant argument is the whole
-- boundary. Without this check anyone reaching PostgREST could burn another
-- tenant's sequence and leave permanent gaps in their invoice numbering.
select throws_ok(
  $$select public.next_number('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','invoice','INV')$$,
  '42501',
  'not a member of that tenant',
  'a member of one tenant cannot draw numbers for another');

-- ---- items referenced by an active agreement are protected (§7.5) --------
insert into public.service_agreements (id, tenant_id, customer_id, agreement_number, status, start_date)
values ('a5000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'c0000000-0000-0000-0000-00000000000a','SA00001','active','2026-01-01');
insert into public.service_agreement_lines (tenant_id, agreement_id, item_id, unit_price)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','a5000000-0000-0000-0000-000000000001',
        '11100000-0000-0000-0000-00000000000a', 1.20);

select throws_ok(
  $$ update public.items set deleted_at = now()
      where id = '11100000-0000-0000-0000-00000000000a' $$,
  '23503', null, 'an item on an active agreement cannot be soft-deleted');

select * from finish();
rollback;
