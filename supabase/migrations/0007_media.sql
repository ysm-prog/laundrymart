-- ============================================================================
-- 0007_media — proof-of-service photos and signatures (spec §7.8, §7.10)
--
-- The columns already existed (pickups/deliveries/vehicle_inspections carry
-- photo_urls and signature_url); this migration gives them somewhere to point.
--
-- Files live in one private bucket keyed by tenant, so the object path itself
-- carries the tenancy:
--
--     <tenant_id>/<scope>/<owner_ref>/<file>
--
-- The storage policies read that first segment back through is_member(), which
-- means a driver holding a valid session for tenant A still cannot list — let
-- alone fetch — tenant B's paperwork. Nothing is ever served publicly: reads go
-- through short-lived signed URLs minted server-side.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('run-media', 'run-media', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public            = excluded.public,
      file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The tenant segment of an object key, or null when the key is not shaped like
-- one of ours. Returning null rather than raising matters: the policies below
-- are evaluated against every object in every bucket, and a hard cast would
-- turn an unrelated upload into an error instead of a clean "not yours".
create or replace function public.media_tenant(object_name text)
returns uuid language sql immutable as $$
  select case
    when (storage.foldername(object_name))[1]
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then ((storage.foldername(object_name))[1])::uuid
  end;
$$;

-- On the hosted project `storage.objects` belongs to `supabase_storage_admin`
-- and already has RLS on, so this ALTER would fail with "must be owner of table
-- objects" and take the whole migration with it. Locally the table is the shim
-- from pg-bootstrap.sql, which we do own and which starts with RLS off — hence
-- the guard rather than an unconditional statement. Creating policies on the
-- table is separately granted to `postgres`, so everything below is fine.
do $$
begin
  if not (
    select c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'storage' and c.relname = 'objects'
  ) then
    execute 'alter table storage.objects enable row level security';
  end if;
end $$;

drop policy if exists run_media_member_read on storage.objects;
drop policy if exists run_media_member_write on storage.objects;
drop policy if exists run_media_member_update on storage.objects;
drop policy if exists run_media_member_delete on storage.objects;

create policy run_media_member_read on storage.objects
  for select to authenticated
  using (bucket_id = 'run-media'
         and (select public.is_member(public.media_tenant(name))));

create policy run_media_member_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'run-media'
              and (select public.is_member(public.media_tenant(name))));

-- Replays of an offline queue re-upload to the same deterministic key, so an
-- update has to be allowed — bounded to the caller's own tenant on both sides
-- so it can never be used to move an object across the boundary.
create policy run_media_member_update on storage.objects
  for update to authenticated
  using (bucket_id = 'run-media'
         and (select public.is_member(public.media_tenant(name))))
  with check (bucket_id = 'run-media'
              and (select public.is_member(public.media_tenant(name))));

create policy run_media_member_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'run-media'
         and (select public.is_member(public.media_tenant(name))));

grant execute on function public.media_tenant(text) to anon, authenticated, service_role;
