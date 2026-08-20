-- ============================================================================
-- 0004_routing_execution — Route Template → Daily Route → Job → Pickup/Delivery.
-- Spec §7.7–7.12. Drivers are resource-scoped: they only ever see their own run.
-- ============================================================================

-- -------------------------------------------------------- route templates ---
create table public.route_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,
  code text not null,
  name text not null,
  description text,
  weekdays integer[] not null default '{}',        -- ISO 1=Mon … 7=Sun
  default_driver_id uuid references public.drivers(id) on delete set null,
  default_vehicle_id uuid references public.vehicles(id) on delete set null,
  planned_start_time time,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_route_templates_code on public.route_templates(tenant_id, lower(code)) where deleted_at is null;

create table public.route_template_stops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  template_id uuid not null references public.route_templates(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  location_id uuid references public.customer_locations(id) on delete set null,
  sequence integer not null default 1 check (sequence >= 1),
  service_type text not null default 'both' check (service_type in ('pickup','delivery','both')),
  planned_arrival time,
  service_minutes integer not null default 15,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_rts_template on public.route_template_stops(template_id, sequence);

-- ------------------------------------------------------------ daily route ---
create table public.daily_routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,
  template_id uuid references public.route_templates(id) on delete set null,
  route_date date not null,
  code text not null,
  name text not null,
  driver_id uuid references public.drivers(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  trailer_id uuid references public.vehicles(id) on delete set null,
  status text not null default 'planned' check (status in (
    'planned','inspection_pending','inspection_complete','load_confirmed',
    'in_progress','returning','unloading','closed','cancelled'
  )),
  inspection_id uuid,                              -- FK added below
  load_confirmed_at timestamptz,
  load_confirmed_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  returned_at timestamptz,
  unloaded_at timestamptz,
  closed_at timestamptz,
  odometer_start_km integer,
  odometer_end_km integer,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_daily_routes_day on public.daily_routes(tenant_id, route_date, lower(code));
create index idx_daily_routes_driver on public.daily_routes(driver_id, route_date);
create index idx_daily_routes_date on public.daily_routes(tenant_id, route_date);

-- ---------------------------------------------------- vehicle inspections ---
-- §11: inspection is mandatory before a run can start.
create table public.vehicle_inspections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  driver_id uuid references public.drivers(id) on delete set null,
  route_id uuid references public.daily_routes(id) on delete cascade,
  inspected_at timestamptz not null default now(),
  odometer_km integer,
  checklist jsonb not null default '{}'::jsonb,
  result text not null default 'pass' check (result in ('pass','pass_with_defects','fail')),
  defects text,
  photo_urls text[] not null default '{}',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_vehicle_inspections_route on public.vehicle_inspections(route_id);

alter table public.daily_routes
  add constraint daily_routes_inspection_fk foreign key (inspection_id)
  references public.vehicle_inspections(id) on delete set null;

-- -------------------------------------------------------------------- jobs ---
-- The Job is the operational unit dispatchers and drivers work with (§7.9).
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,
  route_id uuid references public.daily_routes(id) on delete set null,
  customer_id uuid not null references public.customers(id) on delete cascade,
  location_id uuid references public.customer_locations(id) on delete set null,
  agreement_id uuid references public.service_agreements(id) on delete set null,
  driver_id uuid references public.drivers(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  job_number text not null,
  scheduled_date date not null,
  sequence integer not null default 1,
  service_type text not null default 'both' check (service_type in ('pickup','delivery','both')),
  status text not null default 'scheduled' check (status in (
    'scheduled','assigned','in_progress','completed','exception','cancelled'
  )),
  progress_status text not null default 'not_started' check (progress_status in (
    'not_started','travelling','at_customer','pickup_completed','delivery_completed','completed'
  )),
  arrived_at timestamptz,
  completed_at timestamptz,
  exception_reason text,
  exception_notes text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_jobs_number on public.jobs(tenant_id, job_number);
create index idx_jobs_route on public.jobs(route_id, sequence);
create index idx_jobs_customer on public.jobs(customer_id, scheduled_date desc);
create index idx_jobs_date on public.jobs(tenant_id, scheduled_date, status);
create index idx_jobs_driver on public.jobs(driver_id, scheduled_date);

-- ----------------------------------------------------- pickups/deliveries ---
create table public.pickups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  driver_id uuid references public.drivers(id) on delete set null,
  route_id uuid references public.daily_routes(id) on delete set null,
  pickup_date date not null default current_date,
  total_weight_kg numeric(10,3),
  bag_count integer not null default 0,
  notes text,
  photo_urls text[] not null default '{}',
  signature_url text,
  signed_by text,
  completed_at timestamptz,
  synced_at timestamptz,
  client_ref text,                                  -- offline idempotency key
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create unique index uq_pickups_client_ref on public.pickups(tenant_id, client_ref) where client_ref is not null;
create index idx_pickups_job on public.pickups(job_id);

create table public.pickup_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pickup_id uuid not null references public.pickups(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete restrict,
  quantity integer not null default 0 check (quantity >= 0),
  damaged_quantity integer not null default 0 check (damaged_quantity >= 0),
  missing_quantity integer not null default 0 check (missing_quantity >= 0),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_pickup_lines_pickup on public.pickup_lines(pickup_id);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  driver_id uuid references public.drivers(id) on delete set null,
  route_id uuid references public.daily_routes(id) on delete set null,
  delivery_date date not null default current_date,
  notes text,
  photo_urls text[] not null default '{}',
  signature_url text,
  signed_by text,
  completed_at timestamptz,
  synced_at timestamptz,
  client_ref text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create unique index uq_deliveries_client_ref on public.deliveries(tenant_id, client_ref) where client_ref is not null;
create index idx_deliveries_job on public.deliveries(job_id);

create table public.delivery_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  delivery_id uuid not null references public.deliveries(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete restrict,
  quantity integer not null default 0 check (quantity >= 0),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_delivery_lines_delivery on public.delivery_lines(delivery_id);

-- Ad-hoc charges captured in the field (§7.12).
create table public.additional_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  charge_type text not null default 'other' check (charge_type in (
    'replacement','emergency_delivery','weekend_surcharge','holiday_surcharge',
    'bag_charge','weight_charge','fuel_levy','minimum_service_fee','other'
  )),
  description text not null,
  quantity numeric(12,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0,
  invoiced_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_additional_charges_customer on public.additional_charges(customer_id, invoiced_at);

-- ------------------------------------------------------- business rules ------
-- §11: inspection before start, load confirmation before route start,
-- run close before the route can be marked complete.
create or replace function public.guard_route_transition()
returns trigger language plpgsql as $$
begin
  if new.status = 'in_progress' and old.status <> 'in_progress' then
    if new.inspection_id is null then
      raise exception 'vehicle inspection is required before starting the run'
        using errcode = 'P0001';
    end if;
    if new.load_confirmed_at is null then
      raise exception 'load must be confirmed before starting the route'
        using errcode = 'P0001';
    end if;
    new.started_at = coalesce(new.started_at, now());
  end if;

  if new.status = 'closed' and old.status <> 'closed' then
    if new.unloaded_at is null then
      raise exception 'the run must be unloaded before it can be closed'
        using errcode = 'P0001';
    end if;
    new.closed_at = coalesce(new.closed_at, now());
  end if;
  return new;
end $$;

create trigger guard_daily_routes_transition before update on public.daily_routes
  for each row execute procedure public.guard_route_transition();

-- ------------------------------------------------------------------- RLS ----
select public.apply_tenant_policy(t) from unnest(array[
  'route_templates','route_template_stops','additional_charges'
]) as t;

-- Driver-scoped tables: full tenant visibility for office roles, own-run only
-- for drivers. Child tables inherit scope through the parent's own RLS.
alter table public.daily_routes enable row level security;
create index idx_daily_routes_tenant on public.daily_routes(tenant_id);
create trigger set_daily_routes_updated_at before update on public.daily_routes
  for each row execute procedure public.set_updated_at();
create policy daily_routes_access on public.daily_routes for all to authenticated
  using (
    (select public.is_member(tenant_id))
    and (not (select public.is_driver_only(tenant_id))
         or driver_id = (select public.current_driver_id(tenant_id)))
  )
  with check (
    (select public.is_member(tenant_id))
    and (not (select public.is_driver_only(tenant_id))
         or driver_id = (select public.current_driver_id(tenant_id)))
  );

alter table public.jobs enable row level security;
create index idx_jobs_tenant on public.jobs(tenant_id);
create trigger set_jobs_updated_at before update on public.jobs
  for each row execute procedure public.set_updated_at();
create policy jobs_access on public.jobs for all to authenticated
  using (
    (select public.is_member(tenant_id))
    and (not (select public.is_driver_only(tenant_id))
         or driver_id = (select public.current_driver_id(tenant_id)))
  )
  with check (
    (select public.is_member(tenant_id))
    and (not (select public.is_driver_only(tenant_id))
         or driver_id = (select public.current_driver_id(tenant_id)))
  );

-- Job children: visible exactly when the parent job is (parent RLS applies to
-- the subquery), so a driver can never reach another driver's paperwork.
do $$
declare t text;
begin
  foreach t in array array['pickups','deliveries','vehicle_inspections'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create index if not exists %I on public.%I(tenant_id)', 'idx_'||t||'_tenant', t);
    execute format('create trigger %I before update on public.%I for each row
                    execute procedure public.set_updated_at()', 'set_'||t||'_updated_at', t);
  end loop;
end $$;

create policy pickups_access on public.pickups for all to authenticated
  using ((select public.is_member(tenant_id))
         and exists (select 1 from public.jobs j where j.id = job_id))
  with check ((select public.is_member(tenant_id))
         and exists (select 1 from public.jobs j where j.id = job_id));

create policy deliveries_access on public.deliveries for all to authenticated
  using ((select public.is_member(tenant_id))
         and exists (select 1 from public.jobs j where j.id = job_id))
  with check ((select public.is_member(tenant_id))
         and exists (select 1 from public.jobs j where j.id = job_id));

create policy vehicle_inspections_access on public.vehicle_inspections for all to authenticated
  using ((select public.is_member(tenant_id))
         and (route_id is null or exists (select 1 from public.daily_routes r where r.id = route_id)))
  with check ((select public.is_member(tenant_id))
         and (route_id is null or exists (select 1 from public.daily_routes r where r.id = route_id)));

do $$
declare t text;
begin
  foreach t in array array['pickup_lines','delivery_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create index if not exists %I on public.%I(tenant_id)', 'idx_'||t||'_tenant', t);
    execute format('create trigger %I before update on public.%I for each row
                    execute procedure public.set_updated_at()', 'set_'||t||'_updated_at', t);
  end loop;
end $$;

create policy pickup_lines_access on public.pickup_lines for all to authenticated
  using ((select public.is_member(tenant_id))
         and exists (select 1 from public.pickups p where p.id = pickup_id))
  with check ((select public.is_member(tenant_id))
         and exists (select 1 from public.pickups p where p.id = pickup_id));

create policy delivery_lines_access on public.delivery_lines for all to authenticated
  using ((select public.is_member(tenant_id))
         and exists (select 1 from public.deliveries d where d.id = delivery_id))
  with check ((select public.is_member(tenant_id))
         and exists (select 1 from public.deliveries d where d.id = delivery_id));

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
