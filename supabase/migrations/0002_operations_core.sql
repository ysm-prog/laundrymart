-- ============================================================================
-- 0002_operations_core — depots, customers, items, vehicles, drivers.
-- Spec §7.2–7.6. Every entity is depot-scoped so multi-depot works from day one.
-- ============================================================================

-- ----------------------------------------------------------------- depots ---
create table public.depots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  address_line1 text,
  address_line2 text,
  suburb text,
  state text,
  postcode text,
  country text not null default 'AU',
  contact_name text,
  contact_phone text,
  contact_email text,
  operating_hours jsonb not null default '{}'::jsonb,
  timezone text not null default 'Australia/Sydney',
  status text not null default 'active' check (status in ('active','inactive','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_depots_code on public.depots(tenant_id, lower(code)) where deleted_at is null;

alter table public.memberships
  add constraint memberships_depot_fk foreign key (depot_id)
  references public.depots(id) on delete set null;

-- -------------------------------------------------------------- customers ---
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,
  customer_number text not null,
  business_name text not null,
  trading_name text,
  abn text,
  billing_address_line1 text,
  billing_address_line2 text,
  billing_suburb text,
  billing_state text,
  billing_postcode text,
  billing_email text,
  phone text,
  payment_terms_days integer not null default 14 check (payment_terms_days >= 0),
  purchase_order_number text,
  special_instructions text,
  notes text,
  status text not null default 'active' check (status in ('prospect','active','on_hold','inactive','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_customers_number on public.customers(tenant_id, customer_number);
create index idx_customers_depot on public.customers(depot_id);
create index idx_customers_name on public.customers(tenant_id, lower(business_name));

-- Multiple pickup / delivery sites per customer (spec §7.3).
create table public.customer_locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  name text not null,
  address_line1 text,
  address_line2 text,
  suburb text,
  state text,
  postcode text,
  access_notes text,
  is_pickup boolean not null default true,
  is_delivery boolean not null default true,
  is_primary boolean not null default false,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create index idx_customer_locations_customer on public.customer_locations(customer_id);

create table public.customer_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  name text not null,
  role text,
  email text,
  phone text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create index idx_customer_contacts_customer on public.customer_contacts(customer_id);

-- ------------------------------------------------------------------ items ---
-- Products / linen types (spec §7.5).
create table public.items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sku text not null,
  name text not null,
  category text not null default 'other' check (category in (
    'bath_towel','hand_towel','tea_towel','apron','chef_uniform','table_cloth',
    'napkin','floor_mat','laundry_bag','uniform','linen','other'
  )),
  ownership_type text not null default 'laundry_owned'
    check (ownership_type in ('laundry_owned','customer_owned','either')),
  replacement_cost numeric(12,2) not null default 0,
  rental_price numeric(12,2) not null default 0,
  wash_only_price numeric(12,2) not null default 0,
  weight_kg numeric(8,3) not null default 0,
  reorder_level integer not null default 0,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_items_sku on public.items(tenant_id, lower(sku)) where deleted_at is null;

-- --------------------------------------------------------------- vehicles ---
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,
  registration text not null,
  vin text,
  make text,
  model text,
  year integer check (year is null or (year between 1950 and 2100)),
  vehicle_type text not null default 'van'
    check (vehicle_type in ('van','truck','ute','trailer','prime_mover','other')),
  capacity_kg numeric(10,2),
  capacity_m3 numeric(10,2),
  fuel_type text check (fuel_type is null or fuel_type in ('diesel','petrol','electric','hybrid','lpg')),
  maintenance_status text not null default 'ok'
    check (maintenance_status in ('ok','due','overdue','in_service','out_of_service')),
  next_service_date date,
  trailer_id uuid references public.vehicles(id) on delete set null,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_vehicles_rego on public.vehicles(tenant_id, upper(registration)) where deleted_at is null;
create index idx_vehicles_depot on public.vehicles(depot_id);

create table public.fuel_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  driver_id uuid,                                  -- FK added below (drivers)
  logged_at timestamptz not null default now(),
  odometer_km integer,
  litres numeric(10,2),
  cost numeric(12,2),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_fuel_logs_vehicle on public.fuel_logs(vehicle_id, logged_at desc);

-- ---------------------------------------------------------------- drivers ---
create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  employee_number text,
  full_name text not null,
  email text,
  phone text,
  licence_number text,
  licence_expiry date,
  status text not null default 'active' check (status in ('active','on_leave','inactive','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create index idx_drivers_user on public.drivers(user_id);
create index idx_drivers_depot on public.drivers(depot_id);

alter table public.fuel_logs
  add constraint fuel_logs_driver_fk foreign key (driver_id)
  references public.drivers(id) on delete set null;

-- The driver row belonging to the calling user — used by resource-scoped RLS.
create or replace function public.current_driver_id(t uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select d.id from public.drivers d
  where d.tenant_id = t and d.user_id = (select auth.uid())
  limit 1;
$$;

-- ------------------------------------------------------------------- RLS ----
select public.apply_tenant_policy(t) from unnest(array[
  'depots','customers','customer_locations','customer_contacts',
  'items','vehicles','fuel_logs','drivers'
]) as t;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
