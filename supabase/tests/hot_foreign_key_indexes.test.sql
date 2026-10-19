-- Proof: 0059. The four reads it exists for can use an index, and the four
-- foreign keys it names are covered the way the advisor checks.
--
-- An index existing is not the same as a read using it. The real queries are
-- planned here with sequential scans switched off. A table with no usable index
-- then still plans a Seq Scan (disabled scans are penalised, not forbidden), so
-- each assertion fails on a database without 0059. That was checked before
-- this file was committed, not assumed.
--
-- Plans are read as the owner, so RLS does not change the shape. The question
-- here is which index the plan can reach, not who may read the rows.
begin;
select plan(8);

create function pg_temp.plan_of(q text) returns text
language plpgsql as $$
declare
  r text;
  v_out text := '';
begin
  for r in execute 'explain (costs off) ' || q loop
    v_out := v_out || r || E'\n';
  end loop;
  return v_out;
end $$;

set local enable_seqscan = off;

-- 1. The plant's return count: a run's collections (warehouse/returns.ts).
select ok(
  pg_temp.plan_of($q$select id from public.pickups
                     where route_id = '05900000-0000-4000-8000-000000000001'$q$)
    like '%idx_pickups_route%',
  'a run''s collections are read through idx_pickups_route'
);

-- 2. Month end: one customer's weighed collections over a period.
select ok(
  pg_temp.plan_of($q$select total_weight_kg from public.pickups
                     where customer_id = '05900000-0000-4000-8000-000000000002'
                       and pickup_date between '2026-09-01' and '2026-09-30'
                       and total_weight_kg > 0$q$)
    like '%idx_pickups_customer_date%',
  'a customer''s collections for a period are read through idx_pickups_customer_date'
);

-- 3. The planner: customers' collections, newest first.
select ok(
  pg_temp.plan_of($q$select customer_id, total_weight_kg, pickup_date from public.pickups
                     where customer_id in ('05900000-0000-4000-8000-000000000002',
                                           '05900000-0000-4000-8000-000000000003')
                     order by pickup_date desc limit 24$q$)
    like '%idx_pickups_customer_date%',
  'the planner''s recent collections are read through idx_pickups_customer_date'
);

-- 4. Which invoice carries a job. The read states no invoice_id, so the
--    partial uniqueness index cannot answer it.
select ok(
  pg_temp.plan_of($q$select order_id from public.invoice_source_jobs
                     where order_id in ('05900000-0000-4000-8000-000000000004',
                                        '05900000-0000-4000-8000-000000000005')$q$)
    like '%idx_invoice_source_jobs_order%',
  'a job''s invoice link is read through idx_invoice_source_jobs_order'
);

-- 5. The unload sweep: what is still on the van.
select ok(
  pg_temp.plan_of($q$select item_id, owner_type, quantity from public.inventory_pools
                     where state = 'in_transit'
                       and vehicle_id = '05900000-0000-4000-8000-000000000006'
                       and quantity > 0$q$)
    like '%idx_inventory_pools_vehicle%',
  'the stock on a van is read through idx_inventory_pools_vehicle'
);

reset enable_seqscan;

-- 6–8. The advisor's own test: some index leads with the FK's columns.
create function pg_temp.fk_covered(fk text) returns boolean
language sql as $$
  select exists (
    select 1
      from pg_constraint c
      join pg_index i on i.indrelid = c.conrelid
     where c.conname = fk and c.contype = 'f'
       and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
       and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey)
$$;

select ok(pg_temp.fk_covered('pickups_route_id_fkey')
          and pg_temp.fk_covered('pickups_customer_id_fkey'),
          'both pickups foreign keys are covered');
select ok(pg_temp.fk_covered('invoice_source_jobs_order_id_fkey'),
          'the invoice-to-job foreign key is covered');
select ok(pg_temp.fk_covered('inventory_pools_vehicle_id_fkey'),
          'the pool-to-vehicle foreign key is covered');

select * from finish();
rollback;
