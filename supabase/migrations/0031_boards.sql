-- ============================================================================
-- 0031_boards — the operational unit is the round, not the person.
--
-- Until now a job was given to a **driver**. The business runs four vans, and
-- the person on a van changes: somebody resigns, somebody is sick, somebody
-- covers a route for a fortnight. Re-pointing every open job at a different
-- employee each time that happens is administration the work does not need, and
-- it loses the thing the office actually cares about — *which round is this on?*
--
-- So the assignment target becomes a **Board**: a standing round with its own
-- login. Whoever is driving Board 1 today signs in as Board 1 and does Board 1's
-- work.
--
--   before   Job ──► Driver ──► Date
--   after    Job ──► Board  ──► Date        (and the run records who drove it)
--
-- **Drivers are kept, and that is a decision rather than an oversight.** A board
-- is a round; a driver is a person. When a delivery goes astray the business has
-- to be able to say who was holding it, and collapsing the two loses exactly
-- that. `daily_routes.operated_by_driver_id` is where the answer lives now — one
-- field stamped when the load is confirmed, instead of a reassignment sweep.
--
-- **The half of this that is not labels is RLS.** `current_driver_id()` is what
-- scopes a driver's session to their own runs, and four policy families read it.
-- A board login with no board equivalent would sign in successfully and see an
-- empty application — which reads as a broken app rather than as a missing link,
-- and is a failure this project has already shipped once (2026-08-17, the driver
-- with no `drivers` row). `current_board_id()` and the three rewritten policies
-- below are the substance of this migration.
--
-- **Nothing is dropped.** `assigned_driver_id` keeps every historical job's
-- driver and keeps reading correctly; four check constraints are replaced with
-- versions that accept either assignee, so no existing row is invalidated. New
-- assignments must name a board, and that is enforced by the guard — which only
-- fires when an assignment actually changes, so history is never re-judged.
-- ============================================================================

-- ------------------------------------------------------------- the boards ---
-- Not a rename of `drivers`, and not a `depots` child: a board is a round that
-- belongs to a laundry, may start from a depot, and holds a login.
create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,

  -- 'BOARD1'. Short, typed, and what the run code is built from.
  code text not null,
  -- 'Board 1'. What every screen shows.
  name text not null,

  -- The board's own login. Mirrors `drivers.user_id` deliberately: the same
  -- shape means the People screen's existing unlinked-member picker works for a
  -- board with no change to its logic, and `current_board_id()` below is the
  -- same one-line lookup `current_driver_id()` already is.
  user_id uuid references auth.users(id) on delete set null,

  -- The van this round usually takes. A default, not a booking — the run still
  -- carries the vehicle actually used.
  default_vehicle_id uuid references public.vehicles(id) on delete set null,

  notes text,
  status text not null default 'active' check (status in ('active','inactive','archived')),

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);

create unique index if not exists uq_boards_code
  on public.boards(tenant_id, lower(code)) where deleted_at is null;
create index if not exists idx_boards_user on public.boards(user_id);
create index if not exists idx_boards_depot on public.boards(depot_id);

-- RLS, tenant index and the updated_at trigger in one call, so a new table
-- cannot ship without a policy.
--
-- `apply_tenant_policy` and **not** `apply_archive_policy`: a board is
-- configuration, like a depot, a vehicle or a driver. An operator who hides last
-- year's customers still needs an app that knows which rounds they run. That is
-- the boundary 0017 states, applied.
select public.apply_tenant_policy('boards');

comment on table public.boards is
  'A standing delivery round with its own login. The assignment target: a job is '
  'given to a Board and a date, and whoever operates that Board that day signs in '
  'as it. Drivers remain the record of which person did the work.';

-- ------------------------------------------------------- the board's login --
-- The board a signed-in session *is*, used by the resource-scoped policies
-- below. Definer + pinned search_path, the shape every helper in this schema
-- uses; the EXECUTE grant is closed to `anon` at the foot of this file.
create or replace function public.current_board_id(t uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select b.id from public.boards b
  where b.tenant_id = t
    and b.user_id = (select auth.uid())
    and b.deleted_at is null
  limit 1;
$$;

-- A member whose role in this tenant is `board`, and who is not a platform
-- admin. The `and not` mirrors what 0019 had to add to `is_driver_only` for the
-- same reason: a platform admin must never be narrowed to one round's work, even
-- if they happen to hold a board membership somewhere.
create or replace function public.is_board_only(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid()) and m.role = 'board'
  ) and not public.is_platform_admin();
$$;

comment on function public.current_board_id(uuid) is
  'The board a signed-in session operates, if any. The board counterpart of '
  'current_driver_id(); without it a board login sees an empty application.';

-- ------------------------------------------------------- the twelfth role ---
-- `roles.ts` carries the app's copy of this list, and both membership actions
-- validate against it. Widened here in the same migration, because a role the
-- app offers and the column refuses is an invitation that always fails.
alter table public.memberships
  drop constraint memberships_role_check;
alter table public.memberships
  add constraint memberships_role_check check (role in (
    'super_admin','operations_manager','dispatcher','driver','finance',
    'warehouse_operator','customer_service','sales','branch_manager',
    'regional_manager','auditor','board'
  ));

-- --------------------------------------------------------- the assignment ---
alter table public.laundry_orders
  add column if not exists assigned_board_id uuid
    references public.boards(id) on delete restrict;

alter table public.daily_routes
  -- The round this run belongs to. What a board login is scoped by.
  add column if not exists board_id uuid references public.boards(id) on delete restrict,
  -- Who actually drove it. Nullable, stamped when the load is confirmed, and the
  -- whole reason `drivers` survives this migration: "Board 1 delivered it" is
  -- not an adequate answer to "who was holding that parcel?".
  add column if not exists operated_by_driver_id uuid
    references public.drivers(id) on delete set null;

comment on column public.laundry_orders.assigned_board_id is
  'The round taking this job out. With assigned_delivery_date this is the '
  'user-facing assignment. assigned_driver_id is retained for jobs assigned '
  'before boards existed and is no longer written.';
comment on column public.daily_routes.operated_by_driver_id is
  'The person who operated this board on this day. Recorded for accountability; '
  'never the thing a job is assigned to.';

-- ---------------------------------------------------------- integrity --------
-- The four 0016 constraints, restated to accept **either** assignee.
--
-- Replacing rather than adding is what keeps this non-destructive: a historical
-- job assigned to a driver and no board satisfies every rule below exactly as it
-- did before, while a new board assignment — driver null, board set — would have
-- violated 0016's `assignment_pair` outright.
alter table public.laundry_orders
  drop constraint if exists chk_laundry_orders_assigned_has_driver,
  drop constraint if exists chk_laundry_orders_assignment_status,
  drop constraint if exists chk_laundry_orders_assignment_pair,
  drop constraint if exists chk_laundry_orders_assignment_delivery;

-- An assigned job names somebody and a day. "Somebody" is a board going forward
-- and may be a driver on a row written before this migration.
alter table public.laundry_orders
  add constraint chk_laundry_orders_assigned_has_assignee check (
    status <> 'assigned'
    or (assigned_delivery_date is not null
        and (assigned_board_id is not null or assigned_driver_id is not null))
  );

-- An assignee and a date travel together or not at all. Half an assignment is a
-- job that appears on nobody's day and reads as assigned on the list.
alter table public.laundry_orders
  add constraint chk_laundry_orders_assignment_pair check (
    (assigned_delivery_date is null)
    = (assigned_board_id is null and assigned_driver_id is null)
  );

-- Holding an assignment means being at or past `assigned`. Cancelled is included
-- because cancelling must never require unpicking the assignment first.
alter table public.laundry_orders
  add constraint chk_laundry_orders_assignment_status check (
    (assigned_board_id is null and assigned_driver_id is null)
    or status in ('assigned','out_for_delivery','completed','cancelled')
  );

-- A customer pickup never goes out on a round.
alter table public.laundry_orders
  add constraint chk_laundry_orders_assignment_delivery check (
    (assigned_board_id is null and assigned_driver_id is null) or delivery_required
  );

-- ------------------------------------------------------------- indexes -------
-- **The** My Runs query, in board terms: this board, this day.
create index if not exists idx_laundry_orders_board_day
  on public.laundry_orders(tenant_id, assigned_board_id, assigned_delivery_date)
  where assigned_board_id is not null;

-- The office's "ready to go out and given to nobody" queue, now keyed on the
-- board. 0016's equivalent keyed on the driver and is dropped: with boards it
-- would report every board-assigned job as unassigned.
drop index if exists idx_laundry_orders_ready_unassigned;
create index if not exists idx_laundry_orders_ready_unassigned
  on public.laundry_orders(tenant_id, expected_delivery_date)
  where assigned_board_id is null
    and assigned_driver_id is null
    and delivery_required
    and status = 'ready_for_delivery';

create index if not exists idx_daily_routes_board
  on public.daily_routes(board_id, route_date);

-- ---------------------------------------------------- transition guard -------
-- **This is 0017's function, not 0016's, and the difference matters.**
-- `create or replace` takes whatever body it is given, so rebuilding this from
-- 0016 — the migration that introduced the assignment — silently drops the
-- billing hook `0017_customer_pricing_billing` added underneath it, and
-- completing a job stops setting `awaiting_review`. The job then never reaches
-- the billing queue and is never invoiced: a revenue bug, with a green build in
-- front of it. Caught here by `job_billing.test.sql`, which is why the pgTAP
-- suite runs against every migration rather than only the new one.
--
-- The only change from 0017's version is that Remove Assignment clears the
-- board as well. Leaving `assigned_board_id` set on a job put back in the ready
-- queue is exactly the half-assignment the constraints above refuse, so the
-- trigger that performs the move is what has to clear it.
create or replace function public.guard_laundry_order_transition()
returns trigger language plpgsql set search_path = public as $$
declare allowed text[];
begin
  if new.status is not distinct from old.status then return new; end if;

  allowed := case old.status
    when 'new'                then array['in_progress','cancelled']
    when 'in_progress'        then array['ready_for_delivery','cancelled']
    when 'ready_for_delivery' then array['assigned','completed','cancelled']
    when 'assigned'           then array['out_for_delivery','ready_for_delivery','cancelled']
    when 'out_for_delivery'   then array['completed','cancelled']
    -- completed and cancelled stay terminal. A job that finished and then
    -- reopened is two different accounts of the same work.
    else array[]::text[]
  end;

  if new.status in ('assigned','out_for_delivery') and not new.delivery_required then
    raise exception 'this job is a customer pickup, so it is never sent out on a run'
      using errcode = 'P0001';
  end if;

  if not (new.status = any(allowed)) then
    raise exception 'a job cannot go from % to %', old.status, new.status
      using errcode = 'P0001';
  end if;

  if new.status = 'completed' and old.status = 'ready_for_delivery' and new.delivery_required then
    raise exception 'a delivery job must be assigned to a board and go out before it is completed'
      using errcode = 'P0001';
  end if;

  -- Remove Assignment. The board joins the four columns 0016 already cleared.
  if new.status = 'ready_for_delivery' and old.status = 'assigned' then
    new.assigned_board_id = null;
    new.assigned_driver_id = null;
    new.assigned_delivery_date = null;
    new.assigned_at = null;
    new.assigned_by = null;
    new.load_confirmed_at = null;
    new.load_confirmed_by = null;
    new.stop_id = null;
  end if;

  -- Stamp the timestamps the state implies, so a row can never record a
  -- finished job with no finishing time no matter which client wrote it.
  if new.status = 'assigned' then
    new.assigned_at = coalesce(new.assigned_at, now());
  end if;
  if new.status = 'completed' then
    new.completed_at = coalesce(new.completed_at, now());
    -- 0017: finishing the work puts the job in front of a person and bills
    -- nobody. `pending` is the only state this moves from, so a job already
    -- approved is never dragged backwards.
    if new.billing_status = 'pending' then
      new.billing_status = 'awaiting_review';
    end if;
  end if;
  if new.status = 'cancelled' then
    new.cancelled_at = coalesce(new.cancelled_at, now());
    -- 0017: cancelled work is not billed. Anything past approval is a credit
    -- note rather than a status change, so it is left alone.
    if new.billing_status in ('pending','awaiting_review','approved') then
      new.billing_status = 'not_billable';
      new.billing_exclusion_reason =
        coalesce(nullif(btrim(coalesce(new.billing_exclusion_reason, '')), ''),
                 nullif(btrim(coalesce(new.cancellation_reason, '')), ''),
                 'Job cancelled');
    end if;
  end if;
  return new;
end $$;

-- ------------------------------------------------- the eligibility guard -----
-- 0016's guard in board terms, with the same two jobs: is this job eligible for
-- assignment at all, and do the two records of the assignment agree?
--
-- **It fires only when the stop or the assignment changes.** That early return is
-- what lets this migration require a board on every new assignment without
-- re-judging a single historical row: completing, cancelling or editing an old
-- driver-assigned job never re-enters the body.
create or replace function public.guard_laundry_order_assignment()
returns trigger language plpgsql set search_path = public as $$
declare
  v_stop record;
begin
  if tg_op = 'UPDATE'
     and new.stop_id is not distinct from old.stop_id
     and new.assigned_board_id is not distinct from old.assigned_board_id
     and new.assigned_driver_id is not distinct from old.assigned_driver_id
     and new.assigned_delivery_date is not distinct from old.assigned_delivery_date then
    return new;
  end if;

  -- Unassigning is always allowed: it is the undo, and refusing it would strand
  -- work on a round that is not going.
  if new.assigned_board_id is null
     and new.assigned_driver_id is null
     and new.stop_id is null then
    return new;
  end if;

  if not new.delivery_required then
    raise exception 'this job is a customer pickup, so it is not eligible for delivery assignment'
      using errcode = 'P0001';
  end if;

  if new.status in ('new', 'in_progress') then
    raise exception 'this job is not ready for delivery yet'
      using errcode = 'P0001';
  end if;
  if new.status in ('completed', 'cancelled') then
    raise exception 'a % job cannot be assigned to a board', new.status
      using errcode = 'P0001';
  end if;

  -- **Every assignment written from here on names a board.** A driver-only
  -- assignment is what this migration replaces, and allowing new ones would
  -- leave the business with two answers to "whose round is this?" — the exact
  -- duplication 0016 was written to prevent, one level up.
  if new.assigned_board_id is null and new.assigned_driver_id is not null then
    raise exception 'a job is assigned to a board, not to a driver'
      using errcode = 'P0001';
  end if;

  -- The board has to be a real, active board in this tenant. RLS on `boards`
  -- applies inside the lookup, so another tenant's board is not merely rejected
  -- — it is invisible, and lands here as "not found".
  if new.assigned_board_id is not null then
    perform 1 from public.boards b
      where b.id = new.assigned_board_id
        and b.tenant_id = new.tenant_id
        and b.status = 'active'
        and b.deleted_at is null;
    if not found then
      raise exception 'that board could not be found' using errcode = 'P0001';
    end if;
  end if;

  if new.stop_id is null then return new; end if;

  select j.tenant_id, j.customer_id, r.board_id, r.route_date
    into v_stop
    from public.jobs j
    left join public.daily_routes r on r.id = j.route_id
   where j.id = new.stop_id and j.deleted_at is null;

  if not found then
    raise exception 'that stop could not be found' using errcode = 'P0001';
  end if;
  if v_stop.tenant_id <> new.tenant_id then
    raise exception 'that stop belongs to another tenant' using errcode = 'P0001';
  end if;
  if v_stop.customer_id <> new.customer_id then
    raise exception 'that stop is a visit to a different customer'
      using errcode = 'P0001';
  end if;

  -- The two records of the assignment must agree, in both directions.
  --
  -- A job sitting on a crewed run while naming no board is the worst of the
  -- available states: it is on somebody's route sheet and on nobody's My Runs,
  -- so the office believes it is going out and the round never sees it.
  if v_stop.board_id is not null and new.assigned_board_id is null then
    raise exception 'a job on a board''s run must name that board and delivery date'
      using errcode = 'P0001';
  end if;
  if new.assigned_board_id is not null
     and v_stop.board_id is not null
     and v_stop.board_id <> new.assigned_board_id then
    raise exception 'that stop is on another board''s run' using errcode = 'P0001';
  end if;
  if new.assigned_delivery_date is not null
     and v_stop.route_date is not null
     and v_stop.route_date <> new.assigned_delivery_date then
    raise exception 'that stop is on a run for a different day' using errcode = 'P0001';
  end if;

  return new;
end $$;

-- ------------------------------------------------------------------- RLS -----
-- Three policies gain a board term. Each keeps its existing driver term
-- **unchanged**, so no driver's visibility moves: the two narrowings are
-- independent and a member who is neither is unaffected by both.
--
-- `and archived_at is null` is restated inline on the two archivable tables
-- (`jobs`, `laundry_orders`). 0017 wraps whatever policy it finds, so dropping
-- and recreating one without the clause would silently un-hide 1,154 archived
-- rows on the live project. `daily_routes` is deliberately not archivable and
-- deliberately carries no clause. Asserted at the foot of this file.
drop policy if exists daily_routes_access on public.daily_routes;
create policy daily_routes_access on public.daily_routes for all to authenticated
  using (
    (select public.is_member(tenant_id))
    and (not (select public.is_driver_only(tenant_id))
         or driver_id = (select public.current_driver_id(tenant_id)))
    and (not (select public.is_board_only(tenant_id))
         or board_id = (select public.current_board_id(tenant_id)))
  )
  with check (
    (select public.is_member(tenant_id))
    and (not (select public.is_driver_only(tenant_id))
         or driver_id = (select public.current_driver_id(tenant_id)))
    and (not (select public.is_board_only(tenant_id))
         or board_id = (select public.current_board_id(tenant_id)))
  );

drop policy if exists jobs_access on public.jobs;
create policy jobs_access on public.jobs for all to authenticated
  using (
    (select public.is_member(tenant_id))
    and (not (select public.is_driver_only(tenant_id))
         or driver_id = (select public.current_driver_id(tenant_id)))
    and (not (select public.is_board_only(tenant_id))
         or exists (
           select 1 from public.daily_routes r
            where r.id = jobs.route_id
              and r.board_id = (select public.current_board_id(jobs.tenant_id))
         ))
    and archived_at is null
  )
  with check (
    (select public.is_member(tenant_id))
    and (not (select public.is_driver_only(tenant_id))
         or driver_id = (select public.current_driver_id(tenant_id)))
    and (not (select public.is_board_only(tenant_id))
         or exists (
           select 1 from public.daily_routes r
            where r.id = jobs.route_id
              and r.board_id = (select public.current_board_id(jobs.tenant_id))
         ))
    and archived_at is null
  );

-- A board reads the laundry assigned to it, or sitting on a stop of one of its
-- own runs — the same two-clause shape 0016 gave a driver, because the
-- assignment can outlive the stop (a deleted stop nulls `stop_id` and must not
-- make a round's own work vanish mid-morning).
drop policy if exists laundry_orders_access on public.laundry_orders;
create policy laundry_orders_access on public.laundry_orders for all to authenticated
  using (
    (select public.is_member(tenant_id))
    and (
      not (select public.is_driver_only(tenant_id))
      or assigned_driver_id = (select public.current_driver_id(laundry_orders.tenant_id))
      or exists (
        select 1
          from public.jobs j
          join public.daily_routes r on r.id = j.route_id
         where j.id = laundry_orders.stop_id
           and r.driver_id = (select public.current_driver_id(laundry_orders.tenant_id))
      )
    )
    and (
      not (select public.is_board_only(tenant_id))
      or assigned_board_id = (select public.current_board_id(laundry_orders.tenant_id))
      or exists (
        select 1
          from public.jobs j
          join public.daily_routes r on r.id = j.route_id
         where j.id = laundry_orders.stop_id
           and r.board_id = (select public.current_board_id(laundry_orders.tenant_id))
      )
    )
    and archived_at is null
  )
  with check (
    (select public.is_member(tenant_id))
    and (
      not (select public.is_driver_only(tenant_id))
      or assigned_driver_id = (select public.current_driver_id(laundry_orders.tenant_id))
      or exists (
        select 1
          from public.jobs j
          join public.daily_routes r on r.id = j.route_id
         where j.id = laundry_orders.stop_id
           and r.driver_id = (select public.current_driver_id(laundry_orders.tenant_id))
      )
    )
    and (
      not (select public.is_board_only(tenant_id))
      or assigned_board_id = (select public.current_board_id(laundry_orders.tenant_id))
      or exists (
        select 1
          from public.jobs j
          join public.daily_routes r on r.id = j.route_id
         where j.id = laundry_orders.stop_id
           and r.board_id = (select public.current_board_id(laundry_orders.tenant_id))
      )
    )
    and archived_at is null
  );

-- ------------------------------------- 0025's restrictive layer, widened -----
-- **Without this a board account cannot finish its own delivery, silently.**
--
-- 0025 narrowed every write on the job→invoice tables to the owner and the
-- office manager, with exactly one carve-out on `laundry_orders`: the *driver*
-- clause, because a driver completing a stop writes to this table and a
-- restrictive policy that refuses them leaves the job at `out_for_delivery` for
-- ever with no error — zero rows, no message. 0025's own comment records that a
-- local probe found it.
--
-- The board is now the actor doing that work, so the carve-out has to name it
-- too. The added condition is the *same* board clause the permissive policy
-- above already carries, so it grants nothing that policy did not already grant
-- — it only declines to take it away.
--
-- Restated in full rather than wrapped: these three are restrictive, so 0028's
-- archive wrapper deliberately never touched them and there is no clause to
-- preserve. Every column is qualified because the EXISTS joins two tables that
-- both carry `tenant_id`.
do $$
declare
  v_predicate constant text := '('
    || '(select public.has_role(laundry_orders.tenant_id,'
    || '                        array[''super_admin'',''operations_manager'']))'
    || ' or laundry_orders.assigned_driver_id ='
    || '      (select public.current_driver_id(laundry_orders.tenant_id))'
    || ' or laundry_orders.assigned_board_id ='
    || '      (select public.current_board_id(laundry_orders.tenant_id))'
    || ' or exists (select 1 from public.jobs j'
    || '              join public.daily_routes r on r.id = j.route_id'
    || '             where j.id = laundry_orders.stop_id'
    || '               and (r.driver_id ='
    || '                      (select public.current_driver_id(laundry_orders.tenant_id))'
    || '                or r.board_id ='
    || '                      (select public.current_board_id(laundry_orders.tenant_id)))))';
begin
  execute 'drop policy if exists laundry_orders_main_flow_insert on public.laundry_orders';
  execute format(
    'create policy laundry_orders_main_flow_insert on public.laundry_orders
       as restrictive for insert to authenticated with check (%s)', v_predicate);

  execute 'drop policy if exists laundry_orders_main_flow_update on public.laundry_orders';
  execute format(
    'create policy laundry_orders_main_flow_update on public.laundry_orders
       as restrictive for update to authenticated using (%s) with check (%s)',
    v_predicate, v_predicate);

  execute 'drop policy if exists laundry_orders_main_flow_delete on public.laundry_orders';
  execute format(
    'create policy laundry_orders_main_flow_delete on public.laundry_orders
       as restrictive for delete to authenticated using (%s)', v_predicate);
end $$;

-- ------------------------------------------------------------ the posture ----
-- CLAUDE.md §7: PostgREST publishes `public` as RPC, so a function executable by
-- `anon` is an unauthenticated endpoint. Stated for the new helpers and restated
-- for the replaced guards, since `create or replace` keeps the existing ACL and
-- a future replace must not quietly reopen it.
revoke all on function public.current_board_id(uuid) from public, anon;
revoke all on function public.is_board_only(uuid) from public, anon;
revoke all on function public.guard_laundry_order_transition() from public, anon;
revoke all on function public.guard_laundry_order_assignment() from public, anon;
grant execute on function public.current_board_id(uuid) to authenticated, service_role;
grant execute on function public.is_board_only(uuid) to authenticated, service_role;

-- 0029: `anon` holds no table privilege, and a new table must not reopen that.
revoke all on public.boards from anon;
grant select, insert, update, delete on public.boards to authenticated;
grant all on public.boards to service_role;

-- ------------------------------------------------- assert the outcome --------
-- Fail rather than half-apply. Each of these has been wrong in this project
-- before: an anon-executable definer helper (0011), a policy that lost its
-- archive clause when it was rewritten (0028), and a table arriving with anon
-- grants on it (0029).
do $$
declare n integer;
begin
  if has_function_privilege('anon', 'public.current_board_id(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.is_board_only(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.guard_laundry_order_assignment()', 'EXECUTE')
     or has_function_privilege('anon', 'public.guard_laundry_order_transition()', 'EXECUTE') then
    raise exception 'anon can still execute a board helper or a laundry order guard'
      using errcode = 'P0001';
  end if;

  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'boards' and grantee = 'anon';
  if n > 0 then
    raise exception 'boards arrived with % anon table grant(s)', n using errcode = 'P0001';
  end if;

  -- The 0028 trap: a rewritten permissive policy on an archivable table that
  -- forgot the clause makes archived rows readable again.
  select count(*) into n
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relname in ('jobs', 'laundry_orders')
     and pol.polpermissive
     and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') not ilike '%archived_at IS NULL%';
  if n > 0 then
    raise exception '% rewritten policy(ies) no longer filter archived rows', n
      using errcode = 'P0001';
  end if;
end $$;
