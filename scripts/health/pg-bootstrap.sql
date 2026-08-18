-- Local/CI shim for the parts of a Supabase project that live outside our
-- migrations: the auth schema, auth.uid(), and the three Supabase roles.
create extension if not exists pgcrypto;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
-- 0030 reads a member's name out of the metadata GoTrue stores it in. The shim
-- predates that column, so add it rather than re-creating the table: an existing
-- local database must gain it too, or `tenant_members` fails to compile there
-- and passes in CI for the wrong reason.
alter table auth.users add column if not exists raw_user_meta_data jsonb;
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

-- Storage lives outside our migrations too. Only the parts 0007_media touches
-- are shimmed: the bucket registry, the object table its policies attach to,
-- and foldername(), which splits an object key into its path segments.
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid,
  created_at timestamptz not null default now()
);

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))
         [1 : greatest(coalesce(array_length(string_to_array(name, '/'), 1), 0) - 1, 0)];
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;
grant all on storage.objects, storage.buckets to service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Supabase's stock default privileges, mirrored so a local run reproduces the
-- hosted posture rather than a friendlier one.
--
-- A hosted project grants `anon` and `authenticated` on **every** table created
-- in `public`, through default ACLs this repo never wrote. That is where the
-- hole 0029 closes came from — and because the shim did not reproduce it, a
-- local run and CI both looked clean for months while the live database had
-- `anon` holding all seven privileges on 52 tables.
--
-- With this here, 0029 has something real to revoke and its proof in
-- `rls_coverage.test.sql` is worth reading. Without it the assertions pass
-- vacuously, which is worse than not having them.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
