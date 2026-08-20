-- ============================================================================
-- 0016_job_assignment — Job → Driver → Delivery Date, said once and stored once.
--
-- The workflow simplification. Before this, "who is delivering this job and
-- when" was answerable only by walking `laundry_orders.stop_id → jobs.route_id →
-- daily_routes.driver_id/route_date` (0015). That chain is correct and it stays
-- — the run is what the depot load, the inventory unload sweep and the offline
-- capture screen are all built on — but it cannot be the *user-facing* model:
--
--   * a check constraint cannot follow a foreign key, so "a job cannot be
--     Assigned without a driver and a date" was unenforceable;
--   * My Runs' one question ("what am I delivering on the 16th?") was three
--     joins deep, when it is two columns wide;
--   * and the office had to think about RUN-001 to answer it.
--
-- So the answer is written **on the job**, and the run keeps being resolved
-- behind the scenes by the server action. Two copies of a fact is normally the
-- bug 0015 was written to avoid, so the split of authority is explicit and
-- narrow:
--
--   `assigned_driver_id` + `assigned_delivery_date`  — the business assignment.
--                                                      The user-facing truth.
--                                                      What My Runs reads.
--   `stop_id`                                        — the operational placement
--                                                      on a run. Depot, sequence,
--                                                      inventory, run sheet.
--
-- `guard_laundry_order_assignment` below keeps them from contradicting each
-- other: a job that names a stop must name that stop's run's driver and date.
-- The database, not the action, is what makes that true.
--
-- Nothing is dropped. `vehicle_inspections`, `daily_routes`, `jobs` and every
-- historical row on them are untouched — this migration adds columns, widens one
-- check constraint, and replaces two guard functions and three policies.
-- ============================================================================

-- ------------------------------------------------------- the seventh status --
-- `assigned` sits between "ready for delivery" (it is folded and on the shelf)
-- and "out for delivery" (it is physically on a van). That gap was real and
-- previously unnameable: a job given to a driver on Monday for Wednesday spent
-- two days claiming to be unassigned work.
alter table public.laundry_orders
  drop constraint laundry_orders_status_check;
alter table public.laundry_orders
  add constraint laundry_orders_status_check check (status in (
    'new','in_progress','ready_for_delivery','assigned',
    'out_for_delivery','completed','cancelled'
  ));

-- ------------------------------------------------------------- assignment ----
alter table public.laundry_orders
  -- The existing drivers row — the same key `daily_routes.driver_id` uses, so a
  -- job and the run it rides on name the driver the same way. Not auth.users:
  -- `assigned_to` (0014) is already the staff member looking after the job at
  -- the counter, and conflating the two is exactly the confusion 0015's activity
  -- verbs were split to avoid.
  add column assigned_driver_id uuid references public.drivers(id) on delete restrict,

  -- A DATE, deliberately, and never derived from a timestamp. The operational
  -- day is Adelaide's; storing an instant and reading a day back out of it is
  -- how a 7am delivery becomes yesterday's work. `on delete restrict` above for
  -- the same reason a driver is not deleted while they hold work.
  add column assigned_delivery_date date,

  add column assigned_at timestamptz,
  add column assigned_by uuid references auth.users(id) on delete set null,

  -- Per-job load confirmation. The run also carries `load_confirmed_at`, and
  -- that is the depot's record of the vehicle; this is the *job's* — which
  -- matters for the one case the brief calls out: a job assigned after the
  -- driver has already confirmed their load must not be swept out with the rest
  -- at Start Route, because nobody put it on the van.
  add column load_confirmed_at timestamptz,
  add column load_confirmed_by uuid references auth.users(id) on delete set null;

comment on column public.laundry_orders.assigned_driver_id is
  'The driver taking this job out. With assigned_delivery_date this is the '
  'user-facing assignment; jobs.route_id -> daily_routes remains the operational '
  'placement and the two are kept in step by guard_laundry_order_assignment().';
comment on column public.laundry_orders.assigned_delivery_date is
  'The Adelaide calendar day this job is scheduled to a driver for. Distinct from '
  'expected_delivery_date, which is the date promised to the customer.';
comment on column public.laundry_orders.load_confirmed_at is
  'When the driver confirmed this job was on the van. Start Route dispatches only '
  'load-confirmed jobs, so work assigned after the load is not silently sent out.';

-- ---------------------------------------------------- transition guard -------
-- The workflow, with `assigned` in it. Transcribed by
-- `src/lib/domain/laundry-orders.ts`, which says the same thing in sentences so
-- the operator gets an explanation and the database gets the last word.
--
-- Two edges are worth defending here because they are not obvious:
--
--   ready_for_delivery -> completed   is allowed *only* for a customer pickup.
--                                     A delivery job must be given to a driver
--                                     and go out, which is now two steps rather
--                                     than one.
--   assigned -> ready_for_delivery    is Remove Assignment, and it is the one
--                                     backwards move in the table. It is not a
--                                     cancellation and must not read as one:
--                                     the job goes back in the queue with its
--                                     laundry, its customer and its history.
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

  -- The two workflows diverge at the end and each rejects the other's moves.
  -- Checked *before* the transition table on purpose: for a customer pickup,
  -- every move into the delivery states is wrong for the same reason, and
  -- "a job cannot go from ready_for_delivery to out_for_delivery" would send the
  -- reader looking for a missing step rather than telling them the job is not
  -- delivery work at all.
  if new.status in ('assigned','out_for_delivery') and not new.delivery_required then
    raise exception 'this job is a customer pickup, so it is never sent out on a run'
      using errcode = 'P0001';
  end if;

  if not (new.status = any(allowed)) then
    raise exception 'a job cannot go from % to %', old.status, new.status
      using errcode = 'P0001';
  end if;

  if new.status = 'completed' and old.status = 'ready_for_delivery' and new.delivery_required then
    raise exception 'a delivery job must be assigned to a driver and go out before it is completed'
      using errcode = 'P0001';
  end if;

  -- Removing an assignment clears the assignment. Doing it here rather than
  -- trusting the caller is what stops a job sitting in the ready queue while
  -- still naming a driver — the state chk_laundry_orders_assignment_status
  -- would refuse anyway, but refusing a legitimate action is worse than
  -- completing it.
  if new.status = 'ready_for_delivery' and old.status = 'assigned' then
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
  end if;
  if new.status = 'cancelled' then
    new.cancelled_at = coalesce(new.cancelled_at, now());
  end if;
  return new;
end $$;

-- -------------------------------------------------------------- backfill -----
-- Existing jobs already sitting on a driver's run.
--
-- Skipping this would leave every one of them in exactly the state the guard
-- below is written to forbid: on somebody's route sheet and on nobody's My Runs,
-- because the screen reads `assigned_driver_id` and the row would have none. The
-- answer is not invented — it is read back out of the chain that was already the
-- authority before this migration, `stop_id -> jobs.route_id -> daily_routes`, so
-- the backfill records what was already true rather than deciding anything.
--
-- Ordering matters and is the reason the transition guard is replaced above
-- rather than below: the `ready_for_delivery -> assigned` move this performs is
-- only legal against the new function. The *old* assignment guard does not fire,
-- because `stop_id` is not among the columns being written. The new one is
-- created after this, over data that is already consistent.
update public.laundry_orders o
   set assigned_driver_id = r.driver_id,
       assigned_delivery_date = r.route_date,
       -- The row has been assigned since whenever it was put on the run; there
       -- is no better instant on hand than the one the job was last touched.
       assigned_at = coalesce(o.updated_at, o.created_at),
       -- The van's own load confirmation carries down to the work on it, so a
       -- run already loaded when this migration lands can still be started.
       load_confirmed_at = r.load_confirmed_at,
       load_confirmed_by = r.load_confirmed_by,
       status = case
                  when o.status = 'ready_for_delivery' then 'assigned'
                  else o.status
                end
  from public.jobs j
  join public.daily_routes r on r.id = j.route_id
 where j.id = o.stop_id
   and o.delivery_required
   and r.driver_id is not null
   and o.assigned_driver_id is null
   -- A pickup, a job still in the plant or a cancelled one never held a real
   -- assignment, whatever a stray stop_id says. Left exactly as they are.
   and o.status in ('ready_for_delivery','out_for_delivery','completed');

-- ------------------------------------------------------------ integrity ------
-- "A Job cannot have status Assigned without valid assignment data" — the rule
-- that was unenforceable while the answer lived two tables away.
alter table public.laundry_orders
  add constraint chk_laundry_orders_assigned_has_driver check (
    status <> 'assigned'
    or (assigned_driver_id is not null and assigned_delivery_date is not null)
  );

-- And its converse: "A Job with Driver/date assignment must not remain Ready for
-- Delivery." A job holding an assignment has to be at or past `assigned`.
-- Cancelled is included because cancelling must never require unpicking the
-- assignment first — the history of who had it is worth keeping.
alter table public.laundry_orders
  add constraint chk_laundry_orders_assignment_status check (
    assigned_driver_id is null
    or status in ('assigned','out_for_delivery','completed','cancelled')
  );

-- Driver and date travel together or not at all. Half an assignment is a job
-- that appears on nobody's day and reads as assigned on the list.
alter table public.laundry_orders
  add constraint chk_laundry_orders_assignment_pair check (
    (assigned_driver_id is null) = (assigned_delivery_date is null)
  );

-- A customer pickup is never assigned to a delivery driver. Stated in the form,
-- in the action, and here — where it cannot be talked around.
alter table public.laundry_orders
  add constraint chk_laundry_orders_assignment_delivery check (
    assigned_driver_id is null or delivery_required
  );

-- ------------------------------------------------------------- indexes -------
-- **The** My Runs query: this driver, this day. Everything the screen renders
-- hangs off one index scan, which is what lets the date arrows feel instant.
create index idx_laundry_orders_driver_day
  on public.laundry_orders(tenant_id, assigned_driver_id, assigned_delivery_date)
  where assigned_driver_id is not null;

-- The office's "ready to go out and given to nobody" queue. Partial and tiny,
-- replacing 0015's equivalent, which keyed on stop_id — now the wrong question.
create index idx_laundry_orders_ready_unassigned
  on public.laundry_orders(tenant_id, expected_delivery_date)
  where assigned_driver_id is null
    and delivery_required
    and status = 'ready_for_delivery';

-- ------------------------------------------------- the eligibility guard -----
-- 0015's guard, extended to police the split of authority described at the top.
-- It fires when the stop *or* the assignment changes, and it enforces both
-- directions: an eligible job, and a stop that agrees with the assignment.
create or replace function public.guard_laundry_order_assignment()
returns trigger language plpgsql set search_path = public as $$
declare
  v_stop record;
begin
  if tg_op = 'UPDATE'
     and new.stop_id is not distinct from old.stop_id
     and new.assigned_driver_id is not distinct from old.assigned_driver_id
     and new.assigned_delivery_date is not distinct from old.assigned_delivery_date then
    return new;
  end if;

  -- Unassigning is always allowed: it is the undo, and refusing it would strand
  -- work on a van that is not going.
  if new.assigned_driver_id is null and new.stop_id is null then return new; end if;

  -- A job the customer is collecting is not delivery work. Checked before
  -- anything else because it is the rule a well-meaning bulk assign trips over.
  if not new.delivery_required then
    raise exception 'this job is a customer pickup, so it is not eligible for delivery assignment'
      using errcode = 'P0001';
  end if;

  if new.status in ('new', 'in_progress') then
    raise exception 'this job is not ready for delivery yet'
      using errcode = 'P0001';
  end if;
  if new.status in ('completed', 'cancelled') then
    raise exception 'a % job cannot be assigned to a driver', new.status
      using errcode = 'P0001';
  end if;

  -- The driver has to be a real, active driver in this tenant. RLS on `drivers`
  -- applies inside the lookup, so another tenant's driver is not merely
  -- rejected — it is invisible, and lands here as "not found".
  if new.assigned_driver_id is not null then
    perform 1 from public.drivers d
      where d.id = new.assigned_driver_id
        and d.tenant_id = new.tenant_id
        and d.deleted_at is null;
    if not found then
      raise exception 'that driver could not be found' using errcode = 'P0001';
    end if;
  end if;

  if new.stop_id is null then return new; end if;

  select j.tenant_id, j.customer_id, r.driver_id, r.route_date
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

  -- Jobs gather under the stop for *their own* customer. Without this a job
  -- could be filed under a visit to a different business, and the driver would
  -- arrive somewhere holding the wrong linen.
  if v_stop.customer_id <> new.customer_id then
    raise exception 'that stop is a visit to a different customer'
      using errcode = 'P0001';
  end if;

  -- The two records of the assignment must agree. This is the constraint that
  -- makes carrying both safe: the operational placement cannot drift away from
  -- the business assignment, in either direction, without being refused.
  --
  -- Including the case where the assignment is simply missing. A job sitting on
  -- a crewed run while naming no driver is the worst of the possible states: it
  -- is on somebody's route sheet and on nobody's My Runs, so the office believes
  -- it is going out and the driver never sees it. Refused outright.
  if v_stop.driver_id is not null and new.assigned_driver_id is null then
    raise exception 'a job on a driver''s run must name that driver and delivery date'
      using errcode = 'P0001';
  end if;
  if new.assigned_driver_id is not null
     and v_stop.driver_id is not null
     and v_stop.driver_id <> new.assigned_driver_id then
    raise exception 'that stop is on another driver''s run' using errcode = 'P0001';
  end if;
  if new.assigned_delivery_date is not null
     and v_stop.route_date is not null
     and v_stop.route_date <> new.assigned_delivery_date then
    raise exception 'that stop is on a run for a different day' using errcode = 'P0001';
  end if;

  return new;
end $$;

-- ------------------------------------------------------------------- RLS -----
-- 0015 scoped a driver to the laundry sitting on their own *stops*. The
-- assignment now precedes the stop in the user's mind and can in principle
-- outlive it (a stop deleted sets `stop_id` null but must not make a driver's
-- own work vanish mid-morning), so the predicate gains the direct clause.
--
-- This is the same tightening 0015 made, widened by exactly one term. Office
-- roles keep full tenant visibility; a driver-only member sees a job when it is
-- assigned to them *or* sits on a stop of their run. No other role's predicate
-- changes.
drop policy laundry_orders_access on public.laundry_orders;
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
  );

-- CLAUDE.md §7: PostgREST publishes `public` as RPC, so a function executable by
-- `anon` is an unauthenticated endpoint. `create or replace` keeps the existing
-- ACL, but restate the posture so a future replace cannot quietly reopen it.
revoke all on function public.guard_laundry_order_transition() from public, anon;
revoke all on function public.guard_laundry_order_assignment() from public, anon;

do $$
begin
  if has_function_privilege('anon', 'public.guard_laundry_order_assignment()', 'EXECUTE')
     or has_function_privilege('anon', 'public.guard_laundry_order_transition()', 'EXECUTE') then
    raise exception 'anon can still execute a laundry order guard' using errcode = 'P0001';
  end if;
end $$;
