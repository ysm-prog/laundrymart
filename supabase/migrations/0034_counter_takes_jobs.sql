-- ============================================================================
-- 0034 — the counter may take laundry in again
--
-- The owner's decision, 2026-08-24, reversing the `orders.*` half of
-- 2026-08-16. That decision made job→invoice one flow answering to the Owner
-- and the Office manager, which is coherent — but its effect was that a laundry
-- wanting counter staff to book jobs had to make them **Office manager**: 31
-- screens, the whole ledger, the plant and the activity log, handed to the
-- least-trained person in the building to do the one job their role is named
-- for. `customer_service` gets `orders.read/write/status` back in `roles.ts`,
-- and this migration is the half without which that change does nothing good.
--
-- ## Why a migration is not optional here
--
-- `roles.ts` drives the nav and the page guards. It is **not** the boundary.
-- `0025` put *restrictive* write policies on the nine job→invoice tables
-- narrowing INSERT/UPDATE/DELETE to `super_admin` and `operations_manager`, and
-- a restrictive policy ANDs with the permissive one — so a counter hand with
-- the capability but not the policy opens the form, fills it in, presses Save
-- and writes **zero rows with no error at all**. Not a refusal: a silence.
--
-- That exact failure has shipped in this project twice. 0025's own comment
-- records a local probe finding it for the driver, and 0031 records it again
-- for boards — a board could not complete its own delivery and the job sat at
-- `out_for_delivery` for ever. `lives_ok` passed throughout both times, which
-- is the shape of the bug: the statement succeeds, it just touches nothing.
-- `main_flow_scope.test.sql` therefore asserts the write **landed**, by
-- counting the row afterwards, not that it failed to raise.
--
-- ## What this does and deliberately does not do
--
-- Widens the restrictive layer on **three** tables — `laundry_orders`,
-- `laundry_order_items`, `laundry_order_activity`. That is the counter's job
-- and everything hanging off it.
--
-- It leaves the other six of 0025's nine exactly as they are: `invoices`,
-- `invoice_lines`, `payments`, `credit_notes`, `credit_note_lines` and
-- `laundry_prices`. Billing did not move and neither did the price list — the
-- counter can take laundry in and cannot see, raise or alter a bill for it.
--
-- `orders.manage` is not granted either, in `roles.ts` or here: cancelling a
-- job, backdating a receipt and editing a completed one are the supervisor's
-- set, and none of them is part of taking laundry in. Those are refused by
-- `assertCapability()` in the action rather than by a policy, because they are
-- verbs on the same table this now admits.
--
-- Adds no table, no column and no function. Changes no row.
-- ============================================================================

-- ------------------------------------------------ the three job tables -------
-- `laundry_orders` carries the wider predicate: the driver and board carve-outs
-- 0025 and 0031 added, restated in full because these are restrictive policies
-- and there is no existing clause to wrap — 0028's archive wrapper deliberately
-- never touched them. Dropping either carve-out here would silently re-break
-- exactly what 0031 was written to fix, so they are reproduced verbatim and the
-- assertion block below checks all three names are still in the predicate.
do $$
declare
  v_roles constant text :=
    'array[''super_admin'',''operations_manager'',''customer_service'']';

  -- The two child tables: role only. Neither is written by a driver or a board
  -- directly — `save_laundry_order_items()` is SECURITY INVOKER and runs as the
  -- office, and the activity rows are written beside the parent update.
  v_child_predicate constant text :=
    '(select public.has_role(tenant_id, ' || v_roles || '))';

  v_orders_predicate constant text := '('
    || '(select public.has_role(laundry_orders.tenant_id, ' || v_roles || '))'
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

  -- DELETE is the one verb the counter does **not** get on the job itself.
  --
  -- Nothing in the app deletes a `laundry_orders` row: cancelling is a status
  -- change (the transition guard makes `cancelled` terminal) and hiding one is
  -- `set_records_archived`. So a counter hand has no path to it, and granting a
  -- verb nobody uses is how a role quietly becomes wider than its job.
  --
  -- `laundry_order_items` is the exception and genuinely needs it:
  -- `save_laundry_order_items()` replaces the child set by deleting and
  -- re-inserting inside one transaction, and it is SECURITY INVOKER — so the
  -- delete runs as whoever is editing the job. Without this the counter can
  -- take a job in and never correct what is on it.
  v_delete_roles constant text[] := array['laundry_order_items'];

  v_table text;
  v_predicate text;
  v_delete_predicate text;
begin
  foreach v_table in array array[
    'laundry_orders', 'laundry_order_items', 'laundry_order_activity'
  ] loop
    if to_regclass('public.' || v_table) is null then
      raise exception '0034: % is missing', v_table using errcode = 'P0001';
    end if;

    v_predicate := case when v_table = 'laundry_orders'
                        then v_orders_predicate else v_child_predicate end;

    -- The counter is dropped from the DELETE predicate everywhere except the
    -- item rows, which leaves those two policies exactly as 0025/0031 wrote
    -- them.
    v_delete_predicate := case
      when v_table = any (v_delete_roles) then v_predicate
      when v_table = 'laundry_orders' then replace(
        v_orders_predicate, ',''customer_service''', '')
      else '(select public.has_role(tenant_id,'
           || ' array[''super_admin'',''operations_manager'']))'
    end;

    execute format(
      'drop policy if exists %I on public.%I', v_table || '_main_flow_insert', v_table);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated
         with check (%s)', v_table || '_main_flow_insert', v_table, v_predicate);

    execute format(
      'drop policy if exists %I on public.%I', v_table || '_main_flow_update', v_table);
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated
         using (%s) with check (%s)',
      v_table || '_main_flow_update', v_table, v_predicate, v_predicate);

    execute format(
      'drop policy if exists %I on public.%I', v_table || '_main_flow_delete', v_table);
    execute format(
      'create policy %I on public.%I as restrictive for delete to authenticated
         using (%s)', v_table || '_main_flow_delete', v_table, v_delete_predicate);
  end loop;
end $$;

-- ------------------------------------------------- assert the outcome --------
-- Fail rather than half-apply. Three things have been wrong here before: a
-- restrictive policy that silently refused the actor who needed it (0025 for
-- the driver, 0031 for the board), a policy rewrite that dropped a clause it
-- was meant to preserve (0028), and a widening that reached further than it
-- meant to.
do $$
declare
  v_missing text;
  v_leaked text;
begin
  -- 1. The counter reaches the three job tables.
  select string_agg(t.name || '.' || v.verb, ', ')
    into v_missing
    from (values ('laundry_orders'), ('laundry_order_items'), ('laundry_order_activity')) t(name)
   cross join (values ('insert'), ('update')) v(verb)
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t.name
        and p.policyname = t.name || '_main_flow_' || v.verb
        and p.permissive = 'RESTRICTIVE'
        and coalesce(p.qual, '') || coalesce(p.with_check, '') like '%customer_service%'
   );
  if v_missing is not null then
    raise exception '0034: the counter is still refused on %', v_missing using errcode = 'P0001';
  end if;

  -- 2. The driver and the board carve-outs survived the rewrite. This is the
  --    regression 0031 exists to prevent, and rebuilding the predicate is
  --    exactly how it would come back.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'laundry_orders'
       and policyname = 'laundry_orders_main_flow_update'
       and qual like '%current_driver_id%' and qual like '%current_board_id%'
  ) then
    raise exception '0034: the driver/board carve-out was lost' using errcode = 'P0001';
  end if;

  -- 3. The counter cannot delete a job, only its items.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'laundry_orders'
       and policyname = 'laundry_orders_main_flow_delete'
       and qual like '%customer_service%'
  ) then
    raise exception '0034: the counter can delete a job' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'laundry_order_items'
       and policyname = 'laundry_order_items_main_flow_delete'
       and qual like '%customer_service%'
  ) then
    raise exception '0034: the counter cannot correct a job''s laundry'
      using errcode = 'P0001';
  end if;

  -- 4. Billing and the price list did NOT move. The whole point of naming three
  --    tables rather than looping 0025's nine.
  select string_agg(tablename || '.' || policyname, ', ')
    into v_leaked
    from pg_policies
   where schemaname = 'public'
     and tablename in ('invoices', 'invoice_lines', 'payments',
                       'credit_notes', 'credit_note_lines', 'laundry_prices')
     and policyname like '%_main_flow_%'
     and coalesce(qual, '') || coalesce(with_check, '') like '%customer_service%';
  if v_leaked is not null then
    raise exception '0034: the counter reached billing via %', v_leaked using errcode = 'P0001';
  end if;
end $$;
