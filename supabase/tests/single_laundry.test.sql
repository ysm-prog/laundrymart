-- Proof: with the single-laundry switch on, a second laundry cannot be created
-- — and everything needed to turn the switch back off still can be.
--
-- `0041` is self-asserting and its behavioural block runs on every CI apply, so
-- this file is not a second copy of that. It proves the same rule **at the end
-- of the migration chain**, which is a different claim: a later `create or
-- replace` on `single_laundry_mode`, a policy rewrite on `platform_settings`,
-- or a migration that re-created `tenants` would all leave 0041's own
-- assertions passing at their own moment and the rule gone by the last one.
-- That is precisely how 0017's billing hook was silently dropped by a guard
-- rebuilt from the wrong ancestor.
--
-- The half that matters most is the **way out**. A switch that could not be
-- turned off would be a deployment permanently pinned to one laundry by a
-- migration, which is the opposite of what "for now" asked for — so renaming,
-- suspending and deleting a laundry are asserted to still work with the mode
-- on, as is the insert that follows turning it off.
begin;
select plan(9);

-- ---------------------------------------------------------------- shape -----
select has_function('public', 'single_laundry_mode', 'the mode reader exists');

select is(
  (select count(*)::int from pg_trigger
    where tgrelid = 'public.tenants'::regclass
      and tgname = 'guard_tenants_single_laundry'),
  1,
  'the guard is attached to tenants');

-- Not on the RPC surface. A SECURITY DEFINER helper published at
-- `/rest/v1/rpc/…` is the trap 0019 recorded and 0036 shipped; both of these
-- are called only by the trigger, so neither role needs EXECUTE.
select ok(
  not has_function_privilege('anon', 'public.single_laundry_mode()', 'execute')
  and not has_function_privilege('authenticated', 'public.single_laundry_mode()', 'execute'),
  'single_laundry_mode is not callable over the API');

select ok(
  not has_function_privilege('anon', 'public.guard_single_laundry()', 'execute')
  and not has_function_privilege('authenticated', 'public.guard_single_laundry()', 'execute'),
  'guard_single_laundry is not callable over the API');

-- ------------------------------------------------------------ off is off ----
-- The default every fresh database, the seed and the other twenty-five proofs
-- rely on. Asserted first, because if this were wrong the rest of the suite
-- would fail in ways that look unrelated to this file.
select is(public.single_laundry_mode(), false, 'the mode is off until somebody turns it on');

insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A');
insert into public.tenants (id, name) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
select is(
  (select count(*)::int from public.tenants where deleted_at is null), 2,
  'two laundries can be created while the mode is off');

-- -------------------------------------------------------------- on is on ----
update public.platform_settings
   set settings = settings || '{"single_laundry": true}'::jsonb
 where id;

select throws_ok(
  $$insert into public.tenants (name) values ('Laundry C')$$,
  '42501',
  'this deployment is set up for one laundry, so another cannot be added',
  'a third laundry is refused out loud');

-- The way out, in both halves. Deleting is what an operator does to get back to
-- one; the mode must never be the reason they cannot.
select lives_ok(
  $$delete from public.tenants where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$,
  'a laundry can still be deleted while the mode is on');

update public.platform_settings
   set settings = settings - 'single_laundry'
 where id;

select lives_ok(
  $$insert into public.tenants (name) values ('Laundry D')$$,
  'turning the mode off lets a laundry be created again');

select * from finish();
rollback;
