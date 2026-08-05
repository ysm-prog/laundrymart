-- ============================================================================
-- 0005_inventory — stock positions across every state, and the movement ledger
-- that connects them. Spec §7.13 + acceptance criteria §10 (inventory).
-- ============================================================================

-- A pool is "how many of item X, owned by Y, currently in state Z, at place W".
create table public.inventory_pools (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete restrict,
  owner_type text not null default 'laundry_owned'
    check (owner_type in ('laundry_owned','customer_owned')),
  state text not null check (state in (
    'at_customer','in_transit','at_depot','washing','drying','folding','packing',
    'ready_for_dispatch','in_repair','damaged','lost','written_off'
  )),
  customer_id uuid references public.customers(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  quantity integer not null default 0,
  reorder_level integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);

-- One pool per (item, owner, state, place). NULL place columns are normalised
-- to the nil UUID so the uniqueness actually holds.
create unique index uq_inventory_pools on public.inventory_pools (
  tenant_id, item_id, owner_type, state,
  coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(depot_id,    '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(vehicle_id,  '00000000-0000-0000-0000-000000000000'::uuid)
);
create index idx_inventory_pools_item on public.inventory_pools(tenant_id, item_id, state);
create index idx_inventory_pools_customer on public.inventory_pools(customer_id) where customer_id is not null;

-- Every state change is a ledger row: inventory is conserved, minus write-offs.
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete restrict,
  owner_type text not null default 'laundry_owned'
    check (owner_type in ('laundry_owned','customer_owned')),
  quantity integer not null check (quantity > 0),
  from_state text,
  to_state text,
  from_pool_id uuid references public.inventory_pools(id) on delete set null,
  to_pool_id uuid references public.inventory_pools(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  depot_id uuid references public.depots(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  pickup_id uuid references public.pickups(id) on delete set null,
  delivery_id uuid references public.deliveries(id) on delete set null,
  reason text not null default 'manual' check (reason in (
    'pickup','delivery','unload','wash','dry','fold','pack','dispatch',
    'repair','damage','loss','write_off','stock_count','purchase','manual'
  )),
  notes text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint inventory_movements_endpoints check (from_state is not null or to_state is not null)
);
create index idx_inventory_movements_item on public.inventory_movements(tenant_id, item_id, occurred_at desc);
create index idx_inventory_movements_job on public.inventory_movements(job_id);

-- Periodic counts and the variance they expose.
create table public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  counted_on date not null default current_date,
  status text not null default 'draft' check (status in ('draft','submitted','reconciled')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);

create table public.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  stock_count_id uuid not null references public.stock_counts(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete restrict,
  state text not null default 'at_depot',
  expected_quantity integer not null default 0,
  counted_quantity integer not null default 0,
  variance integer generated always as (counted_quantity - expected_quantity) stored,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_stock_count_lines_count on public.stock_count_lines(stock_count_id);

-- Reusable bags/containers (spec §7.13 "bag/container tracking").
create table public.containers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  barcode text not null,
  container_type text not null default 'bag'
    check (container_type in ('bag','cage','trolley','tub','pallet')),
  state text not null default 'at_depot' check (state in (
    'at_customer','in_transit','at_depot','in_repair','lost','written_off'
  )),
  customer_id uuid references public.customers(id) on delete set null,
  depot_id uuid references public.depots(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  deposit_amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_containers_barcode on public.containers(tenant_id, barcode) where deleted_at is null;

-- --------------------------------------------------------------- movement ---
-- Single entry point for stock changes: upserts both pools and writes the
-- ledger row in one transaction so the books always balance. Runs as INVOKER so
-- RLS still applies — a caller can only move stock inside their own tenant.
-- Find-or-create one pool. The nil-UUID coalesce mirrors uq_inventory_pools.
create or replace function public.upsert_inventory_pool(
  p_tenant uuid, p_item uuid, p_owner_type text, p_state text,
  p_customer uuid, p_depot uuid, p_vehicle uuid, p_delta integer
) returns uuid language plpgsql security invoker set search_path = public as $$
declare v_pool uuid;
begin
  insert into public.inventory_pools
    (tenant_id, item_id, owner_type, state, customer_id, depot_id, vehicle_id, quantity)
  values (p_tenant, p_item, p_owner_type, p_state, p_customer, p_depot, p_vehicle, p_delta)
  on conflict (tenant_id, item_id, owner_type, state,
               coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(depot_id,    '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(vehicle_id,  '00000000-0000-0000-0000-000000000000'::uuid))
  do update set quantity = public.inventory_pools.quantity + excluded.quantity
  returning id into v_pool;
  return v_pool;
end $$;

-- A movement has two independent endpoints: a pickup takes stock out of
-- at_customer@customer and puts it into in_transit@vehicle. Either end may be
-- null (null from = stock entering the system; null to = write-off).
create or replace function public.move_inventory(
  p_tenant uuid,
  p_item uuid,
  p_owner_type text,
  p_quantity integer,
  p_from_state text,
  p_to_state text,
  p_reason text default 'manual',
  p_from_customer uuid default null,
  p_from_depot uuid default null,
  p_from_vehicle uuid default null,
  p_to_customer uuid default null,
  p_to_depot uuid default null,
  p_to_vehicle uuid default null,
  p_job uuid default null,
  p_pickup uuid default null,
  p_delivery uuid default null,
  p_notes text default null
) returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_from_pool uuid;
  v_to_pool uuid;
  v_movement uuid;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'movement quantity must be positive' using errcode = '22023';
  end if;
  if p_from_state is null and p_to_state is null then
    raise exception 'a movement needs at least one endpoint' using errcode = '22023';
  end if;

  if p_from_state is not null then
    v_from_pool := public.upsert_inventory_pool(
      p_tenant, p_item, p_owner_type, p_from_state,
      p_from_customer, p_from_depot, p_from_vehicle, -p_quantity);
  end if;

  if p_to_state is not null then
    v_to_pool := public.upsert_inventory_pool(
      p_tenant, p_item, p_owner_type, p_to_state,
      p_to_customer, p_to_depot, p_to_vehicle, p_quantity);
  end if;

  insert into public.inventory_movements (
    tenant_id, item_id, owner_type, quantity, from_state, to_state,
    from_pool_id, to_pool_id, customer_id, depot_id, vehicle_id,
    job_id, pickup_id, delivery_id, reason, notes, created_by
  ) values (
    p_tenant, p_item, p_owner_type, p_quantity, p_from_state, p_to_state,
    v_from_pool, v_to_pool,
    coalesce(p_from_customer, p_to_customer),
    coalesce(p_to_depot, p_from_depot),
    coalesce(p_to_vehicle, p_from_vehicle),
    p_job, p_pickup, p_delivery, coalesce(p_reason, 'manual'), p_notes, (select auth.uid())
  ) returning id into v_movement;

  return v_movement;
end $$;

-- ------------------------------------------------------------------- RLS ----
select public.apply_tenant_policy(t) from unnest(array[
  'inventory_pools','inventory_movements','stock_counts','stock_count_lines','containers'
]) as t;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
