-- ============================================================================
-- 0001_init — multi-tenant spine for the Laundry Management System.
-- RLS is the isolation boundary; the app never relies on it alone.
-- ============================================================================
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tenants ---
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  abn text,
  gst_rate numeric(5,4) not null default 0.1000,   -- AU GST defaults to 10%
  timezone text not null default 'Australia/Sydney',
  status text not null default 'active' check (status in ('active','suspended','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  deleted_at timestamptz
);

-- Roles from the spec §3. Kept as a checked text column (not an enum) so new
-- roles can be added without a table rewrite.
create table public.memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role text not null default 'dispatcher' check (role in (
    'super_admin','operations_manager','dispatcher','driver','finance',
    'warehouse_operator','customer_service','sales','branch_manager',
    'regional_manager','auditor'
  )),
  depot_id uuid,                                   -- FK added in 0002 (depots)
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);
create index idx_memberships_user on public.memberships(user_id);
create index idx_memberships_tenant on public.memberships(tenant_id);

-- ---------------------------------------------------------------- helpers ---
-- Membership check used by every RLS policy. STABLE + pinned search_path.
create or replace function public.is_member(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid())
  );
$$;

-- Role gate for privileged surfaces (finance, admin).
create or replace function public.has_role(t uuid, roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid()) and m.role = any(roles)
  );
$$;

-- True when the caller's role in the tenant is 'driver' — drivers see their own
-- run and nothing else (spec §3 "Driver: own run only").
create or replace function public.is_driver_only(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid()) and m.role = 'driver'
  );
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- Attach RLS (member policy), tenant index and updated_at trigger to a table.
-- Used by every later migration so a tenant table can never ship without RLS.
create or replace function public.apply_tenant_policy(tbl text)
returns void language plpgsql as $$
begin
  execute format('alter table public.%I enable row level security', tbl);
  execute format(
    'create policy %I on public.%I for all to authenticated
       using ((select public.is_member(tenant_id)))
       with check ((select public.is_member(tenant_id)))',
    tbl || '_member', tbl);
  execute format('create index if not exists %I on public.%I(tenant_id)',
                 'idx_' || tbl || '_tenant', tbl);
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = tbl and column_name = 'updated_at') then
    execute format('create trigger %I before update on public.%I
                    for each row execute procedure public.set_updated_at()',
                   'set_' || tbl || '_updated_at', tbl);
  end if;
end $$;

-- ------------------------------------------------------ sequential numbers ---
-- Business rule §11: customer and invoice numbers must be unique + sequential.
create table public.number_sequences (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null,
  prefix text not null default '',
  next_value bigint not null default 1,
  primary key (tenant_id, kind)
);

create or replace function public.next_number(t uuid, k text, p text default '')
returns text language plpgsql security definer set search_path = public as $$
declare n bigint; pre text;
begin
  insert into public.number_sequences (tenant_id, kind, prefix)
    values (t, k, p) on conflict (tenant_id, kind) do nothing;
  update public.number_sequences
     set next_value = next_value + 1
   where tenant_id = t and kind = k
   returning next_value - 1, prefix into n, pre;
  return coalesce(nullif(pre, ''), p) || lpad(n::text, 5, '0');
end $$;

-- ------------------------------------------------------------- audit logs ---
-- NFR §8: audit logging for all writes.
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  entity text not null,
  entity_id uuid,
  action text not null,
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_logs_entity on public.audit_logs(tenant_id, entity, entity_id);
create index idx_audit_logs_created on public.audit_logs(tenant_id, created_at desc);

-- ------------------------------------------------------------------- RLS ----
alter table public.tenants enable row level security;
alter table public.memberships enable row level security;
alter table public.number_sequences enable row level security;

create policy tenants_member on public.tenants
  for select to authenticated using ((select public.is_member(id)));

create policy memberships_self on public.memberships
  for select to authenticated using (user_id = (select auth.uid()));

-- Admins manage the tenant's user list.
create policy memberships_admin on public.memberships
  for all to authenticated
  using ((select public.has_role(tenant_id, array['super_admin','operations_manager'])))
  with check ((select public.has_role(tenant_id, array['super_admin','operations_manager'])));

create policy number_sequences_member on public.number_sequences
  for select to authenticated using ((select public.is_member(tenant_id)));

select public.apply_tenant_policy('audit_logs');

create trigger set_tenants_updated_at before update on public.tenants
  for each row execute procedure public.set_updated_at();

-- Supabase grants these by default; stated explicitly so local/CI Postgres
-- behaves the same as the hosted project.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
