-- ============================================================================
-- 0014_laundry_orders — the counter's job: laundry taken in, tracked, handed back.
--
-- Naming, because it will be the first question asked of this file: `public.jobs`
-- already exists and is something else entirely — a *stop* on a driver's run
-- (0004), which is why the UI calls it "Stops". The thing modelled here is the
-- order a customer's laundry arrives as: received at the counter or collected by
-- a driver, itemised, processed, then delivered or picked back up. It is called
-- a **Job** on screen (that is the operator's word for it) and a *laundry order*
-- in the schema, exactly as "Contracts" are `service_agreements` and "Linen" is
-- `inventory`. Nothing in 0001–0013 is altered.
--
-- Three tables: the order, its items, and its activity trail. The trail is what
-- makes "who marked this delivered, and when?" answerable, so it is written by
-- the same server action that makes the change and never reconstructed later.
-- ============================================================================

-- --------------------------------------------------------------- the order ---
create table public.laundry_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id uuid references public.depots(id) on delete set null,

  -- The existing customer record. Never a copy of one: everything the job needs
  -- to show about the customer is read through this key, with the single
  -- deliberate exception of `delivery_address` below.
  customer_id uuid not null references public.customers(id) on delete cascade,

  -- Allocated by next_number(), which is atomic and per tenant — see the note
  -- above uq_laundry_orders_number.
  order_number text not null,

  -- The six statuses, and only these six. "Overdue" is not among them because
  -- overdue is a fact about today's date, not a state a job is put into: a job
  -- that is late is still in progress, and storing it as a status would mean
  -- something had to write to every row each midnight.
  status text not null default 'new' check (status in (
    'new','in_progress','ready_for_delivery','out_for_delivery','completed','cancelled'
  )),
  priority text not null default 'normal' check (priority in ('normal','urgent')),

  -- When the laundry actually arrived. One instant rather than a date and a
  -- time column: the app composes it from the date and time pickers in the
  -- business timezone (src/lib/domain/timezone.ts) so that a job received at
  -- 11pm belongs to the day the counter says it does, not to whatever day UTC
  -- happened to be in at the time.
  received_at timestamptz not null default now(),
  received_via text not null default 'customer_dropoff'
    check (received_via in ('customer_dropoff','driver_pickup','other')),

  -- Only meaningful when received_via = 'driver_pickup'. The driver is the
  -- existing drivers row, not a new person record.
  pickup_date date,
  pickup_time time,
  pickup_driver_id uuid references public.drivers(id) on delete set null,

  -- The fork the whole screen turns on: we deliver it back, or they collect it.
  delivery_required boolean not null default false,
  expected_delivery_date date,
  expected_collection_date date,
  delivery_window text check (delivery_window in (
    'morning','afternoon','specific_time','no_specific_time'
  )),
  expected_delivery_time time,

  -- Historical address behaviour (§7 of the brief). `delivery_address` is a
  -- *snapshot* taken when the job was created or last edited — either copied
  -- from the customer's own address or typed as a one-off for this job. It is
  -- the one piece of customer data deliberately duplicated, because the
  -- question a job has to answer is "where was this taken?", and a customer who
  -- moves next year must not silently rewrite where last year's linen went.
  delivery_address_source text not null default 'customer'
    check (delivery_address_source in ('customer','custom')),
  delivery_address text,
  delivery_instructions text,

  -- Washing instructions for the plant, as distinct from directions to the door.
  special_instructions text,

  -- Staff are the existing auth.users behind memberships — the same key every
  -- created_by in this schema already uses. No employee table is introduced.
  assigned_to uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,

  delivered_at timestamptz,
  delivered_by uuid references auth.users(id) on delete set null,
  collected_at timestamptz,
  collected_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,

  cancelled_at timestamptz,
  cancellation_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz,

  -- The date the job is due, whichever workflow it is on. Generated rather than
  -- written, so the list's date column, the overdue rule, the sort and the index
  -- are all reading one definition and cannot disagree with the detail page.
  due_date date generated always as (
    case when delivery_required then expected_delivery_date else expected_collection_date end
  ) stored,

  -- A delivery job without a delivery date cannot be planned, so it is refused
  -- here as well as in the form. A collection date stays optional: the customer
  -- may genuinely not have said when they are coming back.
  constraint chk_laundry_orders_delivery_date check (
    not delivery_required or expected_delivery_date is not null
  ),
  -- "Specific time" is a promise; it needs the time it promises.
  constraint chk_laundry_orders_specific_time check (
    delivery_window is distinct from 'specific_time' or expected_delivery_time is not null
  ),
  -- A one-off address has to actually be an address.
  constraint chk_laundry_orders_custom_address check (
    delivery_address_source <> 'custom'
    or (delivery_address is not null and btrim(delivery_address) <> '')
  )
);

-- Job numbers are unique **per tenant**, matching every other number this app
-- issues (customers, agreements, invoices, credit notes) and allocated by the
-- same next_number() — an atomic UPDATE … RETURNING against number_sequences,
-- never a count of existing rows, so two counter staff creating a job at the
-- same moment cannot collide.
create unique index uq_laundry_orders_number on public.laundry_orders(tenant_id, order_number);

-- The list's default shape: newest first, optionally narrowed by status.
create index idx_laundry_orders_received on public.laundry_orders(tenant_id, received_at desc);
create index idx_laundry_orders_status on public.laundry_orders(tenant_id, status, due_date);
-- The customer's own history section, and the customer filter.
create index idx_laundry_orders_customer on public.laundry_orders(customer_id, received_at desc);
-- Today / tomorrow / this week / overdue all filter on due_date, and all of them
-- exclude the two terminal statuses — so the index does too, and stays small.
create index idx_laundry_orders_due on public.laundry_orders(tenant_id, due_date)
  where status not in ('completed','cancelled');
-- "Completed today" on the summary strip.
create index idx_laundry_orders_completed on public.laundry_orders(tenant_id, completed_at desc)
  where status = 'completed';
create index idx_laundry_orders_assigned on public.laundry_orders(tenant_id, assigned_to)
  where assigned_to is not null;

comment on column public.laundry_orders.delivery_address is
  'Snapshot of the address used by this job. Never updated from the customer record after the fact.';
comment on column public.laundry_orders.due_date is
  'Generated: expected delivery date for delivery jobs, expected collection date for pickups.';

-- --------------------------------------------------------------- the items ---
-- One row per kind of laundry in the bag. A job with no items is not a job, so
-- the "at least one item" rule is enforced by the server action that writes the
-- pair in one call — a check constraint cannot see sibling rows, and a deferred
-- constraint trigger would still leave a window where an empty job exists.
create table public.laundry_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.laundry_orders(id) on delete cascade,

  -- Deliberately its own vocabulary rather than a foreign key to public.items.
  -- `items` is the *linen the laundry owns and rents out*, priced and tracked
  -- through the inventory ledger. What arrives in a customer's bag is their own
  -- washing, described at the counter in seconds. Pointing this at items would
  -- force a counter hand to create a stock record before they could take in a
  -- bag of sheets.
  item_type text not null check (item_type in (
    'towels','hand_towels','bath_towels','bath_mats','sheets','pillowcases',
    'linen','uniforms','other'
  )),
  custom_description text,

  quantity_type text not null default 'exact' check (quantity_type in ('exact','bulk_lot')),
  exact_quantity integer check (exact_quantity is null or exact_quantity > 0),
  bag_count integer check (bag_count is null or bag_count > 0),
  estimated_quantity integer check (estimated_quantity is null or estimated_quantity > 0),
  notes text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,

  -- "Other" without a description is a row nobody can act on a week later.
  constraint chk_laundry_order_items_other check (
    item_type <> 'other'
    or (custom_description is not null and btrim(custom_description) <> '')
  ),
  -- Counted laundry is counted.
  constraint chk_laundry_order_items_exact check (
    quantity_type <> 'exact' or exact_quantity is not null
  ),
  -- A bulk lot has no count by definition, but it must still say *something*
  -- measurable — bags, an estimate, or a note — or the row records nothing.
  constraint chk_laundry_order_items_bulk check (
    quantity_type <> 'bulk_lot'
    or bag_count is not null
    or estimated_quantity is not null
    or (notes is not null and btrim(notes) <> '')
  )
);
create index idx_laundry_order_items_order on public.laundry_order_items(order_id);

-- ------------------------------------------------------------ the activity ---
-- The timeline on the job page. Append-only in practice: rows are written beside
-- the change that caused them and never edited.
create table public.laundry_order_activity (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.laundry_orders(id) on delete cascade,
  -- Who did it. Null only for a row written by something with no session.
  actor_id uuid references auth.users(id) on delete set null,
  activity_type text not null check (activity_type in (
    'created','status_changed','updated','items_changed','assigned',
    'delivered','collected','cancelled'
  )),
  -- jsonb rather than two text columns: a status change carries one field, an
  -- edit carries several, and the reader renders whatever is there.
  previous_value jsonb,
  new_value jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index idx_laundry_order_activity_order
  on public.laundry_order_activity(order_id, created_at desc);

-- ------------------------------------------------------- transition guard ----
-- The workflow, enforced where it cannot be talked around. The server action
-- checks the same table first (src/lib/domain/laundry-orders.ts) so the user
-- gets a sentence rather than an error; this exists because the action is not
-- the boundary — anything holding a session and the anon key can PATCH a row.
create or replace function public.guard_laundry_order_transition()
returns trigger language plpgsql set search_path = public as $$
declare allowed text[];
begin
  if new.status is not distinct from old.status then return new; end if;

  allowed := case old.status
    when 'new'                then array['in_progress','cancelled']
    when 'in_progress'        then array['ready_for_delivery','cancelled']
    when 'ready_for_delivery' then array['out_for_delivery','completed','cancelled']
    when 'out_for_delivery'   then array['completed','cancelled']
    -- completed and cancelled are terminal. A job that finished and then
    -- reopened is two different accounts of the same work.
    else array[]::text[]
  end;

  if not (new.status = any(allowed)) then
    raise exception 'a job cannot go from % to %', old.status, new.status
      using errcode = 'P0001';
  end if;

  -- The two workflows diverge only at the end, and each rejects the other's
  -- final move: a customer pickup never goes out on a van, and a delivery is
  -- not finished by someone ticking it off the shelf.
  if new.status = 'out_for_delivery' and not new.delivery_required then
    raise exception 'this job is a customer pickup, so it is never out for delivery'
      using errcode = 'P0001';
  end if;
  if new.status = 'completed' and old.status = 'ready_for_delivery' and new.delivery_required then
    raise exception 'a delivery job must go out for delivery before it is completed'
      using errcode = 'P0001';
  end if;

  -- Stamp the timestamps the state implies, so a row can never be completed
  -- without a completion time no matter which client wrote it.
  if new.status = 'completed' then
    new.completed_at = coalesce(new.completed_at, now());
  end if;
  if new.status = 'cancelled' then
    new.cancelled_at = coalesce(new.cancelled_at, now());
  end if;
  return new;
end $$;

create trigger guard_laundry_orders_transition before update on public.laundry_orders
  for each row execute procedure public.guard_laundry_order_transition();

-- A cancelled job is history and its contents stop moving. Completed jobs are
-- deliberately *not* frozen here: the brief asks for those to be editable under
-- an elevated permission, which is a decision about people and therefore lives
-- in the capability check, not in the table.
create or replace function public.guard_laundry_order_item_change()
returns trigger language plpgsql set search_path = public as $$
declare parent text;
begin
  select status into parent from public.laundry_orders
   where id = coalesce(new.order_id, old.order_id);
  if parent = 'cancelled' then
    raise exception 'this job was cancelled, so its laundry list cannot be changed'
      using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;

create trigger guard_laundry_order_items_change
  before insert or update or delete on public.laundry_order_items
  for each row execute procedure public.guard_laundry_order_item_change();

-- ------------------------------------------------- items, saved atomically ---
-- Editing a job's laundry list means "replace this set", and a set replacement
-- over PostgREST is a DELETE followed by an INSERT — two requests, with a window
-- between them where the job has no items at all and nothing to roll back if the
-- second fails. A function body is one transaction, so the whole swap either
-- happens or does not.
--
-- SECURITY INVOKER (the default, stated here because it is the point): the
-- caller's RLS decides which order they can see, so this cannot be used to write
-- into another tenant's job. The tenant id is read back from the parent row that
-- RLS already vouched for, never taken from the caller.
create or replace function public.save_laundry_order_items(p_order_id uuid, p_items jsonb)
returns integer language plpgsql set search_path = public as $$
declare
  v_tenant uuid;
  v_count integer;
begin
  select tenant_id into v_tenant from public.laundry_orders where id = p_order_id;
  if v_tenant is null then
    raise exception 'that job could not be found' using errcode = 'P0001';
  end if;

  -- The "at least one item" rule, in the one place that can see the whole set.
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a job needs at least one laundry item' using errcode = 'P0001';
  end if;

  delete from public.laundry_order_items where order_id = p_order_id;

  insert into public.laundry_order_items (
    tenant_id, order_id, item_type, custom_description, quantity_type,
    exact_quantity, bag_count, estimated_quantity, notes, created_by
  )
  select
    v_tenant,
    p_order_id,
    entry ->> 'item_type',
    nullif(btrim(coalesce(entry ->> 'custom_description', '')), ''),
    coalesce(entry ->> 'quantity_type', 'exact'),
    nullif(entry ->> 'exact_quantity', '')::integer,
    nullif(entry ->> 'bag_count', '')::integer,
    nullif(entry ->> 'estimated_quantity', '')::integer,
    nullif(btrim(coalesce(entry ->> 'notes', '')), ''),
    (select auth.uid())
  from jsonb_array_elements(p_items) as entry;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ------------------------------------------------------------------- RLS ----
-- Tenant policy, tenant index and updated_at trigger on all three. Jobs are not
-- driver-scoped the way daily_routes and jobs are: the counter's work is not a
-- driver's run, and no driver capability reaches this module at all.
select public.apply_tenant_policy(t) from unnest(array[
  'laundry_orders','laundry_order_items','laundry_order_activity'
]) as t;

-- 0001's blanket grant was a snapshot of the tables existing then; a table
-- created later needs its own. Named one by one so this cannot widen anything
-- else, and with no function grant — `anon` stays revoked (CLAUDE.md §7).
grant select, insert, update, delete on public.laundry_orders to authenticated;
grant select, insert, update, delete on public.laundry_order_items to authenticated;
grant select, insert, update, delete on public.laundry_order_activity to authenticated;
grant all on public.laundry_orders to service_role;
grant all on public.laundry_order_items to service_role;
grant all on public.laundry_order_activity to service_role;

-- CLAUDE.md §7: PostgREST publishes `public` as RPC, so anything executable by
-- `anon` is an unauthenticated endpoint. Every function this migration adds is
-- closed to PUBLIC and to anon, and only the one the app actually calls is
-- opened — to signed-in members, whose RLS still applies inside it.
revoke all on function public.guard_laundry_order_transition() from public, anon;
revoke all on function public.guard_laundry_order_item_change() from public, anon;
revoke all on function public.save_laundry_order_items(uuid, jsonb) from public, anon;
grant execute on function public.save_laundry_order_items(uuid, jsonb) to authenticated, service_role;
