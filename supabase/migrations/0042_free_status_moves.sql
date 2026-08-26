-- ============================================================================
-- 0042_free_status_moves — a job's stage is picked, not walked.
--
-- Until now `guard_laundry_order_transition` held a linear table: a job could
-- take exactly one step, forwards, and `assigned -> ready_for_delivery` was the
-- single exception. That was the right shape while the job page offered one
-- button at a time, and it is the wrong shape for the status track this ships
-- with — the owner's decision (2026-08-26) is that the stages are pickable in
-- any order and in either direction. A counter hand who marked a job ready by
-- mistake puts it back; a job that never needed the middle stage skips it.
--
-- **Four rules survive, and they are the four that are about the job's own facts
-- rather than about the order things happened in.** Each is a sentence:
--
--   1. a customer pickup never reaches `assigned` or `out_for_delivery` — it has
--      no delivery to be on (unchanged, and the check constraints say it too);
--   2. a job still in the plant is not given to a delivery round, which is the
--      same rule `guard_laundry_order_assignment` and `checkAssignable` already
--      state, said in the one place a status can be picked;
--   3. a delivery job is assigned before it goes out, or it is out on nobody's
--      van and invisible to My Runs;
--   4. a delivery job goes out before it is completed, or its delivery record is
--      an account of something that did not happen.
--
-- **`completed` and `cancelled` stay terminal**, and that was asked and answered
-- rather than assumed: a job that finished and then reopened is two accounts of
-- the same work, and by then 0017's hook has moved it to `awaiting_review`, it
-- may carry a frozen `job_charge_snapshots` row, and 0040's running draft may
-- already have billed it on a document the customer has been sent.
--
-- **This is 0031's function, not 0016's or 0017's, and the difference matters.**
-- `create or replace` takes whatever body it is given, so rebuilding from an
-- older ancestor silently drops what the ones after it added — 0017's billing
-- hooks (completing sets `awaiting_review`, cancelling sets `not_billable`) and
-- 0031's board clearing. Both are carried through below verbatim, which is the
-- trap 0031's own header records and `job_billing.test.sql` caught.
--
-- Adds no table, no column, no policy, no function and no capability; drops
-- nothing, and changes no row.
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
  if new.status = 'completed' and new.delivery_required
     and old.status <> 'out_for_delivery' then
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
-- both are restated. `authenticated` is named in the revoke as well as
-- `public, anon`: a hosted Supabase project hands each new function a *direct*
-- grant to both roles, which `revoke ... from public` leaves standing — the trap
-- 0019 recorded and 0036 shipped. This one is SECURITY INVOKER, so it could only
-- ever error on the RPC surface, which is exactly why it should not be there.
alter function public.guard_laundry_order_transition() set search_path = public;
revoke all on function public.guard_laundry_order_transition()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Self-assertions. `apply_migration` is atomic, so a failure here rolls the
-- whole file back rather than leaving the guard half-replaced.
-- ---------------------------------------------------------------------------
do $$
declare
  body text;
  v_tenant uuid;
  v_customer uuid;
  v_board uuid;
  v_job uuid;
  n int;
  refused boolean;
begin
  select pg_get_functiondef('public.guard_laundry_order_transition()'::regprocedure)
    into body;

  -- 1. The two hooks a rebuild from an older ancestor would have dropped. This
  --    is the assertion that exists because it has already happened once.
  if body not like '%awaiting_review%' then
    raise exception '0042: the completion billing hook was lost in the rebuild';
  end if;
  if body not like '%not_billable%' then
    raise exception '0042: the cancellation billing hook was lost in the rebuild';
  end if;

  -- 2. 0031's board clearing survived, and now covers `out_for_delivery` too.
  if body not like '%assigned_board_id = null%' then
    raise exception '0042: Remove Assignment no longer clears the board';
  end if;

  -- 3. 0029's posture, and the trigger-function half of it 0036 got wrong.
  if has_function_privilege('anon', 'public.guard_laundry_order_transition()', 'execute')
     or has_function_privilege('authenticated', 'public.guard_laundry_order_transition()', 'execute')
  then
    raise exception '0042: the transition guard is on the RPC surface';
  end if;

  -- 4. Still attached, and still a row-level BEFORE UPDATE trigger. Read out of
  --    the catalogue under the *trigger's* name rather than the function's — the
  --    2026-08-26 conformance sweep records a probe that looked for the wrong
  --    one and wrongly reported a live trigger missing. `tgtype` bits, since
  --    they are easy to get backwards and this assertion caught exactly that
  --    while it was being written: 1 = row-level, 2 = BEFORE, 16 = UPDATE.
  select count(*) into n from pg_trigger tg
   where tg.tgrelid = 'public.laundry_orders'::regclass
     and tg.tgname = 'guard_laundry_orders_transition'
     and (tg.tgtype & 1) > 0      -- row-level, not statement-level
     and (tg.tgtype & 2) > 0      -- BEFORE, not AFTER
     and (tg.tgtype & 16) > 0;    -- UPDATE
  if n <> 1 then
    raise exception '0042: the transition guard is not attached to laundry_orders on UPDATE';
  end if;

  -- ---------------------------------------------------------- behaviourally --
  -- Against real rows, in this transaction, undone before the block ends.
  --
  -- **It reuses a laundry rather than creating one**, because `0041` refuses a
  -- second `tenants` insert wherever the single-laundry switch is on — which is
  -- the live project. A fresh database has no laundry at all and skips this,
  -- loudly: the standing behavioural proof of this guard is
  -- `supabase/tests/laundry_orders.test.sql`, which builds its own two laundries
  -- and runs as real sessions in the same CI job that applies this file.
  select id into v_tenant from public.tenants
   where deleted_at is null order by created_at limit 1;
  if v_tenant is null then
    raise notice '0042: no laundry to probe against — laundry_orders.test.sql proves this guard';
    return;
  end if;

  v_customer := gen_random_uuid();
  v_board    := gen_random_uuid();
  v_job      := gen_random_uuid();

  -- `boards.depot_id` is nullable, so nothing else has to be borrowed or made.
  insert into public.customers (id, tenant_id, customer_number, business_name)
    values (v_customer, v_tenant, '0042-probe', '0042 probe customer');
  insert into public.boards (id, tenant_id, code, name, status)
    values (v_board, v_tenant, '0042PROBE', '0042 probe board', 'active');
  insert into public.laundry_orders
    (id, tenant_id, customer_id, order_number, status, delivery_required,
     expected_delivery_date)
    values (v_job, v_tenant, v_customer, 'LJ0042-probe', 'new', true, current_date + 1);

  -- Forwards two stages at once — the move the old table refused outright.
  update public.laundry_orders set status = 'ready_for_delivery' where id = v_job;

  -- And straight back to the beginning.
  update public.laundry_orders set status = 'new' where id = v_job;
  select count(*) into n from public.laundry_orders where id = v_job and status = 'new';
  if n <> 1 then
    raise exception '0042: a job could not be moved back to new';
  end if;

  -- Rule 2, which is what stops "any stage" meaning "hand unwashed laundry to a
  -- round". Proved by trying it rather than by reading the body above.
  refused := false;
  begin
    update public.laundry_orders
       set status = 'assigned', assigned_board_id = v_board,
           assigned_delivery_date = current_date + 1
     where id = v_job;
  exception when raise_exception then refused := true;
  end;
  if not refused then
    raise exception '0042: a job still in the plant was given to a round';
  end if;

  -- The clearing, on a move the old guard had no edge for at all:
  -- `out_for_delivery` back into the plant.
  update public.laundry_orders set status = 'ready_for_delivery' where id = v_job;
  update public.laundry_orders
     set status = 'assigned', assigned_board_id = v_board,
         assigned_delivery_date = current_date + 1
   where id = v_job;
  update public.laundry_orders set status = 'out_for_delivery' where id = v_job;
  update public.laundry_orders set status = 'in_progress' where id = v_job;
  select count(*) into n from public.laundry_orders
   where id = v_job and assigned_board_id is null and assigned_delivery_date is null
     and assigned_at is null and stop_id is null;
  if n <> 1 then
    raise exception '0042: coming off a round did not clear the assignment';
  end if;

  -- Rule 4 still holds: a delivery job cannot be finished off the shelf.
  refused := false;
  begin
    update public.laundry_orders set status = 'completed' where id = v_job;
  exception when raise_exception then refused := true;
  end;
  if not refused then
    raise exception '0042: a delivery job was completed without going out';
  end if;

  -- Terminal, from a stage the old table could not even reach directly.
  update public.laundry_orders set status = 'cancelled' where id = v_job;
  refused := false;
  begin
    update public.laundry_orders set status = 'in_progress' where id = v_job;
  exception when raise_exception then refused := true;
  end;
  if not refused then
    raise exception '0042: a cancelled job was reopened';
  end if;

  delete from public.laundry_orders where id = v_job;
  delete from public.boards where id = v_board;
  delete from public.customers where id = v_customer;

  select count(*) into n from public.laundry_orders where id = v_job;
  if n <> 0 then
    raise exception '0042: the probe job outlived the probe';
  end if;
end $$;
