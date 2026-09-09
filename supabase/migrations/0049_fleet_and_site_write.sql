-- ============================================================================
-- 0049_fleet_and_site_write — the fleet and the sites are changed by the office.
--
-- **The sixth and last table family on the shape this schema has now replaced
-- five times** (0006→0017 on `invoices`, 0018→0033 on `laundry_prices`,
-- 0021→0036 on the six payable tables, 0002→0040 on `items`, 0002→0048 on the
-- customer record). `depots`, `vehicles`, `drivers` and `fuel_logs` are the rest
-- of 0002's `apply_tenant_policy` list, so each carried a single permissive
-- `for all … using is_member(tenant_id)` policy — and a permissive `for all`
-- policy's USING half grants the writes as well as SELECT.
--
-- 0048 named these four as a separate decision and they are: configuration
-- rather than a customer's record, and none of them holds a note that redirects
-- a van. What they hold instead is the fleet's own facts, and one of them is
-- sharper than anything 0048 closed:
--
--   `drivers.user_id` **is the driver-scoped RLS boundary**. `current_driver_id()`
--   resolves the caller's driver row by matching that column against
--   `auth.uid()`, and the `daily_routes` and `jobs` policies narrow a
--   driver-only member to `driver_id = current_driver_id(...)`. So a member who
--   can UPDATE `drivers` can point somebody else's driver row at their own
--   login and read that driver's runs, stops and paperwork. That is a
--   privilege escalation and not a disclosure, which is why it is the reason
--   this migration exists rather than an item in a list.
--
-- The rest is ordinary but real: a delivery round could rename the depot or set
-- it inactive — and every site picker in the app filters `status = 'active'`, so
-- one PATCH empties the customer, contract, driver, board, vehicle, inventory
-- and route-template forms at once (§24 records that state arriving by accident
-- on 2026-08-26 and what it looked like). It could take a vehicle
-- `out_of_service`, rewrite a registration, rewrite a driver's licence number,
-- and read and write the fleet's whole fuel spend.
--
-- **Nothing in the app loses an ability it could reach**, measured rather than
-- assumed. `src/` holds exactly seven writers of these four tables and every one
-- is already gated:
--
--   depots      createDepot, updateDepotStatus            admin.write
--   vehicles    createVehicle, updateVehicleStatus        fleet.write
--   drivers     createDriver, updateDriverStatus          fleet.write
--   drivers     linkDriverLogin                           admin.write
--   fuel_logs   logFuel                                   fleet.write
--
-- `admin.write` is `super_admin` alone and is a strict subset of `fleet.write`,
-- so the driver-login link keeps working under the fleet gate. That containment
-- is what `fleet-write-gate.test.ts` pins: if the two sets ever part company,
-- linking a login writes **zero rows in silence** and the driver is told for
-- ever that their login is not linked yet.
--
-- **Stated rather than implied: this does not narrow `drivers` to `admin.write`.**
-- `createDriver` accepts a `user_id` and is gated on `fleet.write`, so a
-- dispatcher can already link a login through the create form today; gating the
-- table on `admin.write` would break three roles' use of a working screen to
-- close a door the same screen leaves open. What moves is the round, the driver
-- and the plant floor, who hold neither capability and are the exposure.
--
-- **Three reads stay open, and each is decided by who actually reads it:**
--
--   `drivers`    SELECT open — **decisive**. `/run` and the dashboard's own card
--                read the caller's driver row to answer "which run is mine",
--                and `/jobs` embeds `drivers(full_name)` under `routes.read`.
--                A driver and a board hold no `fleet.read` at all, so narrowing
--                this tells a linked driver their login is not linked yet.
--   `depots`     SELECT open — the plant floor picks a depot on `/warehouse` and
--                `/inventory` under `warehouse.read`/`inventory.read`, and holds
--                no `admin.read`.
--   `vehicles`   SELECT open — the run sheet and the warehouse return count both
--                embed the registration, the second under `warehouse.read`.
--   `fuel_logs`  SELECT **narrowed** to `can_read_fleet()`. **Nothing in `src/`
--                reads this table at all** — the only mention anywhere is the
--                insert in `logFuel` — so narrowing it can break no screen, and
--                it closes a read that today hands every member of the laundry
--                the fleet's litres, odometer and cost off `/rest/v1/fuel_logs`.
--
-- Taking a read away from a round is the failure this project has shipped once
-- already (the driver with no `drivers` row, 2026-08-17): a login that works and
-- shows nothing reads as a broken app rather than as a refusal.
--
-- **The 0028 trap does not apply, and that is asserted rather than assumed**:
-- none of the four is in `archivable_tables()`, so there is no `archived_at`
-- clause to carry into the replacements. Assertion 8 checks the premise, because
-- if a later migration ever archives one of these, a policy written here would
-- silently un-hide it.
--
-- Adds no table, no column and no capability; changes no row.
-- ============================================================================

-- ---------------------------------------------------- 1. the three gates ---
-- Named against `roles.ts` rather than derived from one another, because these
-- are three different questions: who may look at the fleet, who may change it,
-- and who may add or retire a site. The auditor reads and does not write, which
-- is the whole reason read and write are separate lists.
create or replace function public.can_read_fleet(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array['super_admin','operations_manager','dispatcher',
                                  'branch_manager','regional_manager','auditor']);
$$;

comment on function public.can_read_fleet(uuid) is
  'Who may look at the fleet — `fleet.read` in roles.ts. Used only for
   `fuel_logs`: the vehicles, the drivers and the depots stay readable to every
   member, because a run sheet names the van and a driver''s own screen has to
   find the driver row that says which run is theirs.';

create or replace function public.can_write_fleet(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array['super_admin','operations_manager','dispatcher',
                                  'branch_manager','regional_manager']);
$$;

comment on function public.can_write_fleet(uuid) is
  'Who may change the fleet — `fleet.write` in roles.ts, covering vehicles,
   drivers and fuel logs. A driver, a board, the counter, the plant floor,
   finance and the auditor are all outside it. Before 0049 every member could
   re-point `drivers.user_id` at their own login, which is what
   `current_driver_id()` matches on — so it was a way into another driver''s
   runs, not merely a way to edit a phone number.';

-- A site is added and retired by whoever administers the laundry, which is what
-- `/admin/depots` has always required. Deliberately narrower than the fleet gate
-- and deliberately its own helper: retiring the only depot empties every site
-- picker in the app at once, and that is an administrator's decision.
create or replace function public.can_write_depots(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array['super_admin']);
$$;

comment on function public.can_write_depots(uuid) is
  'Who may add or retire a site — `admin.write` in roles.ts, which is
   `super_admin` alone (plus a platform admin, through has_role). The same gate
   `createDepot` and `updateDepotStatus` have always carried.';

-- Postgres grants EXECUTE on a new function to PUBLIC as a *built-in* default,
-- which `alter default privileges` (0011, 0029) is applied on top of rather than
-- instead of — so a helper arrives callable by `anon` at /rest/v1/rpc/… unless
-- it is revoked by name. The trap 0040's sixth assertion caught.
-- `authenticated` deliberately keeps EXECUTE: every policy below calls these as
-- the signed-in caller, and each is internally scoped to `auth.uid()` through
-- `has_role`, so it can only ever answer a question about the person asking.
-- Copying a *trigger* function's revoke line here — which names `authenticated`
-- (0019, 0036, 0047) — would make every fleet screen in the app error.
revoke all on function public.can_read_fleet(uuid)   from public, anon;
revoke all on function public.can_write_fleet(uuid)  from public, anon;
revoke all on function public.can_write_depots(uuid) from public, anon;
grant execute on function public.can_read_fleet(uuid)   to authenticated, service_role;
grant execute on function public.can_write_fleet(uuid)  to authenticated, service_role;
grant execute on function public.can_write_depots(uuid) to authenticated, service_role;

-- ----------------------------------------------------------- 2. the site ---
-- Dropped rather than supplemented: leaving 0002's `for all` beside a narrower
-- write policy would leave it as a second door onto every verb, which is the
-- 0033 trap and the reason all five predecessors replaced rather than added.
drop policy if exists depots_member on public.depots;

create policy depots_read on public.depots
  for select to authenticated
  using ((select public.is_member(tenant_id)));

create policy depots_insert on public.depots
  for insert to authenticated
  with check ((select public.can_write_depots(tenant_id)));

create policy depots_update on public.depots
  for update to authenticated
  using ((select public.can_write_depots(tenant_id)))
  with check ((select public.can_write_depots(tenant_id)));

create policy depots_delete on public.depots
  for delete to authenticated
  using ((select public.can_write_depots(tenant_id)));

-- -------------------------------------------------------- 3. the vehicle ---
drop policy if exists vehicles_member on public.vehicles;

create policy vehicles_read on public.vehicles
  for select to authenticated
  using ((select public.is_member(tenant_id)));

create policy vehicles_insert on public.vehicles
  for insert to authenticated
  with check ((select public.can_write_fleet(tenant_id)));

create policy vehicles_update on public.vehicles
  for update to authenticated
  using ((select public.can_write_fleet(tenant_id)))
  with check ((select public.can_write_fleet(tenant_id)));

create policy vehicles_delete on public.vehicles
  for delete to authenticated
  using ((select public.can_write_fleet(tenant_id)));

-- --------------------------------------------------------- 4. the driver ---
-- The read stays open on purpose and is the assertion this file checks hardest:
-- `/run` answers "is this login linked to a driver?" by reading this table as
-- the driver, and a driver holds no `fleet.read`.
drop policy if exists drivers_member on public.drivers;

create policy drivers_read on public.drivers
  for select to authenticated
  using ((select public.is_member(tenant_id)));

create policy drivers_insert on public.drivers
  for insert to authenticated
  with check ((select public.can_write_fleet(tenant_id)));

create policy drivers_update on public.drivers
  for update to authenticated
  using ((select public.can_write_fleet(tenant_id)))
  with check ((select public.can_write_fleet(tenant_id)));

create policy drivers_delete on public.drivers
  for delete to authenticated
  using ((select public.can_write_fleet(tenant_id)));

-- ------------------------------------------------------- 5. the fuel log ---
-- The one read that narrows, and the only one that can: this table has no
-- reader in `src/` at all, so nothing on any screen changes and the fleet's
-- fuel spend stops being every member's to read.
drop policy if exists fuel_logs_member on public.fuel_logs;

create policy fuel_logs_read on public.fuel_logs
  for select to authenticated
  using ((select public.can_read_fleet(tenant_id)));

create policy fuel_logs_insert on public.fuel_logs
  for insert to authenticated
  with check ((select public.can_write_fleet(tenant_id)));

create policy fuel_logs_update on public.fuel_logs
  for update to authenticated
  using ((select public.can_write_fleet(tenant_id)))
  with check ((select public.can_write_fleet(tenant_id)));

create policy fuel_logs_delete on public.fuel_logs
  for delete to authenticated
  using ((select public.can_write_fleet(tenant_id)));

-- ====================================================== assert the outcome ==
-- Self-asserting, so a partial apply fails rather than half-landing.
do $$
declare
  v int;
  t text;
  v_missing text[] := '{}';
begin
  foreach t in array array['depots','vehicles','drivers','fuel_logs'] loop
    -- 1. The permissive `for all` is gone — not merely outvoted by a narrower
    --    policy beside it, which would leave every verb reachable through it.
    select count(*) into v from pg_policies
     where schemaname = 'public' and tablename = t and cmd = 'ALL';
    if v <> 0 then
      v_missing := v_missing || format('a permissive for-all policy is still on %s', t);
    end if;

    -- 2. Four policies, one verb each.
    select count(*) into v from pg_policies
     where schemaname = 'public' and tablename = t;
    if v <> 4 then
      v_missing := v_missing || format('expected 4 policies on %s, found %s', t, v);
    end if;

    select count(*) into v from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t and c.relrowsecurity;
    if v <> 1 then v_missing := v_missing || format('RLS is off on %s', t); end if;

    -- 3. 0029's posture: `anon` holds nothing on any of them.
    select count(*) into v from information_schema.role_table_grants
     where table_schema = 'public' and table_name = t and grantee = 'anon';
    if v <> 0 then v_missing := v_missing || format('anon holds %s grants on %s', v, t); end if;
  end loop;

  -- 4. Every write verb on the fleet names the fleet gate. Asked of the policy
  --    text rather than the count, so a policy that merely exists under the
  --    right name but checks something else is caught.
  foreach t in array array['vehicles','drivers','fuel_logs'] loop
    select count(*) into v from pg_policies
     where schemaname = 'public' and tablename = t and cmd in ('INSERT','UPDATE','DELETE')
       and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%can_write_fleet%';
    if v <> 3 then
      v_missing := v_missing || format(
        'only %s of 3 write policies on %s are gated on can_write_fleet', v, t);
    end if;
  end loop;

  -- 5. …and the site's three name the administrator's gate instead, which is
  --    narrower. A depot write slipping onto `can_write_fleet` would hand a
  --    dispatcher the switch that empties every site picker in the app.
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'depots' and cmd in ('INSERT','UPDATE','DELETE')
     and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%can_write_depots%';
  if v <> 3 then
    v_missing := v_missing || format(
      'only %s of 3 write policies on depots are gated on can_write_depots', v);
  end if;

  -- 6. The three reads a round, a driver and the plant floor depend on are
  --    still open to every member. Asserted by *name* rather than by counting
  --    policies, because the failure it guards is silent: a driver whose own
  --    row is invisible is told their login is not linked, on a screen that
  --    offers no way to find out otherwise.
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename in ('depots','vehicles','drivers')
     and cmd = 'SELECT' and coalesce(qual, '') like '%is_member%';
  if v <> 3 then
    v_missing := v_missing || format('expected the 3 open fleet reads, found %s', v);
  end if;

  -- 7. And the fuel read really did narrow, or every member still reads the
  --    laundry's fuel spend.
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'fuel_logs'
     and cmd = 'SELECT' and coalesce(qual, '') like '%can_read_fleet%';
  if v <> 1 then v_missing := v_missing || 'the fuel_logs read is not gated'::text; end if;

  -- 8. **The premise behind having no archive clause.** None of the four is in
  --    `archivable_tables()`, so 0017 wrapped nothing here and there is nothing
  --    for these policies to carry. If that ever changes, the policies above
  --    would un-hide an archived row — so the premise is checked rather than
  --    assumed, which is the 0028 trap asked from the other side.
  select count(*) into v from unnest(public.archivable_tables()) a
   where a in ('depots','vehicles','drivers','fuel_logs');
  if v <> 0 then
    v_missing := v_missing || format(
      '%s of these tables are archivable, so these policies drop the archive clause', v);
  end if;

  -- 9. No helper is on the RPC surface for a signed-out caller.
  if has_function_privilege('anon', 'public.can_read_fleet(uuid)', 'execute')
     or has_function_privilege('anon', 'public.can_write_fleet(uuid)', 'execute')
     or has_function_privilege('anon', 'public.can_write_depots(uuid)', 'execute') then
    v_missing := v_missing || 'a fleet helper is callable by anon'::text;
  end if;

  -- 10. …and all three *are* callable by a signed-in one, or every policy above
  --     evaluates to an error and every fleet and site screen stops working.
  --     This is the regression that would really happen: copying a trigger
  --     function's revoke line, which correctly names `authenticated`.
  if not has_function_privilege('authenticated', 'public.can_read_fleet(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.can_write_fleet(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.can_write_depots(uuid)', 'execute') then
    v_missing := v_missing || 'a fleet helper is not callable by authenticated'::text;
  end if;

  -- 11. Stated as an outcome rather than by re-reading the arrays, so a later
  --     edit to either role list fails here rather than shipping.
  if public.can_write_fleet(null) or public.can_write_depots(null)
     or public.can_read_fleet(null) then
    v_missing := v_missing || 'a fleet helper answers true with no tenant'::text;
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception '0049 did not apply cleanly: %', array_to_string(v_missing, '; ');
  end if;
end $$;
