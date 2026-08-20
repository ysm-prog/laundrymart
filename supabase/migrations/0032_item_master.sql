-- ============================================================================
-- 0032_item_master — one item vocabulary, and it is the one the staff know.
--
-- The business keeps its item codes in MYOB. Staff know them by heart: they type
-- TOW001, not "bath towels". This app invented its own nine categories instead,
-- so every conversation between the counter and the books needs a translation
-- nobody wrote down.
--
-- **The app had two item vocabularies and was being asked for a third. It should
-- end with one.**
--
--   public.items                    linen the laundry owns and rents out
--   laundry_order_items.item_type   nine hard-coded categories for what arrives
--   (a new items table)             rejected — a third would drift
--
-- So `items` becomes the item master, carrying the MYOB code and the fields
-- MYOB actually holds, and a job's laundry points at it.
--
-- **This overrides a decision 0014 made deliberately, and that is said out loud
-- rather than done quietly.** 0014's comment reads: *"Pointing this at items
-- would force a counter hand to create a stock record before they could take in
-- a bag of sheets."* That was correct for a counter with no item list. It is
-- superseded by the client's own requirement: they **have** an item list, staff
-- know it, and typing `TOW` to find `TOW001` is faster than choosing from nine
-- categories. The counter-speed concern is answered by making the picker
-- code-first with type-ahead, not by keeping a separate vocabulary.
--
-- **Nothing is dropped and no existing row is invalidated.** `item_type` stays
-- `not null` and every job written before today keeps working, because the new
-- column is additive and the three pricing tiers keep their existing path. An
-- item carries a `laundry_category` — one of the same nine values — and a
-- trigger derives `item_type` from it, so a row can never claim an item and a
-- category that disagree.
--
-- **What this migration does not do: talk to MYOB.** The columns are here and
-- the importer is not, because the export's real column names have to be read
-- rather than guessed — the same discipline the bills import learned the hard
-- way. `external_synced_at` is null until something syncs.
-- ============================================================================

-- ------------------------------------------------------- the item master ----
alter table public.items
  -- The code the business already uses. Separate from `sku`, which is in use
  -- with a unique index and its own history: overloading it would rewrite
  -- existing rows to mean something new. Backfilled from `sku` below, and free
  -- to diverge afterwards.
  add column if not exists item_code text,
  add column if not exists description text,

  -- MYOB's "Item I Sell" / "Item I Buy". Two booleans rather than one enum,
  -- because MYOB genuinely allows both, neither, or either.
  add column if not exists is_sell boolean not null default true,
  add column if not exists is_buy boolean not null default false,

  add column if not exists sell_price numeric(12,2) not null default 0
    check (sell_price >= 0),
  add column if not exists cost_price numeric(12,2) not null default 0
    check (cost_price >= 0),

  -- The ledger's tax code as a string (GST, FRE, …). Deliberately not an enum:
  -- it is somebody else's vocabulary and a check constraint here would need
  -- migrating every time their chart changes.
  add column if not exists tax_code text,

  -- Which of the nine kinds of laundry this item is, so the existing pricing
  -- tiers and every historical job keep working while the transition happens.
  -- Nullable: a rented tablecloth is not something a customer hands over.
  add column if not exists laundry_category text
    check (laundry_category is null or laundry_category in (
      'towels','hand_towels','bath_towels','bath_mats','sheets','pillowcases',
      'linen','uniforms','other'
    )),

  add column if not exists myob_item_id text,
  add column if not exists myob_item_code text,
  add column if not exists external_synced_at timestamptz;

comment on column public.items.item_code is
  'The code the business already uses, from MYOB where there is one. Distinct '
  'from sku, which predates it and is not touched.';
comment on column public.items.laundry_category is
  'Which of the nine kinds of laundry this item is. The bridge that lets a job '
  'name an item while every existing price tier keeps matching on item_type.';

-- Backfilled rather than left null, so an existing tenant's items are usable
-- from the moment this applies and nobody has to re-key a list they already
-- have. `sku` is already unique per tenant, so the unique index below holds.
update public.items set item_code = sku where item_code is null;

-- Unique per laundry, case-insensitively — "TOW001" and "tow001" are one code,
-- and a duplicate is the thing §17 asks to be refused.
create unique index if not exists uq_items_code
  on public.items(tenant_id, lower(item_code))
  where deleted_at is null and item_code is not null;

-- The type-ahead: "TOW" has to find TOW001 quickly, and staff search by code
-- more often than by name.
create index if not exists idx_items_code_search
  on public.items(tenant_id, lower(item_code)) where deleted_at is null;
create index if not exists idx_items_laundry_category
  on public.items(tenant_id, laundry_category) where laundry_category is not null;

-- ------------------------------------------- what arrives in a bag, coded ---
alter table public.laundry_order_items
  -- `restrict`, not `set null`: an invoice raised from this row has to be able
  -- to say what was billed, and an item that has priced work is not something
  -- to delete out from under it.
  add column if not exists item_id uuid references public.items(id) on delete restrict;

create index if not exists idx_laundry_order_items_item
  on public.laundry_order_items(item_id) where item_id is not null;

-- The same column on the frozen charge, so a snapshot records which item was
-- billed and not merely which of the nine categories it fell into.
-- `job_charge_snapshots.source_item_id` already exists (0017) and already points
-- here, so there is nothing to add — worth stating, because it is the reason the
-- consolidated invoice can group by item without any further change.

-- ------------------------------------------------- the coherence trigger ----
-- **A row cannot name an item and a category that disagree.**
--
-- Doing this in the database rather than in the action is what makes it true of
-- `save_laundry_order_items()` (which inserts directly), of a future import, and
-- of anything reaching PostgREST — and it means the app never has to keep the
-- two columns in step by hand, which is the way they would eventually drift.
--
-- An item with no `laundry_category` leaves whatever the caller sent, because
-- "this is a rented tablecloth" is not an answer to "what kind of laundry is
-- this" and inventing one would be worse than the caller's own guess.
create or replace function public.sync_laundry_item_type()
returns trigger language plpgsql set search_path = public as $$
declare v_category text;
begin
  if new.item_id is null then return new; end if;

  select i.laundry_category into v_category
    from public.items i
   where i.id = new.item_id
     and i.tenant_id = new.tenant_id
     and i.deleted_at is null;

  if not found then
    raise exception 'that item could not be found in this laundry'
      using errcode = 'P0001';
  end if;

  if v_category is not null then
    new.item_type = v_category;
  end if;
  return new;
end $$;

drop trigger if exists sync_laundry_order_item_type on public.laundry_order_items;
create trigger sync_laundry_order_item_type
  before insert or update of item_id on public.laundry_order_items
  for each row execute procedure public.sync_laundry_item_type();

-- ------------------------------------------- the atomic child-set replace ---
-- 0014's function, carrying `item_id` through. Replaced rather than added to,
-- for the reason 0014 gives: a delete-then-insert over PostgREST has a window
-- with no items on the job and nothing to roll back.
--
-- **This is 0014's body and nothing has replaced it since** — checked, because
-- rebuilding a function from the wrong ancestor is exactly how 0031 nearly
-- dropped 0017's billing hook.
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
    tenant_id, order_id, item_id, item_type, custom_description, quantity_type,
    exact_quantity, bag_count, estimated_quantity, notes, created_by
  )
  select
    v_tenant,
    p_order_id,
    nullif(entry ->> 'item_id', '')::uuid,
    -- Still required, and still what every existing price tier matches on. The
    -- trigger above overwrites it from the item when the item says which kind
    -- of laundry it is, so a caller that sends both cannot make them disagree.
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

-- ------------------------------------------------------ pricing by item ----
-- The price list gains the item, beside the category it already keys on.
--
-- Precedence, resolved in `lib/domain/laundry-billing.ts` and tested there:
--   the customer's row for this **item** → the customer's row for its category
--   → the tenant default for the item → the tenant default for its category.
--
-- Nothing is migrated: every existing row keys on the category, keeps working,
-- and is the tier beneath a per-item price rather than being replaced by one.
alter table public.laundry_prices
  add column if not exists item_id uuid references public.items(id) on delete cascade;

-- The old unique index is (tenant, customer, item_type) with NULLS NOT DISTINCT.
-- A per-item row needs its own, or one price per customer per category would
-- refuse the second item in that category.
drop index if exists uq_laundry_prices_scope;
create unique index if not exists uq_laundry_prices_scope
  on public.laundry_prices(tenant_id, customer_id, item_type, item_id)
  nulls not distinct;

create index if not exists idx_laundry_prices_item
  on public.laundry_prices(tenant_id, item_id) where item_id is not null;

-- ------------------------------------------------- assert the outcome -------
-- Fail rather than half-apply.
do $$
declare n integer;
begin
  -- Every item carries a code after the backfill, or the type-ahead in §16 has
  -- nothing to find and the unique index guards nothing.
  select count(*) into n from public.items where item_code is null and deleted_at is null;
  if n > 0 then
    raise exception '% item(s) still have no item_code after the backfill', n
      using errcode = 'P0001';
  end if;

  -- 0029: a column added to an existing table must not have reopened `anon`.
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('items', 'laundry_order_items', 'laundry_prices')
     and grantee = 'anon';
  if n > 0 then
    raise exception 'anon holds % table grant(s) on the item tables', n using errcode = 'P0001';
  end if;
end $$;

revoke all on function public.sync_laundry_item_type() from public, anon;
revoke all on function public.save_laundry_order_items(uuid, jsonb) from public, anon;
grant execute on function public.save_laundry_order_items(uuid, jsonb) to authenticated, service_role;

do $$
begin
  if has_function_privilege('anon', 'public.sync_laundry_item_type()', 'EXECUTE')
     or has_function_privilege('anon', 'public.save_laundry_order_items(uuid, jsonb)', 'EXECUTE') then
    raise exception 'anon can still execute an item function' using errcode = 'P0001';
  end if;
end $$;
