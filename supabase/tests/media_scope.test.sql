-- Proof: run media is tenant-scoped by its object key.
--
-- The photo of a delivery is evidence in a billing dispute, so "another
-- laundry's driver can't see it" has to be a property of the storage layer and
-- not of the page that happens to render it. These assertions drive the same
-- policies the hosted project uses, against the storage shim in pg-bootstrap.
begin;
select plan(7);

insert into auth.users (id, email) values
  ('e0000000-0000-0000-0000-00000000000a','driver-a@example.com'),
  ('e0000000-0000-0000-0000-00000000000b','driver-b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('e0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('e0000000-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','driver');

-- The path parser is the whole boundary, so prove it before leaning on it.
select is(public.media_tenant('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/pickup/ref-1/photo-0.jpg'),
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
          'the tenant segment is read back off the object key');
select is(public.media_tenant('not-a-tenant/pickup/ref-1/photo-0.jpg'), null,
          'a key that is not shaped like ours yields no tenant, rather than erroring');
select is(public.media_tenant('photo-0.jpg'), null,
          'a bare filename yields no tenant');

insert into storage.objects (bucket_id, name) values
  ('run-media','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/pickup/ref-a/photo-0.jpg'),
  ('run-media','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/pickup/ref-b/photo-0.jpg');

set local role authenticated;
set local "request.jwt.claim.sub" = 'e0000000-0000-0000-0000-00000000000a';

select is((select count(*) from storage.objects)::int, 1,
          'a driver sees only their own tenant''s media');
select is((select count(*) from storage.objects
            where name like 'bbbbbbbb%')::int, 0,
          'another tenant''s photo is invisible, not merely unlinked');

-- Writing into someone else's folder must fail the with check, not land a row
-- that only the other tenant can see.
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('run-media','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/pickup/ref-c/photo-0.jpg')$$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'a driver cannot upload into another tenant''s folder');

-- Renaming is the sneaky version of the same move: take your own object and
-- write it out under their prefix. The using clause passes — it is their row —
-- so it is the with check that has to stop it.
select throws_ok(
  $$update storage.objects
       set name = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/pickup/ref-a/photo-0.jpg'
     where name like 'aaaaaaaa%'$$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'a driver cannot move their own object into another tenant''s folder');

select * from finish();
rollback;
