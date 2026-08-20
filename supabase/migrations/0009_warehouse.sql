-- ============================================================================
-- 0009_warehouse — production batches through the plant (spec §7.16)
--
-- The processing states (washing → drying → folding → packing →
-- ready_for_dispatch) already existed in 0005, but nothing grouped stock as it
-- moved through them: an operator could only post one manual movement at a
-- time, with no record of *what went in together*. A batch is that grouping.
--
-- The batch owns no quantities of its own. Advancing a stage still goes through
-- move_inventory(), so the ledger stays the single source of truth and warehouse
-- stock cannot drift from what the rest of the system believes it has. Delete a
-- batch and the movements it made remain, exactly as they should.
-- ============================================================================

create table public.production_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,
  batch_number text not null,
  -- Mirrors the inventory states one-for-one, plus the two terminal stages a
  -- batch has that a pool does not.
  stage text not null default 'received' check (stage in (
    'received','washing','drying','folding','packing','ready_for_dispatch',
    'completed','cancelled'
  )),
  machine text,
  operator_id uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_production_batches_number
  on public.production_batches(tenant_id, batch_number);
create index idx_production_batches_stage
  on public.production_batches(tenant_id, stage, created_at desc);

create table public.production_batch_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  batch_id uuid not null references public.production_batches(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete restrict,
  owner_type text not null default 'laundry_owned'
    check (owner_type in ('laundry_owned','customer_owned')),
  -- Customer-owned linen has to come back to the customer it came from, so the
  -- owner travels with the line rather than with the batch.
  customer_id uuid references public.customers(id) on delete set null,
  quantity integer not null check (quantity > 0),
  rejected_quantity integer not null default 0 check (rejected_quantity >= 0),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  constraint pbl_rejects_within_quantity check (rejected_quantity <= quantity),
  -- Customer-owned stock without a customer is unreturnable; refuse it here
  -- rather than discovering it at dispatch.
  constraint pbl_customer_owned_has_customer
    check (owner_type <> 'customer_owned' or customer_id is not null)
);
create index idx_production_batch_lines_batch on public.production_batch_lines(batch_id);

-- ------------------------------------------------------- business rules ------
-- §11-style guards, in the database so no client can route around them.
create or replace function public.guard_batch_transition()
returns trigger language plpgsql as $$
declare v_lines integer;
begin
  if new.stage = old.stage then
    return new;
  end if;

  if old.stage in ('completed','cancelled') then
    raise exception 'a % batch cannot be reopened', old.stage using errcode = 'P0001';
  end if;

  if new.stage = 'cancelled' then
    new.cancelled_at = coalesce(new.cancelled_at, now());
    return new;
  end if;

  -- Starting work needs something to work on. An empty batch that reaches the
  -- washers is a batch someone will look for and never find.
  if old.stage = 'received' and new.stage = 'washing' then
    select count(*) into v_lines
      from public.production_batch_lines where batch_id = new.id;
    if v_lines = 0 then
      raise exception 'add at least one line before starting the batch'
        using errcode = 'P0001';
    end if;
    new.started_at = coalesce(new.started_at, now());
  end if;

  if new.stage = 'completed' then
    if old.stage <> 'ready_for_dispatch' then
      raise exception 'a batch can only be completed from ready_for_dispatch'
        using errcode = 'P0001';
    end if;
    new.completed_at = coalesce(new.completed_at, now());
  end if;

  return new;
end $$;

create trigger guard_production_batches_transition before update on public.production_batches
  for each row execute procedure public.guard_batch_transition();

-- Lines are the batch's manifest, and the stock movements at each stage were
-- calculated from it. Once the batch has left receiving the manifest must stop
-- changing — otherwise a quantity edited mid-wash silently desyncs the pools
-- from the ledger, with no movement row to explain the difference.
--
-- Rejects are the deliberate exception: a torn sheet is found *during*
-- processing, never in receiving, so that column (and the note beside it) stays
-- writable while everything that drives a movement is frozen.
create or replace function public.guard_batch_line_change()
returns trigger language plpgsql as $$
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
       or new.quantity  is distinct from old.quantity then
      raise exception 'a batch manifest can only be changed while the batch is in receiving'
        using errcode = 'P0001';
    end if;
  end if;

  return coalesce(new, old);
end $$;

create trigger guard_production_batch_lines_change
  before insert or update or delete on public.production_batch_lines
  for each row execute procedure public.guard_batch_line_change();

-- ------------------------------------------------------------------- RLS ----
select public.apply_tenant_policy(t) from unnest(array[
  'production_batches','production_batch_lines'
]) as t;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
