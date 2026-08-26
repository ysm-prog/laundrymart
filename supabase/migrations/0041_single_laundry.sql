-- ============================================================================
-- 0041_single_laundry — this deployment runs one laundry, and the database
-- says so rather than the screen.
--
-- `Adelaide Towel Service` is the only tenant on `laundrymart-syd` as of
-- 2026-08-26: the demo laundry was deleted, its twelve role-profile logins
-- moved across, and the real laundry's 1,154 archived records brought back.
-- What that leaves is an "Add a laundry" form on `/platform` whose only
-- possible effect is to undo the decision — and `tenants` carries 0019's
-- `tenants_platform` policy, so a platform admin can POST one straight to
-- `/rest/v1/tenants` without going near the screen.
--
-- **The screen is not the boundary.** That sentence is written four times in
-- this repo (0017, 0033, 0036, 0040) and each time it was learned by finding a
-- rule that only the UI enforced. This is a smaller thing than a role gate —
-- creating a laundry is a platform admin's job and they are allowed to do it —
-- but "only one for now" is a statement about the deployment, and a statement
-- the deployment cannot keep is not a statement.
--
-- **A switch, not a deletion, because the ask was "for now".** The mode lives
-- in `platform_settings.settings` (0019's one-row jsonb bag, the layer above
-- `tenants.settings`), so turning it off is one press on Platform › Settings
-- and needs no deploy and no migration. Nothing here removes multi-tenancy:
-- `tenant_id`, every RLS policy and every proof of isolation are untouched, and
-- with the switch off the database behaves exactly as it did yesterday.
--
-- **Absent means off, and that is load-bearing.** `supabase/seed.sql` creates a
-- laundry and twenty-five pgTAP proofs create two, so a mode that defaulted on
-- would fail the whole suite and the seed with it. A fresh database has no
-- `single_laundry` key, reads false, and is unaffected.
--
-- Adds no table, no column, no policy and no capability; drops nothing, and
-- changes no row.
-- ============================================================================

-- ------------------------------------------------------------- the reader ---
-- SECURITY DEFINER because the guard below fires as whoever is inserting, and
-- `platform_settings` is readable only to a platform admin (0019). A trigger
-- that answered "false" simply because the caller cannot see the setting would
-- be a rule that switches itself off for everybody it is meant to stop.
--
-- `coalesce` twice on purpose: no row at all, and a row with no such key, both
-- mean off. The bag is Zod-validated at the read site (0013's decision, kept by
-- 0019), so the database must not assume the key is present or well typed —
-- `->>` on a non-boolean yields text that `::boolean` would throw on, hence the
-- explicit `= 'true'` comparison rather than a cast.
create or replace function public.single_laundry_mode()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select coalesce(s.settings ->> 'single_laundry', 'false') = 'true'
       from public.platform_settings s where s.id),
    false);
$$;

comment on function public.single_laundry_mode() is
  'Whether this deployment is pinned to one laundry. Reads '
  'platform_settings.settings->>single_laundry; absent means off, so a fresh '
  'database, the seed and the pgTAP proofs are unaffected.';

-- Postgres grants EXECUTE on a new function to PUBLIC as a *built-in* default,
-- which `alter default privileges` (0011, 0029) is applied on top of rather
-- than instead of — so a helper arrives callable by `anon` at
-- `/rest/v1/rpc/single_laundry_mode` unless it is revoked by name. 0036 shipped
-- a definer trigger function without this and the live advisors caught it the
-- same hour; 0040's own assertion caught it before it left the branch.
--
-- **`authenticated` is revoked too, unlike `can_write_items`.** Nothing in
-- `src/` calls this: the two screens that care are platform-admin-only and read
-- `platform_settings` directly through RLS. A definer function nobody needs on
-- the RPC surface should not be on it.
revoke all on function public.single_laundry_mode() from public, anon, authenticated;
grant execute on function public.single_laundry_mode() to service_role;

-- -------------------------------------------------------------- the guard ---
-- A trigger rather than a restrictive policy, for the reason 0036 and 0040
-- both give: a restrictive policy that excludes a caller writes **zero rows
-- with no error**, and this project has shipped that silence twice (0025 for
-- the driver, 0031 for the board). A person who presses "Add laundry" and is
-- told nothing has been given no information at all. 42501 reaches the flash
-- toast as a sentence.
--
-- It fires on INSERT only. Renaming, suspending and — critically — *deleting* a
-- laundry stay exactly as writable as they were, so the switch can never be the
-- reason somebody cannot undo it.
create or replace function public.guard_single_laundry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.single_laundry_mode()
     and exists (select 1 from public.tenants where deleted_at is null) then
    raise exception
      'this deployment is set up for one laundry, so another cannot be added'
      using errcode = '42501',
            hint = 'Turn off "Run one laundry only" on Platform > Settings first.';
  end if;
  return new;
end; $$;

-- Same revoke, and here it is the case 0019 recorded rather than an analogue of
-- it: a SECURITY DEFINER **trigger** function is published at `/rest/v1/rpc/…`
-- by Supabase's own default grants, where it can only ever error — which is
-- exactly why it should not be reachable.
revoke all on function public.guard_single_laundry() from public, anon, authenticated;

drop trigger if exists guard_tenants_single_laundry on public.tenants;
create trigger guard_tenants_single_laundry
  before insert on public.tenants
  for each row execute procedure public.guard_single_laundry();

-- ====================================================== assert the outcome ==
do $$
declare
  n int;
  was jsonb;
  probe uuid;
  refused boolean := false;
begin
  -- 1. The reader and the guard exist, and the guard is attached to `tenants`
  --    on INSERT and nothing else. Checked by catalogue rather than assumed:
  --    the 2026-08-26 conformance sweep records a probe that looked for a
  --    trigger under its *function's* name and wrongly reported it missing.
  select count(*) into n from pg_trigger tg
   where tg.tgrelid = 'public.tenants'::regclass
     and tg.tgname = 'guard_tenants_single_laundry'
     and (tg.tgtype & 4) > 0      -- INSERT
     and (tg.tgtype & 8) = 0      -- not DELETE
     and (tg.tgtype & 16) = 0;    -- not UPDATE
  if n <> 1 then
    raise exception '0041: the single-laundry guard is not attached to tenants on INSERT only';
  end if;

  -- 2. 0029's posture, which every migration since has had to keep — and the
  --    trigger-function half of it, which 0036 got wrong.
  if has_function_privilege('anon', 'public.single_laundry_mode()', 'execute')
     or has_function_privilege('authenticated', 'public.single_laundry_mode()', 'execute') then
    raise exception '0041: single_laundry_mode is on the RPC surface';
  end if;
  if has_function_privilege('anon', 'public.guard_single_laundry()', 'execute')
     or has_function_privilege('authenticated', 'public.guard_single_laundry()', 'execute') then
    raise exception '0041: guard_single_laundry is on the RPC surface';
  end if;

  -- 3. Off by default. The seed and twenty-five proofs create laundries, so a
  --    mode that read "on" from an absent key would take the whole suite down.
  if public.single_laundry_mode() then
    raise exception '0041: the mode reads on before anybody has turned it on';
  end if;

  -- ---------------------------------------------------------- behaviourally --
  -- Proved against real inserts rather than reasoned about, the way 0040's
  -- open-draft guard was. Everything below is undone before this block ends.
  select settings into was from public.platform_settings where id;

  -- The first laundry is always allowed: the rule is "one", not "none", and a
  -- deployment has to be able to create the one it runs.
  update public.platform_settings set settings = coalesce(was, '{}'::jsonb) || '{"single_laundry": true}'::jsonb where id;

  select count(*) into n from public.tenants where deleted_at is null;
  if n = 0 then
    insert into public.tenants (name) values ('0041 probe — first') returning id into probe;
  else
    probe := null;
  end if;

  begin
    insert into public.tenants (name) values ('0041 probe — second');
    -- Reached only if the guard let it through, which is the defect.
    raise exception '0041: a second laundry was created while the mode was on';
  exception
    when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0041: the guard did not refuse a second laundry';
  end if;

  -- 4. And with the mode off it lets one through, so the assertion above is
  --    testing the switch rather than something that refuses unconditionally.
  update public.platform_settings set settings = coalesce(was, '{}'::jsonb) - 'single_laundry' where id;
  insert into public.tenants (name) values ('0041 probe — allowed when off');
  delete from public.tenants where name like '0041 probe%';
  if probe is not null then
    delete from public.tenants where id = probe;
  end if;

  -- 5. Nothing survives. A probe that cleans up after itself is not optional:
  --    a stray fixture row re-scoped a later assertion in `main_flow_scope` on
  --    2026-08-24 and read as a broken policy.
  select count(*) into n from public.tenants where name like '0041 probe%';
  if n <> 0 then
    raise exception '0041: % probe laundry/laundries survived', n;
  end if;

  -- 6. The bag is exactly as it was found — including any switch a later
  --    release adds, which is why this restores the whole value rather than
  --    deleting one key.
  update public.platform_settings set settings = coalesce(was, '{}'::jsonb) where id;
  if (select settings from public.platform_settings where id) is distinct from was then
    raise exception '0041: the platform settings bag was not put back';
  end if;
end $$;
