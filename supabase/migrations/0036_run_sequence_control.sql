-- ============================================================================
-- 0036 — the order of a run is management's decision, and the database says so
--
-- The client's rule: **management determines the order of the run, drivers
-- execute it.** The Runs screen has ordered a board's day since 2026-08-20, and
-- three things were missing from it — none of them cosmetic.
--
-- ## 1. `routes.write` is not the right authority, and never was
--
-- The reorder action was gated on `routes.write`, which `dispatcher`,
-- `branch_manager` and `regional_manager` all hold. The requirement names two
-- roles. `roles.ts` gains a dedicated `routes.sequence` capability; this
-- migration is its counterpart underneath, because a capability is a statement
-- about screens and this table is published on `/rest/v1/jobs`.
--
-- ## 2. Any member could rewrite `jobs.sequence` straight off PostgREST
--
-- `jobs_access` (0004, rewritten by 0031) is a single permissive `for all`
-- policy: tenancy, plus a narrowing to their own run for a driver or a board.
-- So **a driver could reorder the run they were standing in**, and a counter
-- hand or the plant floor could reorder anybody's — one PATCH, no screen
-- involved. That is the exact thing §8 of the requirement says must fail
-- server-side, and it is the reason this cannot be done in `roles.ts` alone.
--
-- **A restrictive policy is the wrong tool here and a trigger is the right
-- one.** RLS is row-level: a restrictive UPDATE policy on `jobs` applies to
-- every update of the row, and a driver must go on writing `progress_status`,
-- `arrived_at` and the rest on their own stops as they work them. The rule to
-- enforce is about *one column*, which is what `guard_batch_line_change` (0009)
-- and `guard_laundry_order_assignment` (0016) already use a trigger for.
--
-- A trigger also refuses out loud. 0025's restrictive layer writes **zero rows
-- with no error** to a caller it excludes — a silence this project has shipped
-- twice (0031 for boards, §26 for the counter) — and an operator who is told
-- nothing repeats the action. `raise ... errcode = 42501` reaches the flash
-- toast as a sentence.
--
-- ## 3. Two managers could overwrite each other with no trace
--
-- Nothing recorded that a run's order had moved, so a stale page saved twenty
-- minutes later silently won. `daily_routes.sequence_version` is the optimistic
-- concurrency token, and `apply_run_sequence()` compares-and-swaps it in the
-- same transaction that writes the positions.
--
-- ## What this deliberately does not do
--
-- Adds no table. Drops nothing. Invalidates no row: every column arrives with a
-- default that describes what was already true (`sequence_locked` true — the
-- order has always been the office's; `sequence_version` 1 — nobody has moved
-- it yet). Route generation, run creation, board assignment, load confirmation,
-- run execution, closing, the inventory unload and the offline outbox are all
-- untouched — none of them writes `jobs.sequence`, which was checked rather than
-- assumed. The two writers that do are the Runs screen and the (unlinked)
-- dispatch planner, and both now answer to the same capability.
-- ============================================================================

-- ------------------------------------------------- the run's order metadata --
-- On `daily_routes` rather than in a second Run table: the run already **is**
-- the (board, date) pair this order belongs to, and a second table would be two
-- records of one fact — the arrangement 0015/0016 exist to avoid.
alter table public.daily_routes
  add column if not exists sequence_locked     boolean not null default true,
  add column if not exists sequence_version    integer not null default 1,
  add column if not exists sequence_updated_by uuid references auth.users(id) on delete set null,
  add column if not exists sequence_updated_at timestamptz;

comment on column public.daily_routes.sequence_locked is
  'The run''s order is management-controlled. Read by guard_job_sequence(): '
  'while true, only a role holding the run-sequence authority may move a stop. '
  'Editing is a screen state and is deliberately never persisted — entering it '
  'writes nothing, so Cancel has nothing to undo.';
comment on column public.daily_routes.sequence_version is
  'Optimistic concurrency token for the run order. Bumped by apply_run_sequence() '
  'in the transaction that writes the positions, so a stale editing session '
  'cannot overwrite a newer sequence. Deliberately not updated_at: that column '
  'moves for status changes and load confirmation, which would raise conflicts '
  'over edits that never touched the order.';

-- The Runs screen and every save resolve a run by (tenant, board, date).
create index if not exists idx_daily_routes_board_day
  on public.daily_routes (tenant_id, board_id, route_date)
  where deleted_at is null;

-- ------------------------------------------------------------- who may order --
-- Named, so the database states the rule once and both triggers read it. The
-- app's `routes.sequence` capability is the same sentence for the nav and the
-- page guards; `roles.test.ts` and `run_sequence.test.sql` pin the two halves.
--
-- `has_role()` already carries `or is_platform_admin()` (0019), so a platform
-- administrator is admitted without naming them here — the same way every other
-- role gate in this schema inherits it.
create or replace function public.can_write_run_sequence(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array['super_admin', 'operations_manager']);
$$;

comment on function public.can_write_run_sequence(uuid) is
  'True when the caller may set the order a board drives its day in: the Owner '
  'and the Office manager (and a platform admin, via has_role). Deliberately '
  'narrower than routes.write, which a dispatcher holds.';

-- --------------------------------------------------- the column-level guard --
-- Fires only when `sequence` is in the SET list *and* actually changes, so
-- every other write to a stop — status, progress, arrival, the offline sync's
-- completion, the archive stamp, retiring an emptied stop — is untouched.
-- INSERT is not guarded at all: a newly assigned stop is appended at the end by
-- `findOrCreateStop`, and refusing that would break board assignment for the
-- very roles that do it (§11 of the requirement, and §21's "do not break
-- existing board assignment").
create or replace function public.guard_job_sequence()
returns trigger language plpgsql set search_path = public as $$
declare
  v_locked boolean;
begin
  -- The gap-closer, admitted by a transaction-local flag that only
  -- `compact_run_sequence()` sets.
  --
  -- This is safe for a reason that is structural rather than a matter of trust:
  -- that function **computes the new positions itself** from the order already
  -- stored, so it can only ever close a gap. It cannot carry an order chosen by
  -- its caller, so admitting it cannot undo a management decision — the most it
  -- can do is renumber 1,3,7 as 1,2,3. That is also why it is allowed past the
  -- worked-stop rule below: a compaction preserves relative order, and relative
  -- order is what that rule protects.
  if coalesce(current_setting('app.run_sequence_compaction', true), 'off') = 'on' then
    return new;
  end if;

  -- A stop on no run has no management-decided order to protect. The dispatch
  -- planner's tray is the only thing that produces one.
  if new.route_id is null then
    return new;
  end if;

  select sequence_locked into v_locked
    from public.daily_routes where id = new.route_id;

  if coalesce(v_locked, true) and not public.can_write_run_sequence(new.tenant_id) then
    raise exception
      'the order of a run is set by the office, and your role cannot change it'
      using errcode = '42501';
  end if;

  -- §16: a stop the round has already worked keeps its place, and this holds
  -- for the Owner too. Repositioning it would rewrite where work that has
  -- already happened happened, and no role makes that true.
  if old.progress_status is distinct from 'not_started'
     or old.status in ('completed', 'cancelled') then
    raise exception
      'that stop has already been worked, so its place in the run cannot change'
      using errcode = 'P0001';
  end if;

  return new;
end $$;

create trigger guard_jobs_sequence
  before update of sequence on public.jobs
  for each row
  when (old.sequence is distinct from new.sequence)
  execute procedure public.guard_job_sequence();

-- ------------------------------------------ the lock and the version itself --
-- Without this a board or a driver — who may update their own run row, by
-- `daily_routes_access` — could set `sequence_locked = false` and walk straight
-- past the guard above, or rewind `sequence_version` to defeat the concurrency
-- check. Narrowed to the four columns, so status, crew, load confirmation and
-- closing stay exactly as writable as they were.
create or replace function public.guard_run_sequence_control()
returns trigger language plpgsql set search_path = public as $$
begin
  if not public.can_write_run_sequence(new.tenant_id) then
    raise exception
      'only the owner or an operations manager can change a run''s order'
      using errcode = '42501';
  end if;
  return new;
end $$;

create trigger guard_daily_routes_sequence_control
  before update of sequence_locked, sequence_version, sequence_updated_by, sequence_updated_at
  on public.daily_routes
  for each row
  when (old.sequence_locked     is distinct from new.sequence_locked
     or old.sequence_version    is distinct from new.sequence_version
     or old.sequence_updated_by is distinct from new.sequence_updated_by
     or old.sequence_updated_at is distinct from new.sequence_updated_at)
  execute procedure public.guard_run_sequence_control();

-- ------------------------------------------------------------ Save & Lock ----
-- One transaction: re-resolve the run from (tenant, board, date), compare and
-- swap the version, check the posted set is exactly this run's stops, and write
-- the positions.
--
-- **SECURITY INVOKER on purpose.** RLS still decides which rows the caller can
-- see, and the two guards above still fire — so calling this RPC directly as a
-- driver is refused by the same rule that refuses the PATCH, rather than by
-- this function being the only thing standing in the way. The precedent is
-- `save_laundry_order_items()` (0014), which is invoker for the same reason and
-- exists for the same reason: over PostgREST the alternative is a loop of
-- single-row updates with a window in which the run has two stops numbered 3
-- and nothing to roll back.
--
-- **The board and the date are re-queried here rather than trusted.** The
-- caller posts them, but the run ids come from this lookup, so a forged run id
-- reaches nothing and a board belonging to another laundry resolves to no rows
-- (§8, §13 of the requirement).
create or replace function public.apply_run_sequence(
  t                 uuid,
  board             uuid,
  run_date          date,
  stop_ids          uuid[],
  expected_version  integer
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_routes   uuid[];
  v_expected integer;
  v_bumped   integer;
  v_known    integer;
  v_next     integer;
begin
  if not public.is_member(t) then
    raise exception 'that laundry is not yours' using errcode = '42501';
  end if;

  if stop_ids is null or array_length(stop_ids, 1) is null then
    raise exception 'there is nothing to reorder' using errcode = 'P0001';
  end if;

  -- Isolated by tenant + board + date, which is what makes Board 1 / 25 August
  -- independent of Board 2 and of the 26th (§13).
  select array_agg(id) into v_routes
    from public.daily_routes
   where tenant_id = t and board_id = board and route_date = run_date
     and deleted_at is null and status <> 'cancelled';

  if v_routes is null then
    raise exception 'that board has nothing on that day any more' using errcode = 'P0001';
  end if;

  -- The posted order must name every stop on the run and nothing else. Checked
  -- before anything is written, and by counting rather than by trusting the
  -- caller's own count.
  select count(*) into v_known
    from public.jobs
   where tenant_id = t and route_id = any(v_routes) and deleted_at is null;

  if v_known <> array_length(stop_ids, 1) then
    raise exception 'that order does not match the stops on this run any more'
      using errcode = 'P0001';
  end if;

  select count(*) into v_expected
    from public.jobs
   where tenant_id = t and route_id = any(v_routes) and deleted_at is null
     and id = any(stop_ids);

  if v_expected <> v_known then
    raise exception 'that order names a stop that is not on this run'
      using errcode = 'P0001';
  end if;

  -- Compare and swap. `<=` rather than `=` so a run opened after the last save
  -- (its version still 1) joins the day's token instead of deadlocking against
  -- a board+date whose other run has already been ordered. A concurrent save
  -- has moved every one of them past `expected_version`, so it matches none and
  -- the row count gives it away.
  --
  -- This statement is also the permission boundary: it fires
  -- `guard_run_sequence_control`, which refuses any caller who may not order a
  -- run — so an unauthorised direct call fails here, before a position moves.
  v_next := expected_version + 1;

  update public.daily_routes
     set sequence_version    = v_next,
         sequence_locked     = true,
         sequence_updated_by = (select auth.uid()),
         sequence_updated_at = now()
   where id = any(v_routes)
     and tenant_id = t
     and sequence_version <= expected_version;
  get diagnostics v_bumped = row_count;

  if v_bumped <> array_length(v_routes, 1) then
    raise exception
      'this run was updated by another user. Reload the run to see the latest sequence before making further changes.'
      using errcode = 'P0001';
  end if;

  -- Positions are rewritten from 1 rather than nudged: "position 3" on a run
  -- sheet has to mean the third call, and nudging preserves whatever gaps and
  -- duplicates the data already carried. One statement, so the run is never
  -- transiently numbered twice.
  with ordered as (
    select id, ordinality::integer as position
      from unnest(stop_ids) with ordinality as u(id, ordinality)
  )
  update public.jobs j
     set sequence = o.position
    from ordered o
   where j.id = o.id
     and j.tenant_id = t
     and j.route_id = any(v_routes)
     and j.deleted_at is null
     and j.sequence is distinct from o.position;

  return v_next;
end $$;

comment on function public.apply_run_sequence(uuid, uuid, date, uuid[], integer) is
  'Save & Lock: re-resolves the run from (tenant, board, date), compare-and-swaps '
  'sequence_version, verifies the posted set is exactly this run''s stops, and '
  'writes positions 1..n in one statement. Returns the new version.';

-- ----------------------------------------------------------- closing a gap ---
-- §12: removing a stop must close the gap behind it, and the existing
-- `retireStopIfEmpty` soft-deleted the row and left 1,3,4 behind.
--
-- SECURITY DEFINER because the roles that legitimately empty a stop are wider
-- than the roles that may order a run — a dispatcher reassigning work, or the
-- counter moving a job to another board. Refusing them here would either break
-- reassignment or leave the gap the requirement says must close.
--
-- Admitting them is safe by construction, not by trust: the new positions are
-- computed here from the order already stored, so this can only renumber
-- 1,3,7 as 1,2,3. **Relative order is preserved and no caller can influence
-- it** — there is no argument through which an order could be supplied.
create or replace function public.compact_run_sequence(r uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_moved  integer := 0;
begin
  select tenant_id into v_tenant from public.daily_routes where id = r;
  if v_tenant is null then return 0; end if;

  -- Definer rights, so membership is checked here rather than left to RLS —
  -- the rule 0010 set for `next_number()` and 0017 for `set_records_archived()`.
  if not public.is_member(v_tenant) then
    raise exception 'that run is not yours' using errcode = '42501';
  end if;

  perform set_config('app.run_sequence_compaction', 'on', true);

  with ordered as (
    select id, row_number() over (order by sequence, created_at, id)::integer as position
      from public.jobs
     where route_id = r and tenant_id = v_tenant and deleted_at is null
  )
  update public.jobs j
     set sequence = o.position
    from ordered o
   where j.id = o.id
     and j.sequence is distinct from o.position;
  get diagnostics v_moved = row_count;

  perform set_config('app.run_sequence_compaction', 'off', true);
  return v_moved;
end $$;

comment on function public.compact_run_sequence(uuid) is
  'Closes the gaps a removed stop leaves, preserving relative order. Takes no '
  'order from its caller, so it cannot undo a management decision.';

-- ------------------------------------------------------------------ grants ---
-- The house rule since 0011: nothing in `public` is reachable without a login.
revoke all on function public.can_write_run_sequence(uuid) from public, anon;
revoke all on function public.apply_run_sequence(uuid, uuid, date, uuid[], integer) from public, anon;
revoke all on function public.compact_run_sequence(uuid) from public, anon;
-- Trigger functions are called by the trigger, never by a caller. Supabase's
-- default privileges publish them at /rest/v1/rpc/… where they can only error —
-- the trap 0019 recorded for `guard_last_platform_admin`.
revoke all on function public.guard_job_sequence() from public, anon, authenticated;
revoke all on function public.guard_run_sequence_control() from public, anon, authenticated;

grant execute on function public.can_write_run_sequence(uuid) to authenticated, service_role;
grant execute on function public.apply_run_sequence(uuid, uuid, date, uuid[], integer) to authenticated, service_role;
grant execute on function public.compact_run_sequence(uuid) to authenticated, service_role;

-- ------------------------------------------------- assert its own outcome ----
-- The house style since 0029: a migration that half-applies is worse than one
-- that fails, and `apply_migration` is atomic — so a raise here rolls the whole
-- thing back rather than leaving a boundary that looks present and is not.
do $$
declare
  v_missing text;
  v_count   integer;
begin
  -- 1. The four columns, all with the default that describes what was already
  --    true — so no existing run is invalidated.
  select string_agg(c, ', ') into v_missing
    from unnest(array[
      'sequence_locked', 'sequence_version', 'sequence_updated_by', 'sequence_updated_at'
    ]) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'daily_routes' and column_name = c);
  if v_missing is not null then
    raise exception '0036: daily_routes is missing %', v_missing using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.daily_routes
   where sequence_locked is not true or sequence_version <> 1;
  if v_count > 0 then
    raise exception '0036: % existing run(s) did not take the defaults', v_count
      using errcode = 'P0001';
  end if;

  -- 2. Both guards are attached. A function that exists and is not wired to a
  --    trigger is the shape of a boundary that is not there.
  if not exists (select 1 from pg_trigger
                  where tgname = 'guard_jobs_sequence'
                    and tgrelid = 'public.jobs'::regclass and not tgisinternal) then
    raise exception '0036: guard_jobs_sequence is not attached' using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'guard_daily_routes_sequence_control'
                    and tgrelid = 'public.daily_routes'::regclass and not tgisinternal) then
    raise exception '0036: guard_daily_routes_sequence_control is not attached'
      using errcode = 'P0001';
  end if;

  -- 3. Nothing new is reachable without a login (0011, 0029).
  if has_function_privilege('anon', 'public.can_write_run_sequence(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.apply_run_sequence(uuid, uuid, date, uuid[], integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.compact_run_sequence(uuid)', 'EXECUTE') then
    raise exception '0036: anon can execute a run-sequence function' using errcode = 'P0001';
  end if;

  -- 4. The trigger functions are not published as RPC, where they could only
  --    ever error (the 0019 trap).
  if has_function_privilege('authenticated', 'public.guard_job_sequence()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.guard_run_sequence_control()', 'EXECUTE') then
    raise exception '0036: a trigger function is callable as RPC' using errcode = 'P0001';
  end if;

  -- 5. The permission is genuinely narrower than routes.write. Asserted against
  --    the function body rather than against a role list, because the whole
  --    point of this migration is that the two are not the same set.
  if pg_get_functiondef('public.can_write_run_sequence(uuid)'::regprocedure) not like '%operations_manager%'
     or pg_get_functiondef('public.can_write_run_sequence(uuid)'::regprocedure) like '%dispatcher%' then
    raise exception '0036: can_write_run_sequence does not name the two roles'
      using errcode = 'P0001';
  end if;
end $$;
