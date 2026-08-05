-- ============================================================================
-- 0012_return_count — the depot count is the control, not a re-typing exercise
--
-- The loop the operator actually runs is: driver collects → van returns → the
-- warehouse counts what came off it → wash → dry → ready to go out again.
--
-- Two things were wrong with how 0009 modelled the count.
--
-- 1. Nothing tied a batch to the run it came off, so the warehouse re-keyed a
--    manifest the driver had already counted at every stop. The numbers were
--    already in pickup_lines; the batch simply could not see them.
--
-- 2. The recount is the moment shrinkage is discovered, and the schema had
--    nowhere to record it. Driver books 40, warehouse counts 38, the batch
--    washes 38 — and 2 sat in at_depot forever with no movement row to explain
--    them. The pools drifted quietly, which is the one thing the ledger exists
--    to prevent.
--
-- So: a batch remembers its run, a line remembers what the driver said beside
-- what the warehouse counted, and the difference is posted as a real movement
-- by the caller. And upsert_inventory_pool now refuses to drive a pool below
-- zero at all, which turns every remaining variant of this class of bug from
-- silent drift into an error message.
-- ============================================================================

-- --------------------------------------------------- batch ← the run it came off
alter table public.production_batches
  add column route_id uuid references public.daily_routes(id) on delete set null;

comment on column public.production_batches.route_id is
  'The run this batch was counted off, when it came from one. Null for a batch opened by hand.';

-- One count per run. Counting the same van twice would book its linen into the
-- plant twice, and the second batch would have nothing at the depot to draw on.
create unique index uq_production_batches_route
  on public.production_batches(tenant_id, route_id)
  where route_id is not null and deleted_at is null;

-- ------------------------------------------- line ← what the driver said it was
alter table public.production_batch_lines
  add column driver_quantity integer check (driver_quantity >= 0);

comment on column public.production_batch_lines.driver_quantity is
  'What the driver booked out of the customer for this item, when the batch was
   counted off a run. `quantity` is what the warehouse actually counted; the
   difference between the two is posted as a loss (or a find) at count time.';

-- `driver_quantity` is evidence of what was claimed, not a live figure. Freeze
-- it with the rest of the manifest — an editable "driver said" column is a
-- variance report that can be made to say anything.
create or replace function public.guard_batch_line_change()
returns trigger language plpgsql set search_path = public as $$
declare v_stage text;
begin
  select stage into v_stage from public.production_batches
   where id = coalesce(new.batch_id, old.batch_id);

  if v_stage is distinct from 'received' then
    if tg_op <> 'UPDATE'
       or new.batch_id  is distinct from old.batch_id
       or new.item_id   is distinct from old.item_id
       or new.owner_type is distinct from old.owner_type
       or new.customer_id is distinct from old.customer_id
       or new.quantity  is distinct from old.quantity
       or new.driver_quantity is distinct from old.driver_quantity then
      raise exception 'a batch manifest can only be changed while the batch is in receiving'
        using errcode = 'P0001';
    end if;
  end if;

  return coalesce(new, old);
end $$;

-- ------------------------------------------------ stock cannot go below zero ---
-- A pool is a physical count of linen sitting somewhere. There is no such thing
-- as minus twelve towels in a washer, so the only way a negative arrives is a
-- mistake upstream: a manifest typed larger than what was delivered, a stage
-- advanced twice, an owner_type that no pickup ever produces.
--
-- Refusing it here catches all of them at the point of the error, with the
-- operator still looking at the screen that caused it, instead of leaving a
-- wrong number for someone to find at stocktake. P0001 so describeDbError()
-- passes the sentence straight through to the user.
create or replace function public.upsert_inventory_pool(
  p_tenant uuid, p_item uuid, p_owner_type text, p_state text,
  p_customer uuid, p_depot uuid, p_vehicle uuid, p_delta integer
) returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_pool uuid;
  v_quantity integer;
begin
  insert into public.inventory_pools
    (tenant_id, item_id, owner_type, state, customer_id, depot_id, vehicle_id, quantity)
  values (p_tenant, p_item, p_owner_type, p_state, p_customer, p_depot, p_vehicle, p_delta)
  on conflict (tenant_id, item_id, owner_type, state,
               coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(depot_id,    '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(vehicle_id,  '00000000-0000-0000-0000-000000000000'::uuid))
  do update set quantity = public.inventory_pools.quantity + excluded.quantity
  returning id, quantity into v_pool, v_quantity;

  if v_quantity < 0 then
    raise exception 'only % of that item are %, so % cannot be moved out',
      v_quantity - p_delta, replace(p_state, '_', ' '), -p_delta
      using errcode = 'P0001';
  end if;

  return v_pool;
end $$;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
-- No `grant execute … to anon` here: 0011 revoked it deliberately (see CLAUDE.md §7).
