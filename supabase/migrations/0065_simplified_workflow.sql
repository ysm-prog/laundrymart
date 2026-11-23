-- ============================================================================
-- 0065_simplified_workflow — a new laundry job can be finished on save.
--
-- The client's change request 3 (2026-11-23): ATS is not yet running rounds or
-- deliveries through the app, so the route from taking laundry in to invoicing
-- it is Create Laundry → Completed → Create Invoice → Send Invoice, with no
-- driver, no round and no delivery stage in between. The app does this behind
-- a setting, `tenants.settings.operations.workflow` (Settings › How you work):
--
--   * `simplified` — the default, and what an absent key means: `createOrder`
--     completes a new job as it is saved, and the counter may mark a delivery
--     job delivered straight from the plant;
--   * `full` — the original process, unchanged: a delivery job goes onto a
--     round and out before it is completed.
--
-- The half that lives here is **0042's rule 4**, which refused completing a
-- delivery job that had not gone out. Without this the simplified workflow
-- could only ever complete customer pickups — the database is the boundary,
-- so the setting has to be read where the rule is.
--
-- **Rebuilt from 0042's body, the latest ancestor** (0055 and 0056 add their
-- own triggers and leave this function alone — checked, not assumed), with
-- rule 4's condition the only change. 0017's billing hooks, 0031's board
-- clearing and 0042's other three rules are carried through verbatim, and the
-- assertions below check the two hooks survived, which is the trap 0031 and
-- 0042 both record.
--
-- Nothing about the full workflow is removed: no stage, column, constraint,
-- trigger or policy is dropped, and a laundry that sets `full` gets exactly
-- 0042's behaviour. **Changes no row**: no existing job's status moves; the
-- rule only permits a move somebody then makes.
--
-- Adds no table, column, function, policy or capability.
-- ============================================================================

create or replace function public.guard_laundry_order_transition()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status is not distinct from old.status then return new; end if;

  -- Rule: terminal. The message is 0016's, word for word, because it is the one
  -- an operator may already have seen and `laundry_orders.test.sql` asserts it.
  if old.status in ('completed', 'cancelled') then
    raise exception 'a job cannot go from % to %', old.status, new.status
      using errcode = 'P0001';
  end if;

  -- Rule 1.
  if new.status in ('assigned','out_for_delivery') and not new.delivery_required then
    raise exception 'this job is a customer pickup, so it is never sent out on a run'
      using errcode = 'P0001';
  end if;

  -- Rule 2. Said as "not ready yet" rather than as "you cannot go from here",
  -- because that is the actual objection: the laundry is still being done.
  if new.status = 'assigned' and old.status <> 'ready_for_delivery' then
    raise exception 'a job is marked ready for delivery before it is given to a round'
      using errcode = 'P0001';
  end if;

  -- Rule 3.
  if new.status = 'out_for_delivery' and old.status <> 'assigned' then
    raise exception 'a delivery job is assigned to a round before it goes out'
      using errcode = 'P0001';
  end if;

  -- Rule 4. 0016's message, unchanged for the same reason as the terminal one.
  --
  -- **Relaxed by 0065 in the simplified workflow, and only from the plant.** A
  -- laundry that does not run deliveries through the app completes a delivery
  -- job straight off the shelf. A job already on a round still has to go out
  -- first: then the round is in use, and its run sheet would show a call that
  -- was never left for. The setting is read only when this rule would refuse,
  -- so no other move pays for the lookup. An absent key means simplified — the
  -- app's own default (`parseOperations`) — and a tenant row the caller cannot
  -- see means *not* simplified, so an unreadable setting refuses rather than
  -- permits.
  if new.status = 'completed' and new.delivery_required
     and old.status <> 'out_for_delivery'
     and not (
       old.status in ('new','in_progress','ready_for_delivery')
       and coalesce((
         select coalesce(t.settings->'operations'->>'workflow', 'simplified') = 'simplified'
           from public.tenants t where t.id = new.tenant_id
       ), false)
     ) then
    raise exception 'a delivery job must be assigned to a board and go out before it is completed'
      using errcode = 'P0001';
  end if;

  -- Taking a job back into the plant. Widened from 0031's single
  -- `assigned -> ready_for_delivery` edge to every move out of the two delivery
  -- stages into the three plant ones, because those are now all reachable — and
  -- without it `chk_laundry_orders_assignment_status` refuses the whole update:
  -- an assignment may only be held at `assigned`, `out_for_delivery`,
  -- `completed` or `cancelled`.
  --
  -- The columns are 0016's four plus 0031's board plus the load confirmation and
  -- the stop, exactly as 0031 cleared them. The *stop row* is not touched here:
  -- a trigger cannot know whether another job is still riding on it, so
  -- retiring an emptied stop stays the caller's job (`retireStopIfEmpty`), which
  -- is where Remove Assignment has always done it.
  if new.status in ('new','in_progress','ready_for_delivery')
     and old.status in ('assigned','out_for_delivery') then
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

-- `create or replace` drops the pinned `search_path` and re-grants EXECUTE, so
-- both are restated, `authenticated` named as well (the trap 0019 recorded and
-- 0036 shipped).
alter function public.guard_laundry_order_transition() set search_path = public;
revoke all on function public.guard_laundry_order_transition()
  from public, anon, authenticated;

-- ------------------------------------------------------- self-assertions ----
do $$
declare
  body text;
  n int;
begin
  select pg_get_functiondef('public.guard_laundry_order_transition()'::regprocedure)
    into body;

  if body not like '%awaiting_review%' then
    raise exception '0065: the completion billing hook was lost in the rebuild';
  end if;
  if body not like '%not_billable%' then
    raise exception '0065: the cancellation billing hook was lost in the rebuild';
  end if;
  if body not like '%assigned_board_id = null%' then
    raise exception '0065: taking a job off a round no longer clears the board';
  end if;
  -- The other three rules, by their messages.
  if body not like '%never sent out on a run%'
     or body not like '%before it is given to a round%'
     or body not like '%assigned to a round before it goes out%' then
    raise exception '0065: one of 0042''s other rules was lost in the rebuild';
  end if;
  -- Rule 4 is still there, and now reads the workflow.
  if body not like '%go out before it is completed%' or body not like '%''workflow''%' then
    raise exception '0065: rule 4 is missing or does not read the workflow';
  end if;

  if has_function_privilege('anon', 'public.guard_laundry_order_transition()', 'execute')
     or has_function_privilege('authenticated', 'public.guard_laundry_order_transition()', 'execute')
  then
    raise exception '0065: the transition guard is on the RPC surface';
  end if;

  select count(*) into n from pg_trigger tg
   where tg.tgrelid = 'public.laundry_orders'::regclass
     and tg.tgname = 'guard_laundry_orders_transition'
     and (tg.tgtype & 1) > 0 and (tg.tgtype & 2) > 0 and (tg.tgtype & 16) > 0;
  if n <> 1 then
    raise exception '0065: the transition guard is not attached to laundry_orders on UPDATE';
  end if;

  if (select prosecdef from pg_proc
       where oid = 'public.guard_laundry_order_transition()'::regprocedure) then
    raise exception '0065: the transition guard must stay SECURITY INVOKER';
  end if;
end $$;
