-- 0066_laundry_by_lot — a laundry job booked by the number of lots.
--
-- The client's request of 2026-11-27: alongside the itemised job (an item, a
-- count, a kind of laundry, Rental or Own per row), a job may be booked as a
-- number of lots and a note, at the standard lot price — $40.00 a lot excluding
-- GST. Nothing about the itemised job changes; every existing row is `standard`.
--
-- Two halves, and the split is the decision worth reading.
--
--   * **What was booked is on the job** — `booking_type`, `lot_count`,
--     `lot_notes`. Operational facts a round reads at the door ("10 lots"), so
--     they sit under `laundry_orders`' existing policies, which already let a
--     board or a driver read their own job and nothing else.
--
--   * **What it costs is in its own table**, `laundry_order_lot_prices`, read
--     through `can_read_pricing()`. A price on `laundry_orders` would be readable
--     by every member who can read the job — a driver, a board, the counter —
--     which is precisely the shape 0017 closed on `invoices`, 0033 on
--     `laundry_prices` and 0036 on the payable side. Not repeated a fourth time.
--
-- **The price is kept by the database, from whoever writes the job.**
-- `sync_lot_booking_price` (AFTER INSERT/UPDATE on `laundry_orders`, SECURITY
-- DEFINER) creates the price row the moment a job becomes a lot booking, at
-- the standard price of that moment, and never changes the unit price after —
-- so a later change to the standard price cannot reach a booking already taken.
-- The totals are recomputed from the stored unit price whenever the count
-- changes, in this one place, so they can never disagree with the count. A job
-- that stops being a lot booking loses its price row. The counter, who takes
-- laundry in and may not read a price, therefore never writes one either:
-- there is **no write policy** on the price table at all, and the trigger is
-- the only writer.
--
-- Money: unit price $40.00 excl. GST; GST at `tenants.gst_rate` (10%); the
-- totals are `total_ex = count × unit`, `gst = round(total_ex × rate, 2)`,
-- `total_inc = total_ex + gst`. The TypeScript twin is `lotPricing` in
-- `src/lib/domain/lot-booking.ts`, and a unit test pins the two to the same
-- standard price.
--
-- Adds two columns' worth of facts and one table; drops nothing and changes no
-- existing row (every one reads `standard`, which the check constraint
-- requires of a row with no lot count).

-- ------------------------------------------------------- 1. the booking --
alter table public.laundry_orders
  add column if not exists booking_type text not null default 'standard',
  add column if not exists lot_count integer,
  add column if not exists lot_notes text;

alter table public.laundry_orders
  drop constraint if exists chk_laundry_orders_booking_type;
alter table public.laundry_orders
  add constraint chk_laundry_orders_booking_type check (
    (booking_type = 'standard' and lot_count is null and lot_notes is null)
    or (booking_type = 'lot' and lot_count is not null and lot_count between 1 and 9999)
  );

comment on column public.laundry_orders.booking_type is
  '`standard` (itemised laundry) or `lot` (booked by the number of lots), 0066.';
comment on column public.laundry_orders.lot_count is
  'How many lots a lot booking is for — a positive whole number (0066).';
comment on column public.laundry_orders.lot_notes is
  'The item notes on a lot booking (0066).';

-- ---------------------------------------------------------- 2. the price --
create table if not exists public.laundry_order_lot_prices (
  order_id uuid primary key references public.laundry_orders(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_price_ex_gst numeric(12,2) not null check (unit_price_ex_gst > 0),
  gst_rate numeric(5,4) not null check (gst_rate >= 0),
  total_ex_gst numeric(12,2) not null default 0,
  gst_amount numeric(12,2) not null default 0,
  total_inc_gst numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint chk_lot_prices_totals check (total_inc_gst = total_ex_gst + gst_amount)
);
create index if not exists idx_laundry_order_lot_prices_tenant
  on public.laundry_order_lot_prices(tenant_id);

comment on table public.laundry_order_lot_prices is
  'What a lot booking costs, fixed at the price of the day it was booked (0066). '
  'Read by pricing roles only; written by sync_lot_booking_price and nothing else.';

alter table public.laundry_order_lot_prices enable row level security;
drop policy if exists laundry_order_lot_prices_read on public.laundry_order_lot_prices;
create policy laundry_order_lot_prices_read on public.laundry_order_lot_prices
  for select to authenticated
  using ((select public.can_read_pricing(tenant_id)));
-- Deliberately no insert/update/delete policy: with RLS on, the absence is the
-- refusal. The trigger below is SECURITY DEFINER and is the one writer.

-- `authenticated` is named in the revoke because Supabase's default privileges
-- grant it every verb on a new table (0029); only SELECT is handed back.
revoke all on public.laundry_order_lot_prices from anon, authenticated;
grant select on public.laundry_order_lot_prices to authenticated;
grant all on public.laundry_order_lot_prices to service_role;

-- --------------------------------------------- 3. the standard lot price --
-- One place in SQL. Changing the standard price is a migration that redefines
-- this function (and the TypeScript constant beside `lotPricing`); bookings
-- already taken keep the price they were booked at.
create or replace function public.standard_lot_price_ex_gst()
returns numeric language sql immutable set search_path = public as $$
  select 40.00::numeric;
$$;
revoke all on function public.standard_lot_price_ex_gst() from public, anon, authenticated;
grant execute on function public.standard_lot_price_ex_gst() to service_role;

-- ------------------------------------------------- 4. keeping it in step --
create or replace function public.sync_lot_booking_price()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_rate numeric;
begin
  if new.booking_type is distinct from 'lot' then
    delete from public.laundry_order_lot_prices where order_id = new.id;
    return null;
  end if;

  select coalesce(t.gst_rate, 0.10) into v_rate from public.tenants t where t.id = new.tenant_id;

  -- The unit price of the day the booking was taken, and never again: a row
  -- that already exists keeps its price however the standard one has moved.
  insert into public.laundry_order_lot_prices (order_id, tenant_id, unit_price_ex_gst, gst_rate)
  values (new.id, new.tenant_id, public.standard_lot_price_ex_gst(), coalesce(v_rate, 0.10))
  on conflict (order_id) do nothing;

  update public.laundry_order_lot_prices p
     set total_ex_gst = round(new.lot_count * p.unit_price_ex_gst, 2),
         gst_amount = round(round(new.lot_count * p.unit_price_ex_gst, 2) * p.gst_rate, 2),
         total_inc_gst = round(new.lot_count * p.unit_price_ex_gst, 2)
                       + round(round(new.lot_count * p.unit_price_ex_gst, 2) * p.gst_rate, 2),
         updated_at = now()
   where p.order_id = new.id;
  return null;
end $$;

drop trigger if exists sync_laundry_orders_lot_price on public.laundry_orders;
create trigger sync_laundry_orders_lot_price
  after insert or update of booking_type, lot_count on public.laundry_orders
  for each row execute function public.sync_lot_booking_price();

-- A trigger function on the RPC surface can only ever error; `authenticated`
-- is named because a hosted project grants it directly (§7, the 0036 trap).
revoke all on function public.sync_lot_booking_price() from public, anon, authenticated;

-- --------------------------------------------------- 5. self-assertions --
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'laundry_orders'
         and column_name in ('booking_type','lot_count','lot_notes')) <> 3 then
    raise exception '0066: laundry_orders must carry booking_type, lot_count and lot_notes';
  end if;
  if exists (select 1 from public.laundry_orders where booking_type <> 'standard') then
    raise exception '0066: no existing job may have been re-read as a lot booking';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.laundry_order_lot_prices'::regclass) then
    raise exception '0066: laundry_order_lot_prices must have row level security';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'laundry_order_lot_prices') <> 1 then
    raise exception '0066: the price table carries exactly one policy, the pricing read';
  end if;
  if (select qual from pg_policies
       where schemaname = 'public' and tablename = 'laundry_order_lot_prices'
         and policyname = 'laundry_order_lot_prices_read') not ilike '%can_read_pricing%' then
    raise exception '0066: the price read must be gated on can_read_pricing';
  end if;
  if has_table_privilege('anon', 'public.laundry_order_lot_prices', 'select') then
    raise exception '0066: anon must hold no grant on the lot price table';
  end if;
  if has_table_privilege('authenticated', 'public.laundry_order_lot_prices', 'insert')
     or has_table_privilege('authenticated', 'public.laundry_order_lot_prices', 'update') then
    raise exception '0066: authenticated must not be granted writes on the lot price table';
  end if;
  if has_function_privilege('authenticated', 'public.sync_lot_booking_price()', 'execute') then
    raise exception '0066: the lot price trigger function must not be callable by authenticated';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.sync_lot_booking_price()'::regprocedure) then
    raise exception '0066: the lot price trigger must be SECURITY DEFINER, or a counter could not book a lot';
  end if;
  if public.standard_lot_price_ex_gst() <> 40.00 then
    raise exception '0066: the standard lot price is $40.00 excluding GST';
  end if;
end $$;
