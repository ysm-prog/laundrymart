-- Local/CI shim for the parts of a Supabase project that live outside our
-- migrations: the auth schema, auth.uid(), and the three Supabase roles.
create extension if not exists pgcrypto;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;

-- Supabase grants these; security-invoker functions that call auth.uid() need
-- them, so the local shim must match or tests fail for the wrong reason.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
