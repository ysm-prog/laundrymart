-- ============================================================================
-- 0025_main_flow_owner_office — the job→invoice flow belongs to the Owner and
-- the Office manager, and the database says so too.
--
-- `roles.ts` narrowed `orders.*` and `invoices.*` to `super_admin` and
-- `operations_manager` (the owner's decision). That is the app layer, and the
-- app layer is not the boundary: every one of these tables is published on
-- `/rest/v1/…`, so a warehouse operator's own login could still PATCH a job's
-- status or POST an invoice line straight past the screen that refuses.
--
-- ## Why restrictive policies, and not a rewrite
--
-- The obvious move is to re-create the write policies with a narrower role
-- list. It is also the one §11 warns about: this repo's `invoices` policies
-- carry 0006's inline `has_role(...)`, while the hosted project's were replaced
-- with `can_read_billing`/`can_write_billing` by a branch that has not landed.
-- A migration that re-states either shape silently drops the other's predicate
-- — the exact hazard 0017 had to solve by reading the catalogue.
--
-- A **restrictive** policy avoids the question. Postgres ANDs restrictive
-- policies with the (OR-ed) permissive ones, so this adds a second condition
-- that every write must also satisfy, whatever the existing policy happens to
-- say and whichever of the two shapes is in front of it. Nothing existing is
-- read, rewritten or dropped.
--
-- ## Writes only, deliberately
--
-- These cover INSERT, UPDATE and DELETE and **not SELECT**, which is not an
-- oversight:
--
--   * A driver has to read the job they are delivering — that is what My Runs
--     is, and 0015/0016 already narrow their reads to their own assigned work.
--     A restrictive SELECT policy here would blank that screen.
--   * Reading is already handled where it belongs: the app gates every Jobs and
--     Invoices screen on capabilities only the two roles now hold, so nobody
--     else is offered the screens at all.
--
-- So the split is: the **app** decides who is shown the flow, the **database**
-- decides who may change it. Anyone wanting SELECT locked down too should say
-- so explicitly, because it costs the driver their run screen.
--
-- `has_role()` admits `platform_admin` since 0019, so the deployment
-- administrator keeps working without being named here.
--
-- Adds no table, no column and no function. Changes no row.
-- ============================================================================

do $$
declare
  v_table text;
  v_tables constant text[] := array[
    -- The counter's job and everything hanging off it.
    'laundry_orders', 'laundry_order_items', 'laundry_order_activity',
    -- Billing the work.
    'invoices', 'invoice_lines', 'payments', 'credit_notes', 'credit_note_lines',
    -- What the work is charged at. A price list is part of billing, not a
    -- setting — the same argument §6 makes for it living under Money.
    'laundry_prices'
  ];
  v_predicate constant text :=
    '(select public.has_role(tenant_id, array[''super_admin'',''operations_manager'']))';
begin
  foreach v_table in array v_tables loop
    -- Skip anything this database does not have. The four purchases tables and
    -- their friends arrive on different branches at different times, and a
    -- migration that fails on a missing table takes the whole apply with it.
    if to_regclass('public.' || v_table) is null then
      raise notice '0025: skipping %, not present', v_table;
      continue;
    end if;

    -- Every table in the list is tenant-scoped; assert rather than assume,
    -- because the predicate below reads `tenant_id` directly.
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = v_table
         and column_name = 'tenant_id'
    ) then
      raise exception '0025: % has no tenant_id', v_table using errcode = 'P0001';
    end if;

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
         using (%s)', v_table || '_main_flow_delete', v_table, v_predicate);
  end loop;
end $$;

-- Prove the restrictive layer actually attached, rather than trusting that the
-- loop ran: a typo in `format()` would create nothing and raise nothing.
do $$
declare v_missing text;
begin
  select string_agg(t, ', ') into v_missing
    from unnest(array[
      'laundry_orders', 'laundry_order_items', 'laundry_order_activity',
      'invoices', 'invoice_lines', 'payments', 'credit_notes', 'credit_note_lines',
      'laundry_prices'
    ]) as t
   where to_regclass('public.' || t) is not null
     and (select count(*) from pg_policies
           where schemaname = 'public' and tablename = t
             and policyname like '%\_main\_flow\_%') <> 3;

  if v_missing is not null then
    raise exception '0025: restrictive write policies missing on %', v_missing
      using errcode = 'P0001';
  end if;
end $$;
