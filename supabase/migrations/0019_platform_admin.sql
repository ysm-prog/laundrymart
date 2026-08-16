-- ============================================================================
-- 0019_platform_admin — the one role that sits above a laundry rather than
-- inside one.
--
-- Every role until now has been a *membership*: a row in `memberships` naming
-- a person, a tenant and what they may do there. `super_admin` is the top of
-- that ladder and it is still bounded by one laundry — which is correct, and
-- is the whole reason `is_member()` is the isolation boundary.
--
-- A platform administrator is a different kind of thing. They run the
-- deployment: they create a laundry in the first place, they hold the
-- settings that apply to every laundry, and they are who looks at a release.
-- None of that belongs to any one tenant, so it cannot be expressed as a
-- membership row, and giving them a membership in each laundry would only
-- restate the problem — a laundry created tomorrow would need one too.
--
-- So this migration adds the first table in the schema **with no `tenant_id`**,
-- and widens the two helpers every policy already goes through.
--
--  1. `platform_admins` — one row per person, no tenant. `apply_tenant_policy`
--     is deliberately NOT used on it: that helper's whole job is to attach a
--     tenancy predicate, and there is no tenancy here to attach. Its policies
--     are written out below instead, and they are the tightest in the schema —
--     only a platform admin can see or change the list at all.
--
--  2. `is_platform_admin()`, and `or public.is_platform_admin()` folded into
--     `is_member()` and `has_role()`.
--
-- **Why widen the helpers rather than rewrite the policies.** Every privileged
-- surface in this schema already funnels through those two functions —
-- `invoices` and `laundry_prices` through `has_role`, everything else through
-- `is_member` (0017's archive wrapper included, since it wraps the existing
-- expression rather than replacing it). Changing the helpers therefore reaches
-- all of them at once, retroactively, and reaches policies not written yet.
--
-- Rewriting the policies instead would have been actively dangerous here, for
-- the reason 0017 already recorded: this repo's `invoices` policies carry
-- 0006's inline `has_role`, while the hosted project's were replaced with
-- `can_read_billing`/`can_write_billing` by a branch that has not landed. Any
-- migration that re-states either shape silently drops the other one's role
-- gate. Touching the helper underneath both leaves each exactly as it is.
--
-- Nothing is dropped, no policy is re-created, and no existing row changes.
-- A deployment with no `platform_admins` rows behaves precisely as it does
-- today — every added predicate is `or false`.
-- ============================================================================

-- ------------------------------------------------------------ the list ------
-- No `tenant_id`, no `depot_id` and no role column: the row IS the grant.
-- `on delete cascade` from auth.users, because a platform admin whose login is
-- gone is not a platform admin.
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Who they are for the audit trail's benefit. The address is resolved from
  -- auth.users at read time; this is the human note beside it ("Angelo, owner").
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);

comment on table public.platform_admins is
  'People who administer the deployment itself rather than one laundry. The '
  'only table in this schema without a tenant_id — see 0019.';

-- ---------------------------------------------------------- the helper ------
-- SECURITY DEFINER, which is also what stops the policies below recursing:
-- they call this function, and it reads the table with RLS bypassed. Exactly
-- the arrangement `has_role()` already has with `memberships`.
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.platform_admins p where p.user_id = (select auth.uid())
  );
$$;

-- --------------------------------------------------- widen the boundary -----
-- `is_member` is the isolation boundary for every tenant table in the schema.
-- The added clause ignores `t` on purpose: a platform admin is a member of
-- every laundry, including one created after this migration ran.
create or replace function public.is_member(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid())
  ) or public.is_platform_admin();
$$;

-- Same for the role gate, so a platform admin satisfies every privileged
-- surface — `invoices`, `laundry_prices`, `memberships`, `set_records_archived`
-- — without any of those policies being touched or even named here.
create or replace function public.has_role(t uuid, roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid()) and m.role = any(roles)
  ) or public.is_platform_admin();
$$;

-- A platform admin must never be narrowed to one driver's own run, even if
-- they also happen to hold a `driver` membership somewhere. Without this the
-- driver-scoped policies on daily_routes/jobs/laundry_orders would filter them
-- to `current_driver_id()` in that tenant while `is_member` said otherwise.
create or replace function public.is_driver_only(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid()) and m.role = 'driver'
  ) and not public.is_platform_admin();
$$;

-- ---------------------------------------------------------- the policies ----
alter table public.platform_admins enable row level security;

-- Only a platform admin can see that platform admins exist, or change who they
-- are. There is no read-for-members policy on purpose: an operations manager
-- has no business enumerating the people who can reach every laundry.
create policy platform_admins_manage on public.platform_admins
  for all to authenticated
  using ((select public.is_platform_admin()))
  with check ((select public.is_platform_admin()));

create trigger set_platform_admins_updated_at
  before update on public.platform_admins
  for each row execute procedure public.set_updated_at();

-- ------------------------------------------------- do not strand the app ----
-- The same lockout `wouldStrandTenant` guards on the People screen, one level
-- up and with no way back: remove the last platform admin and nobody can
-- create a laundry, hold the deployment settings or restore the row — the
-- policy above hides the table from everyone who is left. Only the service
-- role (which policies do not apply to) could undo it.
create or replace function public.guard_last_platform_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.platform_admins) <= 1 then
    raise exception 'Cannot remove the last platform administrator'
      using errcode = 'P0001';
  end if;
  return old;
end; $$;

create trigger guard_platform_admins_last
  before delete on public.platform_admins
  for each row execute procedure public.guard_last_platform_admin();

-- ------------------------------------------------------ creating laundries --
-- `tenants` has carried a select policy since 0001 and no insert or update
-- policy at all, which is why the two existing laundries were seeded by hand.
-- Creating and renaming one is platform work by definition.
create policy tenants_platform on public.tenants
  for all to authenticated
  using ((select public.is_platform_admin()))
  with check ((select public.is_platform_admin()));

-- ------------------------------------------------- deployment settings ------
-- One row, enforced by a constant primary key. `tenants.settings` (0013) is
-- per-laundry and stays exactly as it is; this is the layer above it — the
-- defaults a laundry is created with, and switches that apply to all of them.
-- Zod validates the shape at the read site, as 0013 decided for the same
-- reason: a jsonb bag that the database also has an opinion about needs a
-- migration every time a switch is added.
create table if not exists public.platform_settings (
  id boolean primary key default true check (id),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.platform_settings (id) values (true) on conflict do nothing;

alter table public.platform_settings enable row level security;

create policy platform_settings_manage on public.platform_settings
  for all to authenticated
  using ((select public.is_platform_admin()))
  with check ((select public.is_platform_admin()));

create trigger set_platform_settings_updated_at
  before update on public.platform_settings
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------- what shipped ----
-- The applied-migration ledger, read-only, for the Release screen.
--
-- It lives in `supabase_migrations`, which PostgREST does not publish — only
-- `public` is exposed — so a definer function is the only way to read it from
-- the app at all. That is a feature here rather than a workaround: the screen
-- can say what this deployment is running without anything being able to
-- *change* what it is running.
--
-- **Deliberately no counterpart that applies anything.** Migrations are applied
-- by CI and the Supabase console, which is where a schema change belongs — it
-- is reviewed, it is version-controlled, and it can be rolled back. A button in
-- a browser that runs DDL against a database holding 508 real customers is a
-- different risk, and one nobody needs to take to answer "what are we on?".
--
-- plpgsql with dynamic SQL, not plain SQL: local Postgres has no
-- `supabase_migrations` schema, and a SQL-language body is parsed at creation
-- time, so this migration would refuse to apply anywhere but the hosted
-- project. The handler returns nothing instead, and the screen says so.
create or replace function public.platform_migrations()
returns table (version text, name text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;

  return query execute
    'select m.version::text, coalesce(m.name, '''')::text
       from supabase_migrations.schema_migrations m order by m.version';
exception
  when undefined_table or invalid_schema_name then return;
end; $$;

-- ------------------------------------------------------------- grants -------
-- 0011: the implicit PUBLIC grant is re-created with every new function, so it
-- has to be revoked again here. `authenticated` needs `is_platform_admin` (the
-- policies above call it); nothing needs the delete guard directly.
-- Table privileges, as 0014 and 0018 do for theirs: 0001's
-- `grant … on all tables` only reached the tables that existed when it ran.
-- Without these the policies above never get a chance to run — Postgres refuses
-- at the privilege layer first, with "permission denied for table", which reads
-- nothing like the empty result RLS is supposed to produce. `anon` is
-- deliberately not granted anything.
grant select, insert, update, delete on public.platform_admins to authenticated;
grant select, insert, update, delete on public.platform_settings to authenticated;
grant all on public.platform_admins to service_role;
grant all on public.platform_settings to service_role;

revoke execute on function public.is_platform_admin() from public;
revoke execute on function public.platform_migrations() from public;
revoke execute on function public.guard_last_platform_admin() from public;
revoke execute on function public.is_member(uuid) from public;
revoke execute on function public.has_role(uuid, text[]) from public;
revoke execute on function public.is_driver_only(uuid) from public;
revoke execute on all functions in schema public from anon;
grant execute on function public.is_platform_admin() to authenticated, service_role;
grant execute on function public.platform_migrations() to authenticated, service_role;
grant execute on function public.is_member(uuid) to authenticated, service_role;
grant execute on function public.has_role(uuid, text[]) to authenticated, service_role;
grant execute on function public.is_driver_only(uuid) to authenticated, service_role;

-- Assert the 0011 posture survived this migration's four `create or replace`
-- statements, rather than trusting that it did.
do $$
declare v_leaked text;
begin
  select string_agg(p.proname, ', ') into v_leaked
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_leaked is not null then
    raise exception 'anon can still execute: %', v_leaked using errcode = 'P0001';
  end if;
end $$;

-- ============================================================================
-- Bootstrap. There is no screen that can create the first platform admin —
-- the policy above requires one to already exist — so it is a deliberate
-- console step, run once per deployment with the service role:
--
--   insert into public.platform_admins (user_id, note)
--   select id, 'bootstrap' from auth.users where email = 'you@example.com';
--
-- Every one after that is added from Platform → Administrators.
-- ============================================================================
