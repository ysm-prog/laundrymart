-- Proof for 0030: the directory answers about one laundry, to its own people,
-- and to nobody else.
--
-- The function reads `auth.users` with definer rights, which is the whole
-- reason it exists — no ordinary session may — and therefore the whole reason
-- it is worth proving rather than trusting. Three claims:
--   * it is scoped by argument, so a member of one laundry cannot read another's
--     people by passing its id;
--   * `anon` cannot execute it at all, asserted on the privilege rather than on
--     the SQLSTATE (0011's trap: the membership check raises 42501 too);
--   * it returns each membership **once**, which the screens got wrong before —
--     `memberships` under RLS hands a platform admin every laundry's rows.
begin;
select plan(14);

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111','owner@a.example.com', '{"full_name":"Ann Owner"}'),
  ('22222222-2222-2222-2222-222222222222','driver@a.example.com', null),
  ('33333333-3333-3333-3333-333333333333','nameless@a.example.com', '{"full_name":"   "}'),
  ('44444444-4444-4444-4444-444444444444','owner@b.example.com', '{"name":"Bob Other"}'),
  ('99999999-9999-9999-9999-999999999999','platform@example.com', null);

insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');

insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','driver'),
  ('33333333-3333-3333-3333-333333333333','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dispatcher'),
  ('44444444-4444-4444-4444-444444444444','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

-- The platform admin holds a membership in **both**, which is the arrangement
-- 0019 describes and the one that produced duplicated picker rows.
insert into public.platform_admins (user_id, note)
  values ('99999999-9999-9999-9999-999999999999','the platform admin');
insert into public.memberships (user_id, tenant_id, role) values
  ('99999999-9999-9999-9999-999999999999','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('99999999-9999-9999-9999-999999999999','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

-- A driver record carrying the one name this laundry has already typed in.
insert into public.depots (id, tenant_id, code, name)
  values ('d0000000-0000-0000-0000-00000000000a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','DEP1','Depot 1');
insert into public.drivers (tenant_id, depot_id, user_id, full_name)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-0000-0000-0000-00000000000a',
          '22222222-2222-2222-2222-222222222222','Dee Driver');

-- ------------------------------------------------------------- as a member ---
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is((select count(*) from public.tenant_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'))::int,
          4, 'every member of this laundry is returned, and each of them once');

select is((select full_name from public.tenant_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
            where user_id = '11111111-1111-1111-1111-111111111111'),
          'Ann Owner', 'the name a person was invited under comes back');

select is((select driver_name from public.tenant_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
            where user_id = '22222222-2222-2222-2222-222222222222'),
          'Dee Driver', 'a linked driver record supplies the name nobody typed twice');

select is((select full_name from public.tenant_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
            where user_id = '33333333-3333-3333-3333-333333333333'),
          null, 'whitespace metadata is no name, not a blank one');

select is((select email from public.tenant_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
            where user_id = '33333333-3333-3333-3333-333333333333'),
          'nameless@a.example.com', 'the address is there to fall back to');

select ok((select is_platform_admin from public.tenant_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
            where user_id = '99999999-9999-9999-9999-999999999999'),
          'a platform administrator is flagged, so the screens can leave them out');

select ok(not (select is_platform_admin from public.tenant_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
                where user_id = '11111111-1111-1111-1111-111111111111'),
          'an ordinary owner is not');

-- The isolation claim. `is_member` is false for Laundry B, so this raises
-- rather than quietly returning nobody.
select throws_ok(
  $$ select * from public.tenant_members('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  '42501', 'that business is not yours',
  'a member of one laundry cannot read another laundry''s people');

-- --------------------------------------------------- as a platform admin ---
set local "request.jwt.claim.sub" = '99999999-9999-9999-9999-999999999999';

select is((select count(*) from public.tenant_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'))::int,
          4, 'a platform admin reads one laundry at a time — their two memberships are not doubled up');
select is((select count(*) from public.tenant_members('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'))::int,
          2, 'and they can read the other one, which is what the role is for');
select is((select full_name from public.tenant_members('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
            where user_id = '44444444-4444-4444-4444-444444444444'),
          'Bob Other', 'a login named under `name` rather than `full_name` still has a name');

-- ------------------------------------------------------- as nobody at all ---
set local "request.jwt.claim.sub" = '77777777-7777-7777-7777-777777777777';
select throws_ok(
  $$ select * from public.tenant_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', 'that business is not yours',
  'a signed-in stranger is refused');

-- -------------------------------------------------------------- as `anon` ---
-- Asserted on the privilege, not on the error: the membership check above
-- raises 42501, which is also "permission denied", so a probe reading only the
-- SQLSTATE would pass with the grant wide open (0011).
reset role;
select ok(not has_function_privilege('anon', 'public.tenant_members(uuid)', 'EXECUTE'),
          'anon cannot execute the directory');
select ok(has_function_privilege('authenticated', 'public.tenant_members(uuid)', 'EXECUTE'),
          'a signed-in session can');

select * from finish();
rollback;
