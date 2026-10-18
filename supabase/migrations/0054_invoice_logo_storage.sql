-- ============================================================================
-- 0054_invoice_logo_storage — the laundry's logo, kept as the laundry's data
--
-- Brief 1.10 (18 October 2026): the invoice PDF is rebuilt to the layout of the
-- laundry's own MYOB invoice, which carries its logo top-left. The logo is the
-- tenant's data, uploaded on Settings › Invoicing — not an asset committed to
-- this repository — so it needs somewhere private to live.
--
-- One private bucket, `tenant-branding`, keyed by tenant exactly as 0007's
-- `run-media` is: the first path segment is the tenant id, and the policies read
-- it back through `media_tenant()`.
--
--     <tenant_id>/invoice-logo-<stamp>.<png|jpg>
--
-- **Read by any member, changed by the Owner.** Every role that can open an
-- invoice renders its PDF, and the PDF embeds the logo, so reading has to be as
-- wide as membership. Writing is `super_admin` — the one role that can open
-- Settings › Invoicing (`admin.write`) — because a logo printed on every tax
-- invoice is not something a driver or a round should be able to replace
-- straight off the Storage API. `run-media` is deliberately writable by any
-- member (a driver uploads their own proof of delivery); this bucket is not.
--
-- PNG and JPEG only, 1 MB at most: those are the two formats a PDF can embed,
-- and the app caps an upload at 900 KB to fit inside a server action's body.
--
-- Adds one bucket row and four policies on `storage.objects`. No table, no
-- column, no function; changes no row of ours. **Written, NOT applied to
-- `laundrymart-syd`.** Until it is, uploading a logo fails with a sentence and
-- every invoice prints exactly as it would with no logo set.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-branding', 'tenant-branding', false, 1048576, array['image/png', 'image/jpeg'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists tenant_branding_read on storage.objects;
drop policy if exists tenant_branding_write on storage.objects;
drop policy if exists tenant_branding_update on storage.objects;
drop policy if exists tenant_branding_delete on storage.objects;

create policy tenant_branding_read on storage.objects
  for select to authenticated
  using (bucket_id = 'tenant-branding'
         and (select public.is_member(public.media_tenant(name))));

create policy tenant_branding_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tenant-branding'
              and (select public.has_role(public.media_tenant(name), array['super_admin'])));

create policy tenant_branding_update on storage.objects
  for update to authenticated
  using (bucket_id = 'tenant-branding'
         and (select public.has_role(public.media_tenant(name), array['super_admin'])))
  with check (bucket_id = 'tenant-branding'
              and (select public.has_role(public.media_tenant(name), array['super_admin'])));

create policy tenant_branding_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'tenant-branding'
         and (select public.has_role(public.media_tenant(name), array['super_admin'])));

-- ------------------------------------------------------- self-assertions ----
do $$
declare n int;
begin
  if not exists (select 1 from storage.buckets where id = 'tenant-branding' and not public) then
    raise exception '0054: the tenant-branding bucket is missing or public';
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and policyname like 'tenant_branding_%';
  if n <> 4 then raise exception '0054: % of 4 tenant-branding policies present', n; end if;

  -- The write half names the Owner and nobody wider. A `for all` policy or an
  -- `is_member` write would hand every round the invoice logo.
  select count(*) into n from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('tenant_branding_write', 'tenant_branding_update', 'tenant_branding_delete')
     and coalesce(with_check, qual) not ilike '%super_admin%';
  if n <> 0 then raise exception '0054: a tenant-branding write policy is not limited to the owner'; end if;

  select count(*) into n from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'tenant_branding_%' and cmd = 'ALL';
  if n <> 0 then raise exception '0054: a tenant-branding policy is FOR ALL'; end if;
end $$;
