-- ============================================================================
-- 0003_service_agreements — the contract that drives scheduling AND billing.
-- Spec §7.4 (patterns, holiday rules, minimum charges, versioning) + §7.14.
-- ============================================================================

-- Holiday calendar per jurisdiction (spec §11 / open question §18).
create table public.public_holidays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  holiday_date date not null,
  name text not null,
  region text not null default 'NSW',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create unique index uq_public_holidays on public.public_holidays(tenant_id, region, holiday_date);

-- --------------------------------------------------------------- agreement ---
-- Service patterns are stored as JSON so weekly / alternate-weekly / monthly-nth
-- / custom all share one column. Shape (validated app-side by Zod):
--   { "type": "weekly",           "weekdays": [1,3,5] }
--   { "type": "alternate_weekly", "weekdays": [1], "anchorDate": "2026-01-05" }
--   { "type": "monthly_nth",      "weekday": 1, "nth": 1 }
--   { "type": "custom",           "dates": ["2026-03-01", "2026-03-14"] }
create table public.service_agreements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  location_id uuid references public.customer_locations(id) on delete set null,
  depot_id uuid references public.depots(id) on delete set null,
  agreement_number text not null,
  version integer not null default 1 check (version >= 1),
  supersedes_id uuid references public.service_agreements(id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft','active','suspended','expired','terminated')),
  start_date date not null,
  end_date date,
  pickup_pattern jsonb not null default '{"type":"weekly","weekdays":[]}'::jsonb,
  delivery_pattern jsonb not null default '{"type":"weekly","weekdays":[]}'::jsonb,
  collections_per_visit integer not null default 1 check (collections_per_visit >= 1),
  emergency_service boolean not null default false,
  linen_ownership text not null default 'rental'
    check (linen_ownership in ('rental','customer_owned','mixed')),
  minimum_charge numeric(12,2) not null default 0 check (minimum_charge >= 0),
  holiday_rule text not null default 'next_business_day'
    check (holiday_rule in ('skip','next_business_day','previous_business_day','service_as_normal')),
  holiday_region text not null default 'NSW',
  weekend_surcharge_pct numeric(6,3) not null default 0,
  holiday_surcharge_pct numeric(6,3) not null default 0,
  fuel_levy_pct numeric(6,3) not null default 0,
  billing_frequency text not null default 'monthly'
    check (billing_frequency in ('per_service','weekly','fortnightly','monthly')),
  payment_terms_days integer not null default 14,
  purchase_order_number text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz,
  constraint service_agreements_dates check (end_date is null or end_date >= start_date)
);
create unique index uq_service_agreements_number
  on public.service_agreements(tenant_id, agreement_number, version);
create index idx_service_agreements_customer on public.service_agreements(customer_id, status);

-- Priced lines. Pricing precedence (§11): agreement line → item default →
-- category → global default. The agreement line is the top of that chain.
create table public.service_agreement_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  agreement_id uuid not null references public.service_agreements(id) on delete cascade,
  item_id uuid references public.items(id) on delete restrict,
  charge_type text not null default 'rental' check (charge_type in (
    'rental','wash_only','replacement','minimum_service_fee','fuel_levy',
    'emergency_delivery','weekend_surcharge','holiday_surcharge','bag_charge',
    'weight_charge','monthly_fee','other'
  )),
  pricing_model text not null default 'per_item' check (pricing_model in (
    'per_item','per_kg','per_collection','monthly','percentage'
  )),
  unit_price numeric(12,2) not null default 0,
  percentage numeric(6,3),
  standard_quantity numeric(12,2) not null default 0,
  included_quantity numeric(12,2) not null default 0,
  taxable boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  constraint sal_percentage_present
    check (pricing_model <> 'percentage' or percentage is not null)
);
create index idx_sal_agreement on public.service_agreement_lines(agreement_id);
create index idx_sal_item on public.service_agreement_lines(item_id);

-- §7.5: items cannot be deleted while referenced by an active agreement — the
-- `on delete restrict` above enforces hard deletes; soft delete is guarded here.
create or replace function public.guard_item_soft_delete()
returns trigger language plpgsql as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    if exists (
      select 1 from public.service_agreement_lines l
      join public.service_agreements a on a.id = l.agreement_id
      where l.item_id = new.id and a.status = 'active' and a.deleted_at is null
    ) then
      raise exception 'item % is referenced by an active service agreement', new.sku
        using errcode = '23503';
    end if;
  end if;
  return new;
end $$;

create trigger guard_items_delete before update on public.items
  for each row execute procedure public.guard_item_soft_delete();

-- ------------------------------------------------------------------- RLS ----
select public.apply_tenant_policy(t) from unnest(array[
  'public_holidays','service_agreements','service_agreement_lines'
]) as t;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
