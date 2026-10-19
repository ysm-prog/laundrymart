-- ============================================================================
-- 0059 — index the foreign keys the application actually reads through.
--
-- The Supabase performance advisor lists 145 foreign keys with no covering
-- index (unindexed_foreign_keys, INFO). That count is not a to-do list. Most of
-- them fall into three groups, and none of the three wants an index:
--   * audit columns such as created_by, approved_by and actor_id, which nothing
--     looks a row up by;
--   * references to small configuration tables (depots, vehicles, drivers,
--     gl_accounts) that are deleted rarely or never;
--   * columns the app does filter on, but always behind a tenant-leading
--     composite index the advisor does not count. For example,
--     idx_laundry_orders_board_day serves My Runs, idx_laundry_prices_customer
--     serves a customer's price list, and uq_production_batches_route serves
--     the plant. The advisor only accepts an index whose leading column is the
--     foreign key.
-- Each index costs a write on every insert and update, so adding all 145 would
-- make every write slower to speed up lookups nothing runs.
--
-- **The four below were picked by reading `src/` for every `.from()` chain
-- that filters on one of the 145 columns, then checking the existing indexes.**
-- Each one is a read with no usable index at all:
--   1. pickups.route_id: the plant's return count reads a run's collections
--      (warehouse/returns.ts). pickups is indexed on job_id and tenant_id only.
--   2. pickups.customer_id + pickup_date: the month-end run sums one
--      customer's weighed collections over a period (invoices/actions.ts), and
--      the planner reads them newest first (routes/planner). The same index
--      also serves the cascade when a customer row is deleted.
--   3. invoice_source_jobs.order_id: "which invoice carries this job" is read
--      on the billing screens (lib/invoices/period.ts). The one index on it,
--      uq_invoice_source_jobs_once, is partial on `invoice_id is not null`,
--      which the read does not state, so the planner cannot use it. The FK is
--      also ON DELETE RESTRICT, so deleting a job scans this table.
--   4. inventory_pools.vehicle_id: the unload sweep reads what is still on the
--      van (lib/routes/unload.ts). The only index naming the column is the
--      uniqueness one, where it is seventh and wrapped in coalesce().
--
-- Two of them are partial on `… is not null`. An FK check and every read above
-- compare with `=`, which implies not null, so the planner can still use them.
-- The advisor counts a partial index as covering, as it already does for
-- idx_inventory_pools_customer.
--
-- Adds four indexes. No table, column, policy, function or capability; changes
-- no row. `if not exists`, so a second run is a no-op.
-- ============================================================================

create index if not exists idx_pickups_route
  on public.pickups (route_id) where route_id is not null;

create index if not exists idx_pickups_customer_date
  on public.pickups (customer_id, pickup_date desc);

create index if not exists idx_invoice_source_jobs_order
  on public.invoice_source_jobs (order_id);

create index if not exists idx_inventory_pools_vehicle
  on public.inventory_pools (vehicle_id) where vehicle_id is not null;

-- ----------------------------------------------------------------------------
-- Self-assertions. A misnamed column fails the CREATE outright. What these
-- catch is the quieter failure: an index that exists but covers the wrong
-- thing, so the advisor still reports the FK and the read still scans.
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text[] := '{}';
  v_check record;
begin
  for v_check in
    select * from (values
      ('pickups',             'pickups_route_id_fkey'),
      ('pickups',             'pickups_customer_id_fkey'),
      ('invoice_source_jobs', 'invoice_source_jobs_order_id_fkey'),
      ('inventory_pools',     'inventory_pools_vehicle_id_fkey')
    ) as t(tbl, fk)
  loop
    -- The foreign key exists under the name the advisor reports.
    if not exists (select 1 from pg_constraint
                    where conname = v_check.fk and contype = 'f'
                      and conrelid = ('public.' || v_check.tbl)::regclass) then
      v_missing := v_missing || (v_check.fk || ': no such foreign key')::text;
      continue;
    end if;

    -- Some index on the table has the FK's columns as its leading columns.
    -- That is the advisor's own test, so passing it clears the finding.
    if not exists (
      select 1
        from pg_constraint c
        join pg_index i on i.indrelid = c.conrelid
       where c.conname = v_check.fk
         and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
         and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey
    ) then
      v_missing := v_missing || (v_check.fk || ': still has no covering index')::text;
    end if;
  end loop;

  -- The month-end read filters on the date as well as the customer, so the
  -- second column has to be the date.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'idx_pickups_customer_date'
       and indexdef ilike '%(customer_id, pickup_date desc)%'
  ) then
    v_missing := v_missing || 'idx_pickups_customer_date: not (customer_id, pickup_date desc)'::text;
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception '0059 did not apply cleanly: %', array_to_string(v_missing, '; ');
  end if;
end $$;
