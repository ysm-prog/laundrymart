-- ============================================================================
-- Demo seed — one laundry with a depot, customers, items, fleet, an agreement
-- and opening stock. Enough to click through every screen.
--
-- NOT applied by migrations or CI. Run it against a scratch database only:
--   psql -f supabase/seed.sql
--
-- Users: on a real Supabase project, create the logins through Auth first, then
-- update the memberships/drivers rows below with their real user ids.
-- ============================================================================
begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001','ops@demo.laundry'),
  ('00000000-0000-4000-8000-000000000002','driver@demo.laundry')
on conflict (id) do nothing;

insert into public.tenants (id, name, abn, timezone) values
  ('10000000-0000-4000-8000-000000000001','Harbour Commercial Laundry','51824753556','Australia/Sydney');

insert into public.memberships (user_id, tenant_id, role) values
  ('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','super_admin'),
  ('00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','driver');

-- ------------------------------------------------------------------ depot ---
insert into public.depots (id, tenant_id, code, name, suburb, state, postcode, contact_name, contact_phone)
values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
        'SYD','Sydney Depot','Alexandria','NSW','2015','Dana Whitfield','02 9000 0000');

-- -------------------------------------------------------------- customers ---
insert into public.customers
  (id, tenant_id, depot_id, customer_number, business_name, abn, billing_suburb, billing_state,
   billing_postcode, billing_email, phone, payment_terms_days, special_instructions, status)
values
  ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
   'CUST00001','Quay Street Bistro','51824753556','Haymarket','NSW','2000','accounts@quaybistro.example',
   '02 9000 1111', 14, 'Deliveries via the rear laneway before 9am.', 'active'),
  ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
   'CUST00002','Northshore Day Spa',null,'Crows Nest','NSW','2065','ap@northshorespa.example',
   '02 9000 2222', 30, 'Ring the bell at the treatment room entrance.', 'active');

insert into public.customer_locations (id, tenant_id, customer_id, name, address_line1, suburb, state, postcode, is_primary)
values
  ('31000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
   'Main kitchen','14 Quay Street','Haymarket','NSW','2000', true),
  ('31000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',
   'Treatment rooms','88 Willoughby Road','Crows Nest','NSW','2065', true);

insert into public.customer_contacts (tenant_id, customer_id, name, role, email, phone, is_primary)
values
  ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','Marco Bellini','Venue manager','marco@quaybistro.example','0400 000 111', true),
  ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','Priya Raman','Operations lead','priya@northshorespa.example','0400 000 222', true);

-- ------------------------------------------------------------------ items ---
insert into public.items
  (id, tenant_id, sku, name, category, replacement_cost, rental_price, wash_only_price, weight_kg, reorder_level)
values
  ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','BT-WHT-01','Bath Towel — White','bath_towel', 14.50, 0.95, 0.55, 0.500, 200),
  ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','HT-WHT-01','Hand Towel — White','hand_towel',  6.20, 0.55, 0.30, 0.180, 200),
  ('40000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','TT-CHK-01','Tea Towel — Check','tea_towel',    4.10, 0.40, 0.22, 0.090, 150),
  ('40000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','AP-BLK-01','Apron — Black','apron',            18.00, 1.20, 0.70, 0.320, 60),
  ('40000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','TC-WHT-01','Table Cloth — White','table_cloth',32.00, 2.40, 1.30, 1.100, 80),
  ('40000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','LB-STD-01','Laundry Bag — Standard','laundry_bag', 9.00, 0.00, 0.00, 0.400, 40);

-- ------------------------------------------------------------------ fleet ---
insert into public.vehicles (id, tenant_id, depot_id, registration, make, model, year, vehicle_type, capacity_kg, fuel_type)
values ('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
        'CJ72QM','Ford','Transit 350L',2023,'van',1400,'diesel');

insert into public.drivers (id, tenant_id, depot_id, user_id, employee_number, full_name, phone, licence_number, licence_expiry)
values ('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002','EMP-014','Sam Okoye','0400 000 333','NSW-4471182','2029-06-30');

-- ------------------------------------------------------- public holidays ----
insert into public.public_holidays (tenant_id, holiday_date, name, region) values
  ('10000000-0000-4000-8000-000000000001','2026-01-01','New Year''s Day','NSW'),
  ('10000000-0000-4000-8000-000000000001','2026-01-26','Australia Day','NSW'),
  ('10000000-0000-4000-8000-000000000001','2026-04-03','Good Friday','NSW'),
  ('10000000-0000-4000-8000-000000000001','2026-04-06','Easter Monday','NSW'),
  ('10000000-0000-4000-8000-000000000001','2026-04-25','Anzac Day','NSW'),
  ('10000000-0000-4000-8000-000000000001','2026-06-08','King''s Birthday','NSW'),
  ('10000000-0000-4000-8000-000000000001','2026-10-05','Labour Day','NSW'),
  ('10000000-0000-4000-8000-000000000001','2026-12-25','Christmas Day','NSW'),
  ('10000000-0000-4000-8000-000000000001','2026-12-26','Boxing Day','NSW');

-- ------------------------------------------------------ service agreement ---
-- Mon/Wed/Fri pickups, Tue/Thu/Sat deliveries, holidays move to the next
-- business day, $220 minimum per month plus a 3% fuel levy.
insert into public.service_agreements
  (id, tenant_id, customer_id, location_id, depot_id, agreement_number, status, start_date,
   pickup_pattern, delivery_pattern, minimum_charge, holiday_rule, holiday_region,
   fuel_levy_pct, weekend_surcharge_pct, billing_frequency, payment_terms_days)
values
  ('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001','SA00001','active','2026-01-05',
   '{"type":"weekly","weekdays":[1,3,5]}'::jsonb,
   '{"type":"weekly","weekdays":[2,4,6]}'::jsonb,
   220.00,'next_business_day','NSW', 3.0, 15.0, 'monthly', 14),
  -- Alternate Mondays, skipped entirely when they land on a public holiday.
  ('70000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-000000000001','SA00002','active','2026-01-05',
   '{"type":"alternate_weekly","weekdays":[1],"anchorDate":"2026-01-05"}'::jsonb,
   '{"type":"alternate_weekly","weekdays":[4],"anchorDate":"2026-01-08"}'::jsonb,
   140.00,'skip','NSW', 3.0, 0.0, 'monthly', 30);

insert into public.service_agreement_lines
  (tenant_id, agreement_id, item_id, charge_type, pricing_model, unit_price, standard_quantity)
values
  ('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','rental','per_item', 0.38, 60),
  ('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000004','rental','per_item', 1.15, 12),
  ('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000005','rental','per_item', 2.30, 20),
  ('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001','rental','per_item', 0.90, 120),
  ('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','rental','per_item', 0.52, 150);

-- -------------------------------------------------------- route template ----
insert into public.route_templates
  (id, tenant_id, depot_id, code, name, description, weekdays, default_driver_id, default_vehicle_id, planned_start_time)
values ('80000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
        'CITY-AM','City morning','Inner-city cafés and spas, finished by midday.',
        '{1,2,3,4,5}','60000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','06:30');

insert into public.route_template_stops (tenant_id, template_id, customer_id, location_id, sequence, service_type, planned_arrival)
values
  ('10000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',1,'both','07:00'),
  ('10000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000002',2,'both','08:15');

-- ---------------------------------------------------------- opening stock ---
-- Straight inserts rather than move_inventory() so the seed does not depend on
-- an authenticated session.
insert into public.inventory_pools (tenant_id, item_id, owner_type, state, depot_id, quantity)
select '10000000-0000-4000-8000-000000000001', id, 'laundry_owned', 'at_depot',
       '20000000-0000-4000-8000-000000000001', 400
from public.items where tenant_id = '10000000-0000-4000-8000-000000000001';

insert into public.inventory_pools (tenant_id, item_id, owner_type, state, customer_id, quantity)
values
  ('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','laundry_owned','at_customer','30000000-0000-4000-8000-000000000001', 60),
  ('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000004','laundry_owned','at_customer','30000000-0000-4000-8000-000000000001', 12),
  ('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','laundry_owned','at_customer','30000000-0000-4000-8000-000000000002', 120),
  ('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','laundry_owned','at_customer','30000000-0000-4000-8000-000000000002', 150);

-- ------------------------------------------------------ warehouse batch -----
-- One batch sitting in receiving, so the plant screens have something to open.
-- Its stock is already counted in at_depot above; a batch groups linen, it does
-- not create any.
insert into public.production_batches
  (id, tenant_id, depot_id, batch_number, stage, machine, notes)
values ('b0000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001','BATCH00001','received','Washer 3',
        'Off the City morning run, heavy soiling on the aprons.');

insert into public.production_batch_lines (tenant_id, batch_id, item_id, quantity)
values
  ('10000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',120),
  ('10000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002',150);

-- Keep generated numbers ahead of what the seed already used.
insert into public.number_sequences (tenant_id, kind, prefix, next_value) values
  ('10000000-0000-4000-8000-000000000001','customer','CUST',3),
  ('10000000-0000-4000-8000-000000000001','agreement','SA',3),
  ('10000000-0000-4000-8000-000000000001','job','JOB',1),
  ('10000000-0000-4000-8000-000000000001','invoice','INV',1),
  ('10000000-0000-4000-8000-000000000001','credit_note','CN',1),
  ('10000000-0000-4000-8000-000000000001','batch','BATCH',2)
on conflict (tenant_id, kind) do nothing;

commit;
