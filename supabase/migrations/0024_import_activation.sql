-- ============================================================================
-- 0024_import_activation — hold imported master records inactive, reversibly.
--
-- Renumbered from 0015 on the way in: 0015_run_assignment holds that number on
-- Prod. It must stay after the purchases tables it activates, which is why it
-- is 0024 and not something lower — 0021-0023 are the import migrations this
-- one switches on and off.
--
-- Real customer and supplier data was loaded into a live tenant before the
-- business is ready to run on it. The ask is simply "mark it inactive for now,
-- turn it on later", and `customers.status` / `suppliers.status` both already
-- carry an 'inactive' value, so the deactivation itself is a one-line update.
--
-- The reason this needs a migration at all is the *reverse* direction. The
-- import is not uniformly active: it arrived carrying the source system's own
-- distinctions — 60 of 508 customers and 4 of 192 suppliers were already
-- inactive in the real business. Overwriting every row with 'inactive' loses
-- that, and the obvious "turn it on" (set everything to 'active') would then
-- silently activate 64 records the operator had deliberately switched off,
-- with nothing left in the database recording that they should not have been.
--
-- So the previous status is written down before it is overwritten, and
-- reactivation replays it. Turning the tenant on restores the import exactly
-- as it was received rather than approximating it.
--
-- Financial documents are deliberately untouched. `invoices` (draft/issued/
-- part_paid/paid/overdue/void), `supplier_bills` (open/closed/debit) and
-- `purchase_orders` have no 'inactive' value — their status *is* the financial
-- lifecycle, and borrowing one of those values to mean "not live yet" would
-- misstate the books. `gl_accounts` and `supplier_payments` have no status
-- column at all. Those tables are history; they do not act on their own, and
-- with every customer inactive nothing bills or emails anyone regardless.
--
-- Nothing in 0001–0014 is altered.
-- ============================================================================

-- ------------------------------------------------------- what we turned off ---
-- One row per record this migration's functions deactivated, holding the status
-- it had at that moment. Absence of a row is meaningful: it means this tenant
-- hold did not touch that record, so reactivation must leave it alone.
--
-- `source_table` is text rather than a FK to anything: the two tables it names
-- live in different migrations (customers in 0002, suppliers in an unmerged
-- branch), and a table this generic should not need editing to cover a third.
create table public.import_activation_state (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_table text not null,
  row_id uuid not null,

  -- The value to put back. Not constrained to a list here on purpose — each
  -- source table already has its own status check constraint, and that is what
  -- validates the write on the way back in.
  previous_status text not null,

  deactivated_at timestamptz not null default now(),
  primary key (tenant_id, source_table, row_id)
);

select public.apply_tenant_policy('import_activation_state');

-- ------------------------------------------------------------ deactivation ---
-- Whitelist rather than "any table with a status column": these are the two
-- that model an active/inactive master record, and dynamic SQL over a caller
-- supplied table name is how a helper like this turns into an injection.
--
-- `to_regclass` skips a table that does not exist, which is what lets this file
-- apply to a fresh local database (where `suppliers` has not been created yet —
-- its migration is on an unmerged branch) as well as to the hosted project.
--
-- SECURITY INVOKER: RLS decides which tenant the caller may touch, exactly as
-- save_laundry_order_items() does. The explicit tenant_id filter is belt and
-- braces for the service-role path, which bypasses RLS (CLAUDE.md §2).
create or replace function public.deactivate_tenant_records(p_tenant_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_table text;
  v_count integer;
  v_result jsonb := '{}'::jsonb;
begin
  if p_tenant_id is null then
    raise exception 'tenant id is required' using errcode = '22004';
  end if;

  foreach v_table in array array['customers', 'suppliers'] loop
    continue when to_regclass('public.' || v_table) is null;

    -- Two statements, one transaction: record the current status, then
    -- overwrite it. The insert's `not exists` is what makes a second run a
    -- no-op instead of recording 'inactive' as the status to restore — the
    -- failure mode that would quietly make the hold permanent.
    execute format($q$
      insert into public.import_activation_state
        (tenant_id, source_table, row_id, previous_status)
      select t.tenant_id, %L, t.id, t.status
        from public.%I t
       where t.tenant_id = %L
         and t.status is distinct from 'inactive'
         and not exists (
           select 1 from public.import_activation_state s
            where s.tenant_id = t.tenant_id
              and s.source_table = %L
              and s.row_id = t.id
         )
    $q$, v_table, v_table, p_tenant_id, v_table);

    execute format($q$
      update public.%I t
         set status = 'inactive'
       where t.tenant_id = %L
         and t.status is distinct from 'inactive'
    $q$, v_table, p_tenant_id);

    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_object(v_table, v_count);
  end loop;

  return v_result;
end $$;

-- ------------------------------------------------------------ reactivation ---
-- Replays what deactivation wrote down. Two deliberate rules:
--
--   * only rows still sitting at 'inactive' are restored. If someone has since
--     set a customer active or archived by hand, that is a later decision than
--     this hold and it wins;
--   * the state rows are cleared either way, because the hold is over. They are
--     counted into `skipped` so the caller can see the difference rather than
--     inferring it from a silent discrepancy.
create or replace function public.reactivate_tenant_records(p_tenant_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_table text;
  v_count integer;
  v_skipped integer;
  v_result jsonb := '{}'::jsonb;
begin
  if p_tenant_id is null then
    raise exception 'tenant id is required' using errcode = '22004';
  end if;

  foreach v_table in array array['customers', 'suppliers'] loop
    continue when to_regclass('public.' || v_table) is null;

    execute format($q$
      update public.%I t
         set status = s.previous_status
        from public.import_activation_state s
       where s.tenant_id = %L
         and s.source_table = %L
         and s.row_id = t.id
         and t.tenant_id = s.tenant_id
         and t.status = 'inactive'
    $q$, v_table, p_tenant_id, v_table);

    get diagnostics v_count = row_count;

    delete from public.import_activation_state s
     where s.tenant_id = p_tenant_id
       and s.source_table = v_table;

    get diagnostics v_skipped = row_count;

    v_result := v_result || jsonb_build_object(
      v_table, jsonb_build_object('restored', v_count, 'skipped', v_skipped - v_count));
  end loop;

  return v_result;
end $$;

-- 0001's blanket grant was a snapshot of the tables existing then, so a table
-- created later needs its own. Same shape as 0013 and 0014: members get CRUD and
-- RLS decides which rows, the service role gets everything, `anon` gets nothing.
grant select, insert, update, delete on public.import_activation_state to authenticated;
grant all on public.import_activation_state to service_role;

-- The two functions are service-role only, which is a deliberate step tighter
-- than save_laundry_order_items(). Those functions guard one job that the screen
-- has already gated by capability; these two switch an entire tenant's customer
-- and supplier base on or off, there is no screen behind them to do the gating,
-- and nothing in `orders.*`/`admin.*` describes the action. Until there is a
-- capability that means "release the import", the operator running it
-- deliberately is a better gate than every signed-in member holding an RPC that
-- turns the business live. 0011's default privileges revoke PUBLIC; the rest is
-- stated explicitly so this file stands alone.
revoke all on function public.deactivate_tenant_records(uuid) from public, anon, authenticated;
revoke all on function public.reactivate_tenant_records(uuid) from public, anon, authenticated;
grant execute on function public.deactivate_tenant_records(uuid) to service_role;
grant execute on function public.reactivate_tenant_records(uuid) to service_role;
