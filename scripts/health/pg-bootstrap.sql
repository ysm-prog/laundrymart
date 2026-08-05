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
