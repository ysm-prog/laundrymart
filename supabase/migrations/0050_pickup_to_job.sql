-- ============================================================================
-- 0050_pickup_to_job — a collection becomes a laundry job, exactly once.
--
-- §33 records this as the obvious next piece and deliberately unbuilt: a driver
-- captures a collection on `/run`, which writes `pickups` + `pickup_lines` and
-- moves *inventory* — and **nothing bills from it**. What the customer pays
-- still comes from a laundry job raised at the counter and priced per item code.
-- So every collection had to be re-typed by somebody reading a driver's counts
-- off another screen, and a collection nobody re-typed was never billed at all,
-- silently. This column is the link that closes it.
--
-- **One column, not a table.** A laundry job is taken in from at most one
-- collection, so a join table would be structure holding exactly one row — the
-- call 0047 made about the collection weekday, one release earlier. What it is
-- *not* is `invoice_source_jobs`, which is many-to-one and earns its table.
--
-- ## Why "exactly once" is a database fact and not a convention
--
-- The whole point of the loop is that the collection becomes the thing the
-- customer is billed for. Take one collection in twice and the customer is
-- billed twice, on a running draft (0040) that merges the two lots into one
-- line — so the doubling is not even visible as two entries. A screen that looks
-- first is a race: two counter hands with the same list open both find nothing.
-- The partial unique index below is what makes it true; the trigger is what
-- makes the ordinary case a sentence instead of a constraint name.
--
-- **Partial, and `cancelled` is outside it — deliberately.** A job taken in
-- against the wrong customer is cancelled, and the collection is then still
-- sitting there needing to be taken in. Same shape and same reasoning as
-- `uq_invoice_source_jobs_once` (0017), where voiding an invoice releases its
-- jobs: an undo has to release the work rather than strand it. An **archived**
-- job stays inside the index, because archiving hides records rather than
-- undoing them — that laundry really was taken in.
--
-- Additive throughout: one nullable column with no default, so all of this
-- laundry's existing jobs read "not taken in from a collection" and no row
-- changes meaning. Nothing here creates a job — `createOrder` is still the one
-- door laundry is taken in through, and this only records where it came from.
--
-- RLS: nothing new. `laundry_orders` carries its tenant policy from 0014, 0017's
-- `archived_at is null`, 0015/0016/0031's driver and board narrowings and 0025's
-- restrictive write layer (widened by 0034), so a column added here is covered
-- by every one of them the moment it exists. What this file asserts is that it
-- did not undo any of it.
-- ============================================================================

-- ------------------------------------------------------- 1. the link ---
alter table public.laundry_orders
  add column if not exists source_pickup_id uuid
    references public.pickups(id) on delete set null;

comment on column public.laundry_orders.source_pickup_id is
  'The collection this job was taken in from (0050). Null on a job typed at the
   counter, which is every job written before this migration. `on delete set
   null` rather than restrict: a job is a real record of work whatever happens to
   the collection behind it, and blocking the delete would make a pickup
   undeletable — the same call 0017 makes for `invoice_lines.laundry_order_id`.';

-- **The rule, as a fact.** Per laundry and per collection, so a second take-in
-- cannot bill the same linen twice — and partial, so cancelling the job releases
-- the collection to be taken in again.
create unique index if not exists uq_laundry_orders_source_pickup
  on public.laundry_orders(tenant_id, source_pickup_id)
  where source_pickup_id is not null and status <> 'cancelled';

-- ------------------------------------------- 2. a collection that fits ---
-- The refusals every foreign reference written from a form in this schema makes
-- (`guard_customer_collection_board` 0047, `guard_supplier_expense_account` 0045,
-- `guard_charge_type_account` 0044, `guard_job_charge_account` 0039), plus the
-- two that are specific to this link:
--
--   * **the collection must be the same customer's.** A job pointing at somebody
--     else's collection would put one customer's linen on another's invoice, and
--     nothing on either screen would show it. This is the integrity rule the
--     column exists to make checkable.
--   * **it must not already be on a job**, said with the job number, because
--     23505 on an index reaches the toast as "that value is already in use" —
--     true, and useless to somebody holding a docket.
--
-- A trigger rather than a check constraint because three of the four questions
-- are about *another row*; and it raises out loud where a restrictive policy
-- would write zero rows in silence — the failure this project has shipped twice.
--
-- SECURITY DEFINER, and that **strengthens** it rather than loosening it: the
-- duplicate check has to see a job the caller's RLS may hide (an archived one, or
-- one on a round they are not on), and an invoker-rights read would come back
-- empty — which is indistinguishable from "not taken in yet" and would let the
-- second take-in straight through to the index. The same reasoning 0044 records
-- when it rebuilt `guard_job_charge_snapshot` as definer.
create or replace function public.guard_laundry_order_pickup_source()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  p record;
  v_existing text;
begin
  if tg_op = 'UPDATE' and new.source_pickup_id is not distinct from old.source_pickup_id then
    return new;
  end if;
  if new.source_pickup_id is null then
    return new;
  end if;

  select id, tenant_id, customer_id into p
    from public.pickups where id = new.source_pickup_id;

  if p.id is null then
    raise exception 'that collection could not be found';
  end if;
  if p.tenant_id <> new.tenant_id then
    raise exception 'that collection belongs to another business';
  end if;
  if p.customer_id <> new.customer_id then
    raise exception 'that collection was from a different customer, so it cannot be taken in on this job';
  end if;

  select order_number into v_existing
    from public.laundry_orders
   where tenant_id = new.tenant_id
     and source_pickup_id = new.source_pickup_id
     and status <> 'cancelled'
     and id <> new.id
   limit 1;
  if v_existing is not null then
    raise exception 'that collection has already been taken in as %', v_existing;
  end if;

  return new;
end $$;

-- `authenticated` named as well as `public, anon` — the trap 0019 recorded and
-- 0036 shipped. Supabase hands every new function a *direct* EXECUTE grant to
-- `authenticated`, which a `from public, anon` revoke leaves standing, and a
-- SECURITY DEFINER trigger function published at /rest/v1/rpc/… can only error.
revoke execute on function public.guard_laundry_order_pickup_source() from public, anon, authenticated;

drop trigger if exists guard_laundry_order_pickup_source on public.laundry_orders;
create trigger guard_laundry_order_pickup_source
  before insert or update of source_pickup_id on public.laundry_orders
  for each row execute procedure public.guard_laundry_order_pickup_source();

-- ====================================================== assert the outcome ==
-- Self-asserting, so a partial apply fails rather than half-landing. Structural
-- only: the behaviour — a second take-in refused by name, another customer's
-- collection refused, a cancelled job releasing it — needs two laundries and real
-- rows to be worth proving, and is in `supabase/tests/pickup_intake.test.sql`.
do $$
declare
  v int;
  v_missing text[] := '{}';
begin
  -- 1. The column arrived, nullable and with no default — the whole claim that
  --    this migration cannot change what an existing job means.
  select count(*) into v from information_schema.columns
   where table_schema = 'public' and table_name = 'laundry_orders'
     and column_name = 'source_pickup_id'
     and is_nullable = 'YES' and column_default is null;
  if v <> 1 then
    v_missing := v_missing || 'source_pickup_id is missing, not nullable, or has a default'::text;
  end if;

  -- 2. **Exactly one** foreign key from `laundry_orders` to `pickups`, and it
  --    clears rather than blocks. Exactly one is the load-bearing half: the job
  --    page embeds the collection through it, and a second reference would make
  --    that embed ambiguous and kill the read with PGRST201 at request time,
  --    where no typecheck and no unit test can see it — the trap 0038 records
  --    for `invoice_lines → gl_accounts` and 0047 for `customers → boards`.
  select count(*) into v from pg_constraint
   where conrelid = 'public.laundry_orders'::regclass and contype = 'f'
     and confrelid = 'public.pickups'::regclass;
  if v <> 1 then
    v_missing := v_missing || format('expected exactly 1 FK from laundry_orders to pickups, found %s', v);
  end if;

  select count(*) into v from pg_constraint
   where conrelid = 'public.laundry_orders'::regclass and contype = 'f'
     and confrelid = 'public.pickups'::regclass and confdeltype = 'n';
  if v <> 1 then
    v_missing := v_missing || 'the collection link is not on delete set null'::text;
  end if;

  -- 3. The index is UNIQUE and PARTIAL. Either half alone is the wrong rule: not
  --    unique and a collection can be billed twice; not partial and a cancelled
  --    job strands the collection for ever.
  select count(*) into v from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname = 'uq_laundry_orders_source_pickup' and i.indisunique;
  if v <> 1 then
    v_missing := v_missing || 'uq_laundry_orders_source_pickup is missing or not unique'::text;
  end if;

  select count(*) into v from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname = 'uq_laundry_orders_source_pickup'
     and pg_get_expr(i.indpred, i.indrelid) ilike '%cancelled%';
  if v <> 1 then
    v_missing := v_missing || 'the collection index does not release a cancelled job'::text;
  end if;

  -- 4. The guard is attached as a row-level BEFORE trigger, and is definer — the
  --    duplicate check has to see a job the caller's RLS hides.
  select count(*) into v from pg_trigger
   where tgrelid = 'public.laundry_orders'::regclass
     and tgname = 'guard_laundry_order_pickup_source' and not tgisinternal
     and tgtype & 1 = 1 and tgtype & 2 = 2;
  if v <> 1 then
    v_missing := v_missing || 'the collection guard is not attached as a row-level BEFORE trigger'::text;
  end if;

  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guard_laundry_order_pickup_source' and p.prosecdef;
  if v <> 1 then
    v_missing := v_missing || 'the collection guard is not SECURITY DEFINER'::text;
  end if;

  if has_function_privilege('authenticated', 'public.guard_laundry_order_pickup_source()', 'execute')
     or has_function_privilege('anon', 'public.guard_laundry_order_pickup_source()', 'execute') then
    v_missing := v_missing || 'guard_laundry_order_pickup_source is on the RPC surface'::text;
  end if;

  -- 5. RLS is untouched, and — the 0028 trap, which *does* apply here because
  --    `laundry_orders` is in `archivable_tables()` — 0017's clause is still on
  --    the permissive policies. A column added to a table whose policy lost that
  --    clause would be a column on rows the archive was supposed to have hidden.
  select count(*) into v from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'laundry_orders' and c.relrowsecurity;
  if v <> 1 then v_missing := v_missing || 'RLS is off on laundry_orders'::text; end if;

  -- `ilike`, not `like`: `pg_get_expr` renders it as `archived_at IS NULL`, so
  --  the lowercase form this file is written in matches nothing. Not
  --  hypothetical — it is what 0047's first draft did, and it failed the
  --  migration on a policy that was perfectly intact.
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'laundry_orders'
     and permissive = 'PERMISSIVE' and coalesce(qual, '') ilike '%archived_at is null%';
  if v < 1 then
    v_missing := v_missing || 'the laundry_orders policies no longer carry archived_at is null'::text;
  end if;

  -- 6. 0025's restrictive write layer is still there — the actual boundary on
  --    who may take laundry in. A permissive-only table here would be every
  --    member writing jobs, which is what 0025 exists to prevent.
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'laundry_orders' and permissive = 'RESTRICTIVE';
  if v < 3 then
    v_missing := v_missing || format('expected 0025s 3 restrictive write policies, found %s', v);
  end if;

  -- 7. 0029's posture: `anon` holds nothing on either table.
  select count(*) into v from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('laundry_orders','pickups') and grantee = 'anon';
  if v <> 0 then v_missing := v_missing || format('anon holds %s grants on the job/collection tables', v); end if;

  if array_length(v_missing, 1) is not null then
    raise exception '0050 did not apply cleanly: %', array_to_string(v_missing, '; ');
  end if;
end $$;
