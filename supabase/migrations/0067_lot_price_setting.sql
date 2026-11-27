-- 0067_lot_price_setting — the standard lot price is the laundry's to set.
--
-- 0066 fixed the price of a lot at $40.00 excluding GST in a SQL function, so
-- changing it meant a migration. The owner asked for it to be a setting
-- (2026-11-27). This adds one row per laundry holding that price, edited on
-- Money › Laundry prices, and points 0066's trigger at it.
--
-- **Bookings already taken keep the price they were booked at.** That was 0066's
-- rule and nothing here touches it: the trigger still inserts the price row
-- `on conflict do nothing`, so only a job that becomes a lot booking *after* the
-- change picks up the new price. Changing the setting re-prices nothing.
--
-- **Why a table and not `tenants.settings`.** `tenants` is readable by every
-- member of the laundry — a driver, a board, the counter — so a price in its
-- jsonb bag would be the disclosure 0017, 0033, 0036 and 0066 each closed: a
-- price any member can read off PostgREST. Its own table can be read through
-- `can_read_pricing()` like every other price.
--
-- **Who may change it**: the Owner and the Office manager — the `pricing.write`
-- holders in `roles.ts` (the `JOB_TO_INVOICE` block), and the two roles 0025
-- already lets write the rest of the job→invoice flow. `lot-price-setting.test.ts` pins
-- the list below against `roles.ts`.
--
-- No row means the default: `standard_lot_price_ex_gst()`, still $40.00. So
-- applying this changes no price anywhere, and a laundry that never opens the
-- setting behaves exactly as it did.
--
-- Adds one table and one function, rebuilds 0066's trigger function to read
-- them; drops nothing and changes no existing row.

-- ------------------------------------------------------------ 1. the table --
create table if not exists public.tenant_lot_prices (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  unit_price_ex_gst numeric(12,2) not null
    check (unit_price_ex_gst > 0 and unit_price_ex_gst <= 100000),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

comment on table public.tenant_lot_prices is
  'The laundry''s standard price of one lot, excluding GST (0067). No row means '
  'the default, standard_lot_price_ex_gst(). Read by pricing roles; written by '
  'the Owner and the Office manager. A booking already taken keeps its own price.';

alter table public.tenant_lot_prices enable row level security;

drop policy if exists tenant_lot_prices_read on public.tenant_lot_prices;
create policy tenant_lot_prices_read on public.tenant_lot_prices
  for select to authenticated
  using ((select public.can_read_pricing(tenant_id)));

drop policy if exists tenant_lot_prices_insert on public.tenant_lot_prices;
create policy tenant_lot_prices_insert on public.tenant_lot_prices
  for insert to authenticated
  with check ((select public.has_role(tenant_id, array['super_admin','operations_manager'])));

drop policy if exists tenant_lot_prices_update on public.tenant_lot_prices;
create policy tenant_lot_prices_update on public.tenant_lot_prices
  for update to authenticated
  using ((select public.has_role(tenant_id, array['super_admin','operations_manager'])))
  with check ((select public.has_role(tenant_id, array['super_admin','operations_manager'])));
-- Deliberately no DELETE policy: there is nothing to delete a setting back to
-- that saving the default would not say more plainly.

-- Supabase's default privileges grant `authenticated` every verb on a new table
-- (0029), TRUNCATE among them — and RLS does not apply to TRUNCATE. So the
-- grants are restated from nothing.
revoke all on public.tenant_lot_prices from anon, authenticated;
grant select, insert, update on public.tenant_lot_prices to authenticated;
grant all on public.tenant_lot_prices to service_role;

-- ------------------------------------------------- 2. the price, per laundry --
create or replace function public.standard_lot_price_ex_gst(t uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.unit_price_ex_gst from public.tenant_lot_prices p where p.tenant_id = t),
    public.standard_lot_price_ex_gst()
  );
$$;
-- Only the trigger below calls it, and it runs as definer; nothing in `src/`
-- needs it on the RPC surface (`authenticated` named for the 0036 trap).
revoke all on function public.standard_lot_price_ex_gst(uuid) from public, anon, authenticated;
grant execute on function public.standard_lot_price_ex_gst(uuid) to service_role;

-- --------------------------------------- 3. 0066's trigger, reading it --
-- Rebuilt from 0066's body (the only definition); the one change is that the
-- price of the day comes from the laundry's own setting.
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
  values (new.id, new.tenant_id, public.standard_lot_price_ex_gst(new.tenant_id), coalesce(v_rate, 0.10))
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
revoke all on function public.sync_lot_booking_price() from public, anon, authenticated;

-- --------------------------------------------------- 4. self-assertions --
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.tenant_lot_prices'::regclass) then
    raise exception '0067: tenant_lot_prices must have row level security';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'tenant_lot_prices') <> 3 then
    raise exception '0067: tenant_lot_prices carries exactly three policies (read, insert, update)';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'tenant_lot_prices' and cmd = 'ALL') then
    raise exception '0067: no permissive for-all policy on the lot price setting';
  end if;
  if (select qual from pg_policies
       where schemaname = 'public' and tablename = 'tenant_lot_prices'
         and policyname = 'tenant_lot_prices_read') not ilike '%can_read_pricing%' then
    raise exception '0067: the lot price setting must be read through can_read_pricing';
  end if;
  if has_table_privilege('anon', 'public.tenant_lot_prices', 'select') then
    raise exception '0067: anon must hold no grant on the lot price setting';
  end if;
  if has_table_privilege('authenticated', 'public.tenant_lot_prices', 'truncate')
     or has_table_privilege('authenticated', 'public.tenant_lot_prices', 'delete') then
    raise exception '0067: authenticated must not truncate or delete the lot price setting';
  end if;
  if has_function_privilege('authenticated', 'public.standard_lot_price_ex_gst(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.sync_lot_booking_price()', 'execute') then
    raise exception '0067: neither lot price function may be on the RPC surface';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.sync_lot_booking_price()'::regprocedure) then
    raise exception '0067: the lot price trigger must stay SECURITY DEFINER';
  end if;
  if (select prosrc from pg_proc where oid = 'public.sync_lot_booking_price()'::regprocedure)
       not like '%standard_lot_price_ex_gst(new.tenant_id)%' then
    raise exception '0067: the trigger must read the laundry''s own lot price';
  end if;
  if public.standard_lot_price_ex_gst() <> 40.00 then
    raise exception '0067: the default lot price is still $40.00 excluding GST';
  end if;
end $$;
