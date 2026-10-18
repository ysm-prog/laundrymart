-- ============================================================================
-- 0056_flow_runs_itself — the database halves of Darshan's BA review, Phase 2
-- (18 October 2026): "make the flow run itself".
--
-- Six changes, one file for the reason 0055 gave: none stands alone, and all of
-- them must be on the hosted project before the code that reads them merges.
--
--   1. **A finished delivery finishes its stop, and a run whose stops are all
--      done is on its way back** (brief 2.1, gaps G6/G7). After LJ00032 was
--      delivered, Today read "Stops 0/1, 1 remaining", Runs read "Already worked
--      0" and offered to move it, and `JOB00025` stayed `assigned`: nothing in
--      the schema connected the laundry job to the stop it sits on once the van
--      was out. `sync_stop_on_order_finish` is an AFTER UPDATE trigger on
--      `laundry_orders`, so it runs **in the same transaction as the delivery,
--      whichever screen recorded it** — My Runs, the counter's completion form,
--      or anything that writes the row. A stop is completed when every live job
--      on it is finished and at least one was delivered; a stop that also
--      expects a collection which has not been captured is marked
--      `delivery_completed` instead, because half a visit is not a visit. When
--      the last open stop on an `in_progress` run finishes, the run moves to
--      `returning` — the honest state (every call made, van heading back) and
--      the one the depot screen's Unload → Close already follows. Nothing here
--      closes a run: closing needs the unload (`guard_route_transition`), which
--      is what sweeps rental linen back into stock.
--      SECURITY DEFINER because a round's session may finish its own job yet
--      should not need write access to a stop or run row to make them agree;
--      it reads and writes only rows sharing the job's own `tenant_id`.
--
--   2. **The backfill for (1), and the one part of this file that changes
--      existing rows.** Every open stop whose jobs are all finished is
--      completed, with the latest delivery time as its `completed_at`; every
--      `in_progress` run left with no open stop moves to `returning`. On the
--      live project that is at least `JOB00025` (LJ00032's stop).
--
--   3. **What a delivery proves** (brief 2.4, gaps G8/G23). On `laundry_orders`:
--      who received it, the signature and photo object keys (in the private
--      `run-media` bucket, 0007, under this job's own folder), the delivered
--      count per line, a short-delivery flag, and **which board and which
--      driver** delivered it — not only the signed-in login, which for a round
--      is a shared one. `deliveries`/`delivery_lines` were considered and do
--      not fit: every row there is the record of a `move_inventory()` call
--      against rental stock, `delivery_lines.item_id` is required while a
--      laundry job's row may name no item, and a customer's own linen moving
--      home is not a stock movement. So the proof sits on the job it proves.
--
--   4. **`customers.auto_approve`** (brief 2.3), default true: whether a job
--      priced cleanly for this customer may be approved without a person. The
--      tenant switch is `settings.automation.autoApproveCleanJobs`; both must
--      be on.
--
--   5. **`save_tenant_settings` accepts the `automation` key** — rebuilt from
--      0055's body, the only definition since, with the one key added.
--
--   6. **A round can write its own job's timeline.** 0034 restated 0025's
--      restrictive insert on `laundry_order_activity` as office roles only, so
--      every activity row a board or driver wrote — "delivered" included — was
--      refused, and `logOrderActivity` swallows the error by design. The job
--      page has therefore never shown who delivered a round's job. The insert
--      policy now also admits a job assigned to the caller's own board or
--      driver record. UPDATE and DELETE are untouched.
--
-- RLS: one restrictive policy rewritten (6); nothing else. The trigger function
-- is revoked from `public, anon` **and `authenticated`** (the trap 0019
-- recorded and 0036 shipped), so it is never on `/rest/v1/rpc/…`.
--
-- **Written, NOT applied to `laundrymart-syd`.** Apply after 0053–0055 and
-- before the code merges: My Runs and the job pages select the proof columns,
-- the billing card writes `auto_approve`, and Settings › Automation calls the
-- widened writer.
-- ============================================================================

-- ------------------------------------------------- 3. what a delivery proves ---
alter table public.laundry_orders
  add column if not exists delivery_received_by text,
  add column if not exists delivery_signature_path text,
  add column if not exists delivery_photo_paths text[] not null default '{}',
  add column if not exists delivery_short boolean not null default false,
  add column if not exists delivery_quantities jsonb,
  add column if not exists delivered_board_id uuid references public.boards(id) on delete set null,
  add column if not exists delivered_driver_id uuid references public.drivers(id) on delete set null;

alter table public.laundry_orders drop constraint if exists chk_laundry_orders_delivery_received_by;
alter table public.laundry_orders add constraint chk_laundry_orders_delivery_received_by
  check (delivery_received_by is null or char_length(delivery_received_by) <= 120);

alter table public.laundry_orders drop constraint if exists chk_laundry_orders_delivery_quantities;
alter table public.laundry_orders add constraint chk_laundry_orders_delivery_quantities
  check (delivery_quantities is null or jsonb_typeof(delivery_quantities) = 'array');

-- The keys live under this job's own folder in this laundry's tenant segment.
-- The app checks the same thing before writing (`isDeliveryProofPath`); this
-- is the boundary under it, so a path naming another tenant's evidence cannot
-- be stored however the row is written.
alter table public.laundry_orders drop constraint if exists chk_laundry_orders_delivery_proof_paths;
alter table public.laundry_orders add constraint chk_laundry_orders_delivery_proof_paths
  check (
    (delivery_signature_path is null
      or delivery_signature_path like tenant_id::text || '/delivery/' || id::text || '/%')
    and coalesce(array_length(delivery_photo_paths, 1), 0) <= 4
  );

comment on column public.laundry_orders.delivery_received_by is
  'Who took the laundry at the door, as the round typed it (brief 2.4).';
comment on column public.laundry_orders.delivery_signature_path is
  'Object key of the signature PNG in the private run-media bucket.';
comment on column public.laundry_orders.delivery_photo_paths is
  'Object keys of up to four delivery photos in the private run-media bucket.';
comment on column public.laundry_orders.delivery_short is
  'True when the round delivered less than was taken in, or said so.';
comment on column public.laundry_orders.delivery_quantities is
  'What was handed over, per laundry row: [{item_row_id, description, taken_in, delivered}].';
comment on column public.laundry_orders.delivered_board_id is
  'The round that delivered it. With delivered_driver_id, the answer to "who had it".';
comment on column public.laundry_orders.delivered_driver_id is
  'The person operating that round on the day (daily_routes.operated_by_driver_id).';

-- ---------------------------------------------------- 4. customers.auto_approve ---
alter table public.customers
  add column if not exists auto_approve boolean not null default true;
comment on column public.customers.auto_approve is
  'Whether a job priced entirely from this customer''s rate card or the price list '
  'may be approved without a person (brief 2.3). The tenant switch must be on too.';

-- ------------------------------------------------- 5. the automation settings ---
create or replace function public.save_tenant_settings(t uuid, p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(t, array['super_admin']) then
    raise exception 'only the owner can change these settings' using errcode = '42501';
  end if;
  if p_key not in ('notifications', 'invoiceProfile', 'receivables', 'automation') then
    raise exception 'that is not a setting this screen may change' using errcode = '22023';
  end if;
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'settings must be an object' using errcode = '22023';
  end if;
  update public.tenants
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
   where id = t;
end $$;

revoke all on function public.save_tenant_settings(uuid, text, jsonb) from public, anon;
grant execute on function public.save_tenant_settings(uuid, text, jsonb) to authenticated;

-- ------------------------------------- 1. a finished job finishes its stop ---
create or replace function public.sync_stop_on_order_finish()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_stop public.jobs%rowtype;
  v_open integer;
  v_done integer;
  v_last timestamptz;
  v_collected boolean;
begin
  if new.stop_id is null
     or new.status is not distinct from old.status
     or new.status not in ('completed', 'cancelled') then
    return null;
  end if;

  select * into v_stop
    from public.jobs
   where id = new.stop_id and tenant_id = new.tenant_id and deleted_at is null;
  if not found or v_stop.status in ('completed', 'cancelled') then
    return null;
  end if;

  select count(*) filter (where status not in ('completed', 'cancelled')),
         count(*) filter (where status = 'completed'),
         max(completed_at) filter (where status = 'completed')
    into v_open, v_done, v_last
    from public.laundry_orders
   where stop_id = v_stop.id and tenant_id = new.tenant_id;

  -- Work still to hand over, or nothing was ever delivered here (every job on
  -- it cancelled — `retireStopIfEmpty` tidies that case).
  if v_open > 0 or v_done = 0 then
    return null;
  end if;

  v_collected := v_stop.service_type = 'delivery'
    or exists (select 1 from public.pickups p
                where p.job_id = v_stop.id and p.tenant_id = new.tenant_id);

  if not v_collected then
    -- The delivery half of a visit that also expects a collection. Recorded,
    -- and left open, so the round still sees the collection to make.
    update public.jobs
       set progress_status = 'delivery_completed'
     where id = v_stop.id
       and progress_status in ('not_started', 'travelling', 'at_customer');
    return null;
  end if;

  update public.jobs
     set status = 'completed',
         progress_status = 'completed',
         completed_at = coalesce(completed_at, v_last, now())
   where id = v_stop.id;

  if v_stop.route_id is not null and not exists (
    select 1 from public.jobs
     where route_id = v_stop.route_id and tenant_id = new.tenant_id
       and deleted_at is null and status not in ('completed', 'cancelled')
  ) then
    update public.daily_routes
       set status = 'returning',
           returned_at = coalesce(returned_at, now())
     where id = v_stop.route_id and tenant_id = new.tenant_id
       and status = 'in_progress';
  end if;

  return null;
end $$;

revoke all on function public.sync_stop_on_order_finish() from public, anon, authenticated;

drop trigger if exists sync_laundry_orders_stop on public.laundry_orders;
create trigger sync_laundry_orders_stop
  after update of status on public.laundry_orders
  for each row
  when (new.stop_id is not null and old.status is distinct from new.status)
  execute procedure public.sync_stop_on_order_finish();

-- --------------------------------------------------------------- 2. backfill ---
with finished as (
  select j.id, max(o.completed_at) filter (where o.status = 'completed') as last_at
    from public.jobs j
    join public.laundry_orders o on o.stop_id = j.id and o.tenant_id = j.tenant_id
   where j.deleted_at is null
     and j.status not in ('completed', 'cancelled')
     and (j.service_type = 'delivery'
          or exists (select 1 from public.pickups p where p.job_id = j.id))
   group by j.id
  having count(*) filter (where o.status not in ('completed', 'cancelled')) = 0
     and count(*) filter (where o.status = 'completed') > 0
)
update public.jobs j
   set status = 'completed',
       progress_status = 'completed',
       completed_at = coalesce(j.completed_at, finished.last_at, now())
  from finished
 where j.id = finished.id;

update public.daily_routes r
   set status = 'returning',
       returned_at = coalesce(r.returned_at, now())
 where r.status = 'in_progress'
   and r.deleted_at is null
   and exists (select 1 from public.jobs j where j.route_id = r.id and j.deleted_at is null)
   and not exists (
     select 1 from public.jobs j
      where j.route_id = r.id and j.deleted_at is null
        and j.status not in ('completed', 'cancelled'));

-- ------------------------------------ 6. a round writes its own job's timeline ---
drop policy if exists laundry_order_activity_main_flow_insert on public.laundry_order_activity;
create policy laundry_order_activity_main_flow_insert on public.laundry_order_activity
  as restrictive for insert to authenticated
  with check (
    (select public.has_role(tenant_id,
       array['super_admin', 'operations_manager', 'customer_service']))
    or exists (
      select 1 from public.laundry_orders o
       where o.id = laundry_order_activity.order_id
         and o.tenant_id = laundry_order_activity.tenant_id
         and (o.assigned_board_id = (select public.current_board_id(o.tenant_id))
              or o.assigned_driver_id = (select public.current_driver_id(o.tenant_id))))
  );

-- ------------------------------------------------------- self-assertions ----
do $$
declare v_missing text;
begin
  select string_agg(c, ', ') into v_missing
    from unnest(array['delivery_received_by', 'delivery_signature_path', 'delivery_photo_paths',
                      'delivery_short', 'delivery_quantities', 'delivered_board_id',
                      'delivered_driver_id']) as c
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'laundry_orders'
                        and column_name = c);
  if v_missing is not null then
    raise exception '0056: laundry_orders is missing %', v_missing using errcode = 'P0001';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'customers'
                    and column_name = 'auto_approve' and is_nullable = 'NO'
                    and column_default = 'true') then
    raise exception '0056: customers.auto_approve is missing or not defaulted on' using errcode = 'P0001';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.laundry_orders'::regclass
                    and tgname = 'sync_laundry_orders_stop' and not tgisinternal) then
    raise exception '0056: the stop trigger is not attached' using errcode = 'P0001';
  end if;

  if not (select prosecdef from pg_proc where oid = 'public.sync_stop_on_order_finish()'::regprocedure) then
    raise exception '0056: sync_stop_on_order_finish must be SECURITY DEFINER' using errcode = 'P0001';
  end if;

  if has_function_privilege('authenticated', 'public.sync_stop_on_order_finish()', 'EXECUTE')
     or has_function_privilege('anon', 'public.sync_stop_on_order_finish()', 'EXECUTE') then
    raise exception '0056: a trigger function is callable as RPC' using errcode = 'P0001';
  end if;

  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'laundry_order_activity'
                    and policyname = 'laundry_order_activity_main_flow_insert'
                    and permissive = 'RESTRICTIVE'
                    and with_check like '%customer_service%'
                    and with_check like '%current_board_id%') then
    raise exception '0056: the activity insert policy lost the counter or the round' using errcode = 'P0001';
  end if;

  if has_table_privilege('anon', 'public.laundry_orders', 'SELECT') then
    raise exception '0056: anon holds a grant on laundry_orders' using errcode = 'P0001';
  end if;
end $$;
