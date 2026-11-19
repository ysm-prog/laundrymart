-- ============================================================================
-- 0064_board_and_people_write — a round cannot take another round, and the
-- people list is changed by the Owner.
--
-- Found on 2026-11-19 while proving the handover accounts as real sessions on
-- the live project. Two tables, two holes, one shape between them: the
-- *database* granted writes the app had always reserved.
--
-- 1. `boards` carried 0031's `apply_tenant_policy` — one permissive
--    `for all … using is_member(tenant_id)` — **the seventh table family on the
--    shape this schema has now replaced six times** (0017, 0033, 0036, 0040,
--    0048, 0049). And `boards.user_id` is the board-scoped RLS boundary exactly
--    as `drivers.user_id` was in 0049: `current_board_id()` resolves a board's
--    session by matching that column against `auth.uid()`, and the
--    `daily_routes`/`jobs`/`laundry_orders` policies narrow a board-only member
--    to that id. Probed as Board 2's own login, in a transaction that ended by
--    raising: it cleared its own link, pointed **Board 1** at itself (1 row),
--    then resolved as Board 1 and read all **15** of Board 1's jobs — and it
--    retired Board 4 (1 row). A delivery round could take over another round.
--
-- 2. `memberships_admin` (0001) admits `super_admin` **and
--    `operations_manager`** to every verb, while the app gives `admin.write` —
--    the People screen, every membership writer — to `super_admin` alone. So an
--    Office manager could `update memberships set role = 'super_admin'` on their
--    own row and become the Owner. Probed as both real Office-manager logins:
--    1 row each. It matters more today than it did yesterday, because one of
--    them is a **shared** login several people will hold.
--
-- What moves, measured rather than assumed against `src/`:
--
--   boards       createBoard, linkBoardLogin, updateBoardStatus — all three
--                gated on `fleet.write`, which is `can_write_fleet()` (0049).
--                Nothing else in `src/` writes the table.
--   memberships  updateMembership, inviteMember, createMemberWithPassword,
--                removeMember — all gated on `admin.write` = `super_admin`.
--                `lib/auth/context.ts` only reads its own row.
--
-- So **no screen loses an ability**: every writer was already gated on the
-- capability the policy now names. The Office manager keeps *reading*
-- memberships (the old policy's SELECT half), so nothing that reads the list
-- changes either.
--
-- The board read narrows too, and only for a board: a board-only member reads
-- its own `boards` row and no other. The client's handover rule is that a board
-- sees nothing of another board's, and `boards` carries `user_id` and the
-- default vehicle. Every board screen reads its own row only (`boardForUser`,
-- `assertCanWorkBoard`, `assertCanDeliver`), so nothing a board opens changes.
-- Everybody else — the office, a driver, the plant — still reads every board.
--
-- Neither table is in `archivable_tables()`, so the 0028 trap does not apply —
-- asserted rather than assumed. `is_board_only()` and `current_board_id()` are
-- SECURITY DEFINER, so the new read policy cannot recurse into itself.
-- ============================================================================

-- ------------------------------------------------------------------ boards --
drop policy if exists boards_member on public.boards;
drop policy if exists boards_read   on public.boards;
drop policy if exists boards_insert on public.boards;
drop policy if exists boards_update on public.boards;
drop policy if exists boards_delete on public.boards;

create policy boards_read on public.boards
  for select to authenticated
  using (
    (select public.is_member(tenant_id))
    and (not (select public.is_board_only(tenant_id)) or user_id = (select auth.uid()))
  );

create policy boards_insert on public.boards
  for insert to authenticated
  with check ((select public.can_write_fleet(tenant_id)));

create policy boards_update on public.boards
  for update to authenticated
  using ((select public.can_write_fleet(tenant_id)))
  with check ((select public.can_write_fleet(tenant_id)));

create policy boards_delete on public.boards
  for delete to authenticated
  using ((select public.can_write_fleet(tenant_id)));

-- ------------------------------------------------------------- memberships --
-- `memberships_self` (read your own row) is left exactly as it is.
drop policy if exists memberships_admin  on public.memberships;
drop policy if exists memberships_read   on public.memberships;
drop policy if exists memberships_insert on public.memberships;
drop policy if exists memberships_update on public.memberships;
drop policy if exists memberships_delete on public.memberships;

create policy memberships_read on public.memberships
  for select to authenticated
  using ((select public.has_role(tenant_id, array['super_admin','operations_manager'])));

create policy memberships_insert on public.memberships
  for insert to authenticated
  with check ((select public.has_role(tenant_id, array['super_admin'])));

create policy memberships_update on public.memberships
  for update to authenticated
  using ((select public.has_role(tenant_id, array['super_admin'])))
  with check ((select public.has_role(tenant_id, array['super_admin'])));

create policy memberships_delete on public.memberships
  for delete to authenticated
  using ((select public.has_role(tenant_id, array['super_admin'])));

-- --------------------------------------------------------- self-assertion --
do $$
declare
  v_missing text[] := '{}';
  v int;
  t text;
begin
  foreach t in array array['boards','memberships'] loop
    -- 1. no permissive `for all` left standing
    select count(*) into v from pg_policies
     where schemaname = 'public' and tablename = t and cmd = 'ALL';
    if v <> 0 then v_missing := v_missing || format('%s still carries a for-all policy', t)::text; end if;

    -- 2. one policy per write verb
    select count(*) into v from pg_policies
     where schemaname = 'public' and tablename = t and cmd in ('INSERT','UPDATE','DELETE');
    if v <> 3 then v_missing := v_missing || format('%s has %s write policies, expected 3', t, v)::text; end if;

    -- 3. RLS on, and anon holds nothing (0029's posture)
    if not (select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass) then
      v_missing := v_missing || format('RLS is off on %s', t)::text;
    end if;
    select count(*) into v from information_schema.role_table_grants
     where table_schema = 'public' and table_name = t and grantee = 'anon';
    if v <> 0 then v_missing := v_missing || format('anon holds %s grants on %s', v, t)::text; end if;

    -- 4. the 0028 premise: neither table is archivable
    if t = any (public.archivable_tables()) then
      v_missing := v_missing || format('%s is archivable, so its policies need the archive clause', t)::text;
    end if;
  end loop;

  -- 5. every board write is on the fleet gate
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'boards' and cmd in ('INSERT','UPDATE','DELETE')
     and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%can_write_fleet%';
  if v <> 3 then v_missing := v_missing || format('only %s of 3 board write policies use can_write_fleet', v)::text; end if;

  -- 6. no membership write names the Office manager
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'memberships' and cmd in ('INSERT','UPDATE','DELETE')
     and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%operations_manager%';
  if v <> 0 then v_missing := v_missing || format('%s membership write policies still admit operations_manager', v)::text; end if;

  -- 7. the board read still narrows a board (and only a board)
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'boards' and cmd = 'SELECT'
     and qual like '%is_board_only%' and qual like '%is_member%';
  if v <> 1 then v_missing := v_missing || 'boards_read does not narrow a board to its own row'::text; end if;

  -- 8. the self-read survives, or every session resolution in the app breaks
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'memberships' and policyname = 'memberships_self' and cmd = 'SELECT';
  if v <> 1 then v_missing := v_missing || 'memberships_self is gone'::text; end if;

  if array_length(v_missing, 1) > 0 then
    raise exception '0064 did not apply cleanly: %', array_to_string(v_missing, '; ');
  end if;
end $$;
