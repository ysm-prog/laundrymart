-- ============================================================================
-- 0051_laundry_item_ownership — is this the laundry's linen, or the customer's?
--
-- Jay's ATS change request of 2026-10-12. Each row of a job's laundry may now
-- say whether it is **rental** linen the laundry owns and lends, or the
-- customer's **own** laundry. The counter answers it per row because one bag
-- often carries both: rented tablecloths and the restaurant's own chef whites.
--
-- **One nullable column, and it does not touch money.** Pricing is untouched:
-- `priceJob`, the price list and the rate card read none of this, and nothing in
-- this file changes `item_type`, `sync_laundry_item_type` or any price table. It
-- is a statement about whose linen came in the bag, recorded so the job page and
-- My Runs can show it. Null means "not answered" — every row written before
-- this column existed — and is not silently read as either answer.
--
-- `save_laundry_order_items()` is rebuilt from **0032's** body, the latest
-- ancestor (checked: 0014 and 0032 are the only migrations defining it). The one
-- change is the ownership column, carried through from the JSON row. It stays
-- SECURITY INVOKER, so RLS and 0025/0031/0034's restrictive write layer still
-- decide who may write a job's laundry.
--
-- RLS: nothing new. `laundry_order_items` keeps its policies, scoped through the
-- parent job, and a column added here is covered by all of them as soon as it
-- exists. The assertions below prove the migration did not undo them.
-- ============================================================================

alter table public.laundry_order_items
  add column if not exists ownership text;

alter table public.laundry_order_items
  drop constraint if exists chk_laundry_order_items_ownership;
alter table public.laundry_order_items
  add constraint chk_laundry_order_items_ownership
  check (ownership is null or ownership in ('rental', 'own'));

comment on column public.laundry_order_items.ownership is
  'rental = the laundry''s own linen, lent to the customer; own = the customer''s laundry. '
  'Null = not recorded (rows written before 0051). Never read by pricing.';

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
    exact_quantity, bag_count, estimated_quantity, notes, ownership, created_by
  )
  select
    v_tenant,
    p_order_id,
    nullif(entry ->> 'item_id', '')::uuid,
    -- Still required, and still what every existing price tier matches on. The
    -- 0032 trigger overwrites it from the item when the item says which kind
    -- of laundry it is, so a caller that sends both cannot make them disagree.
    entry ->> 'item_type',
    nullif(btrim(coalesce(entry ->> 'custom_description', '')), ''),
    coalesce(entry ->> 'quantity_type', 'exact'),
    nullif(entry ->> 'exact_quantity', '')::integer,
    nullif(entry ->> 'bag_count', '')::integer,
    nullif(entry ->> 'estimated_quantity', '')::integer,
    nullif(btrim(coalesce(entry ->> 'notes', '')), ''),
    -- An unanswered row stays null; the check constraint refuses anything else.
    nullif(btrim(coalesce(entry ->> 'ownership', '')), ''),
    (select auth.uid())
  from jsonb_array_elements(p_items) as entry;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- `authenticated` keeps EXECUTE explicitly: the job form calls this on the
-- caller's client. `create or replace` does not restore a revoked grant, so the
-- grant is restated rather than relied on (0046's reasoning).
revoke all on function public.save_laundry_order_items(uuid, jsonb) from public, anon;
grant execute on function public.save_laundry_order_items(uuid, jsonb) to authenticated, service_role;

-- ------------------------------------------------------ assert the outcome ---
-- Fail rather than half-apply. Each check names the regression it guards.
do $$
declare
  n integer;
  v_def text;
  v_body text;
  v_secdef boolean;
begin
  -- 1. The column exists, is nullable and has no default, so no existing row
  --    changed meaning.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'laundry_order_items'
     and column_name = 'ownership' and is_nullable = 'YES' and column_default is null;
  if n <> 1 then
    raise exception '0051: laundry_order_items.ownership is missing, not nullable, or has a default'
      using errcode = 'P0001';
  end if;

  -- 2. The check constraint admits exactly the two answers.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conname = 'chk_laundry_order_items_ownership'
     and conrelid = 'public.laundry_order_items'::regclass;
  if v_def is null or v_def not ilike '%rental%' or v_def not ilike '%own%' then
    raise exception '0051: chk_laundry_order_items_ownership is missing or wrong (got %)', v_def
      using errcode = 'P0001';
  end if;

  -- 3. The writer carries the column through and is still SECURITY INVOKER,
  --    so RLS and the restrictive write layer still apply to the counter.
  select prosrc, prosecdef into v_body, v_secdef from pg_proc
   where oid = 'public.save_laundry_order_items(uuid, jsonb)'::regprocedure;
  if v_body not ilike '%ownership%' then
    raise exception '0051: save_laundry_order_items does not write ownership' using errcode = 'P0001';
  end if;
  if v_secdef then
    raise exception '0051: save_laundry_order_items became SECURITY DEFINER' using errcode = 'P0001';
  end if;
  -- 0032's item_id is still carried: rebuilding from 0014 would have dropped it.
  if v_body not ilike '%item_id%' then
    raise exception '0051: save_laundry_order_items lost item_id (rebuilt from the wrong ancestor)'
      using errcode = 'P0001';
  end if;

  -- 4. The RPC surface: callable by a signed-in session, never by anon.
  if has_function_privilege('anon', 'public.save_laundry_order_items(uuid, jsonb)', 'EXECUTE') then
    raise exception '0051: anon can execute save_laundry_order_items' using errcode = 'P0001';
  end if;
  if not has_function_privilege('authenticated', 'public.save_laundry_order_items(uuid, jsonb)', 'EXECUTE') then
    raise exception '0051: authenticated cannot execute save_laundry_order_items' using errcode = 'P0001';
  end if;

  -- 5. RLS still on, and 0029's posture held: anon holds no grant on the table.
  select count(*) into n from pg_class
   where oid = 'public.laundry_order_items'::regclass and relrowsecurity;
  if n <> 1 then
    raise exception '0051: RLS is off on laundry_order_items' using errcode = 'P0001';
  end if;
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'laundry_order_items' and grantee = 'anon';
  if n > 0 then
    raise exception '0051: anon holds % grant(s) on laundry_order_items', n using errcode = 'P0001';
  end if;

  -- 6. The restrictive write layer (0025, widened by 0031/0034) is still there.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'laundry_order_items' and permissive = 'RESTRICTIVE';
  if n = 0 then
    raise exception '0051: the restrictive write layer on laundry_order_items is gone'
      using errcode = 'P0001';
  end if;
end $$;
