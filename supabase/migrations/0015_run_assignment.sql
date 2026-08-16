-- ============================================================================
-- 0015_run_assignment — put a counter job on a driver's run.
--
-- The one link the schema was missing. Before this, `laundry_orders` (the
-- counter's Job) and `daily_routes`/`jobs` (the Run and its Stops) were two
-- islands: a job could be marked "out for delivery" with nothing anywhere
-- recording *whose van* it went out on, and a driver's screen could show the
-- stops of a run without showing the laundry those stops exist to deliver.
--
-- **One column, and it is a relationship rather than a status.** A Job points at
-- a Stop; the Stop already knows its Run; the Run already knows its Driver. So
-- the chain is
--
--     laundry_orders.stop_id → jobs.route_id → daily_routes.driver_id
--
-- and there is deliberately no `driver_id` on `laundry_orders`. A second copy of
-- the answer is a second thing to keep in step, and the failure mode is the one
-- the brief names outright: the job says John, the run says Mark, and nothing in
-- the schema says which is true. Here the question has exactly one answer, and
-- reassigning a job is a single UPDATE of a single column.
--
-- Assignment does **not** touch `status`. A job that is ready for delivery is
-- still ready for delivery once it is on a run; what changed is where it is
-- going, not how far through the plant it is. The six statuses of 0014 are
-- untouched and nothing is added to them.
--
-- Nothing in 0001–0014 is dropped or rewritten. Two things are *narrowed*: the
-- activity vocabulary gains three verbs, and the read policy on the three
-- laundry tables gains a driver clause (see the RLS section for why that is a
-- tightening and not a change of behaviour).
-- ============================================================================

-- ------------------------------------------------------------ the link ------
alter table public.laundry_orders
  add column stop_id uuid references public.jobs(id) on delete set null;

comment on column public.laundry_orders.stop_id is
  'The stop on a driver''s run that will deliver this job. Null means unassigned. '
  'The authoritative dispatch relationship: driver and run date are read through '
  'jobs.route_id → daily_routes, never stored again here.';

-- A stop being deleted must not take the job with it, and must not leave the job
-- pointing at nothing — `on delete set null` above returns it to the unassigned
-- queue, which is exactly where a dispatcher needs to see it.

-- ------------------------------------------------------------- indexes ------
-- "What laundry is at this stop?" — the driver's screen, once per stop card.
create index idx_laundry_orders_stop on public.laundry_orders(stop_id)
  where stop_id is not null;

-- "What is ready to go out and on nobody's run?" — the dispatcher's queue and
-- the assignment dialog's eligibility list. Partial, because those are the only
-- rows either screen ever asks for, and it keeps the index a fraction of the
-- table.
create index idx_laundry_orders_unassigned on public.laundry_orders(tenant_id, due_date)
  where stop_id is null and delivery_required and status = 'ready_for_delivery';

-- My Runs reads stops by run in route order; 0004's idx_jobs_route(route_id,
-- sequence) already serves that. Runs by driver and date is idx_daily_routes_
-- driver(driver_id, route_date), also from 0004. Nothing new is needed for the
-- two hottest queries in this feature — which is the point of reusing the
-- existing tables rather than inventing a My Runs table beside them.

-- --------------------------------------------------- activity vocabulary ----
-- 0014's `assigned` means "handed to a member of staff" (`assigned_to`). Run
-- assignment is a different event about a different thing, so it gets its own
-- verbs rather than overloading that one — a timeline that cannot distinguish
-- "given to Sarah at the counter" from "put on John's van" is a timeline nobody
-- can answer a question with.
alter table public.laundry_order_activity
  drop constraint if exists laundry_order_activity_activity_type_check;
alter table public.laundry_order_activity
  add constraint laundry_order_activity_activity_type_check check (activity_type in (
    'created','status_changed','updated','items_changed','assigned',
    'delivered','collected','cancelled',
    'run_assigned','run_reassigned','run_removed'
  ));

-- ------------------------------------------------------- the eligibility ----
-- The rules of §21 of the brief, enforced where they cannot be talked around.
-- `src/lib/domain/run-assignment.ts` states the same rules in English so the
-- screen can explain itself before it posts; this is the boundary, because
-- anything holding a session and the anon key can PATCH the column directly.
--
-- Fires only when the assignment itself changes. A job being marked delivered
-- keeps its stop_id, so completing work never re-runs eligibility and can never
-- be refused by it.
create or replace function public.guard_laundry_order_assignment()
returns trigger language plpgsql set search_path = public as $$
declare v_stop record;
begin
  if tg_op = 'UPDATE' and new.stop_id is not distinct from old.stop_id then
    return new;
  end if;

  -- Removing a job from a run is always allowed: it is the undo, and refusing it
  -- would strand work on a van that is not going.
  if new.stop_id is null then return new; end if;

  -- A job the customer is collecting is not delivery work. This is the rule the
  -- brief is most insistent about, and it is checked before anything else
  -- because it is the one a well-meaning bulk assign would trip over.
  if not new.delivery_required then
    raise exception 'this job is a customer pickup, so it is not eligible for a delivery run'
      using errcode = 'P0001';
  end if;

  if new.status in ('new', 'in_progress') then
    raise exception 'this job is not ready for delivery yet'
      using errcode = 'P0001';
  end if;
  if new.status in ('completed', 'cancelled') then
    raise exception 'a % job cannot be put on a run', new.status
      using errcode = 'P0001';
  end if;

  select j.tenant_id, j.customer_id into v_stop
    from public.jobs j
   where j.id = new.stop_id and j.deleted_at is null;

  -- RLS on `jobs` applies inside this lookup, so another tenant's stop is not
  -- merely rejected — it is invisible, and lands here as "not found".
  if not found then
    raise exception 'that stop could not be found' using errcode = 'P0001';
  end if;
  if v_stop.tenant_id <> new.tenant_id then
    raise exception 'that stop belongs to another tenant' using errcode = 'P0001';
  end if;

  -- The grouping rule from §16: jobs gather under the stop for *their own*
  -- customer. Without this a job could be filed under a visit to a different
  -- business, and the driver would arrive somewhere holding the wrong linen.
  if v_stop.customer_id <> new.customer_id then
    raise exception 'that stop is a visit to a different customer'
      using errcode = 'P0001';
  end if;

  return new;
end $$;

create trigger guard_laundry_orders_assignment
  before insert or update on public.laundry_orders
  for each row execute procedure public.guard_laundry_order_assignment();

-- ------------------------------------------------------------------- RLS ----
-- 0014 gave these three tables plain tenant policies, which was right at the
-- time: no driver capability reached the module, so no driver had a screen that
-- read them. My Runs changes that — a driver now has a reason to read the
-- laundry at their own stops — and a tenant-wide policy would hand them every
-- job in the business through PostgREST at the same moment.
--
-- So the policies are narrowed the way §3 narrows every other driver-facing
-- table: office roles keep full tenant visibility, and a *driver-only* member
-- sees a job exactly when it sits on a stop of a run that is theirs. For every
-- non-driver role the predicate is unchanged, and drivers could not open
-- `/orders` before this migration and still cannot — this closes the REST
-- surface, it does not open a screen.
drop policy laundry_orders_member on public.laundry_orders;
create policy laundry_orders_access on public.laundry_orders for all to authenticated
  using (
    (select public.is_member(tenant_id))
    and (
      not (select public.is_driver_only(tenant_id))
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
      or exists (
        select 1
          from public.jobs j
          join public.daily_routes r on r.id = j.route_id
         where j.id = laundry_orders.stop_id
           and r.driver_id = (select public.current_driver_id(laundry_orders.tenant_id))
      )
    )
  );

-- Children scope through the parent, the same shape 0004 uses for pickups and
-- deliveries: the subquery is subject to `laundry_orders`' own policy, so a
-- driver reaching for another driver's laundry list finds no parent row and
-- therefore no items.
drop policy laundry_order_items_member on public.laundry_order_items;
create policy laundry_order_items_access on public.laundry_order_items for all to authenticated
  using ((select public.is_member(tenant_id))
         and exists (select 1 from public.laundry_orders o where o.id = order_id))
  with check ((select public.is_member(tenant_id))
         and exists (select 1 from public.laundry_orders o where o.id = order_id));

drop policy laundry_order_activity_member on public.laundry_order_activity;
create policy laundry_order_activity_access on public.laundry_order_activity for all to authenticated
  using ((select public.is_member(tenant_id))
         and exists (select 1 from public.laundry_orders o where o.id = order_id))
  with check ((select public.is_member(tenant_id))
         and exists (select 1 from public.laundry_orders o where o.id = order_id));

-- CLAUDE.md §7: PostgREST publishes `public` as RPC, so a function executable by
-- `anon` is an unauthenticated endpoint. This one is a trigger and is called by
-- nobody directly; it is closed explicitly all the same.
revoke all on function public.guard_laundry_order_assignment() from public, anon;
