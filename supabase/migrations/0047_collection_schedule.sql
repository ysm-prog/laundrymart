-- ============================================================================
-- 0047_collection_schedule — the weekly round, recorded on the customer.
--
-- The owner's description of how this laundry actually works, 2026-09-08:
-- *"Customer gives us towels weekly, we bill monthly per item collected."*
--
-- The **billing** half of that already worked and needed nothing: prices are per
-- item code (§31), `billing_method` is `monthly_consolidated`, and since 0040
-- every approved job joins that customer's running draft for the month. What was
-- missing is the *weekly* half — nothing anywhere recorded that a customer is
-- collected at all, let alone on which day. No column on `customers`, none on
-- `customer_locations`, and **0 route templates** (that machinery exists and was
-- unlinked from the nav when the Runs module was removed on 2026-08-14). With 9
-- customers using the app a round remembers; with 451 active ones it will not.
--
-- **Why this is not a service agreement.** `service_agreements` exists, is
-- unit-tested, and has **0 rows** — and adopting it here would have billed this
-- laundry *wrongly*, not merely awkwardly. A contract's `per_item` line bills
-- `standard_quantity × visits` (`invoicing.ts`): a fixed assumed quantity times
-- the number of *scheduled* visits. It bills the pattern, not the collection.
-- Since 0040 the contract charges and the job charges land on the **same**
-- monthly draft, and the month-end run only skips a customer whose *contract*
-- lines are already there — not one whose job lines are. So a weekly towel
-- contract plus the actual jobs would put both on one invoice and bill the same
-- towels twice. The schedule below carries **no price at all**, which is the
-- whole point: what the customer pays still comes from what was collected.
--
-- **Two columns, not a table.** The owner's answer to "how regular is weekly?"
-- was *weekly, the same day each week* — one weekday per customer. A table
-- exists to hold many rows per customer and there is exactly one, so a table
-- here would be structure with nothing in it. If a customer ever needs two
-- collection days this becomes a table and the columns become its first row;
-- that is a smaller change than carrying an empty join from the start.
--
-- Additive throughout: both columns are nullable with no default, so every one
-- of the 511 existing customers reads "not on a schedule" and no row changes
-- meaning. Nothing here creates a stop, a run or a job — this records the
-- arrangement; `lib/runs/collections.ts` is what acts on it.
--
-- RLS: nothing new. `customers` carries its tenant policy from 0002 and 0017's
-- `archived_at is null`, so a column added here is covered the moment it exists.
-- What this file asserts is that it did not undo either.
-- ============================================================================

-- --------------------------------------------------- 1. the arrangement ---
alter table public.customers
  add column if not exists collection_weekday smallint,
  add column if not exists collection_board_id uuid
    references public.boards(id) on delete set null;

comment on column public.customers.collection_weekday is
  'ISO 8601 weekday: 1 = Monday … 7 = Sunday, matching Postgres `isodow` and
   `Date.getDay()` shifted — so the value can be compared against a date without
   a lookup table in either language. Null means this customer is not on a
   standing collection, which is the state all 511 start in.';

comment on column public.customers.collection_board_id is
  'The round that calls. `on delete set null`, so retiring a board degrades the
   schedule to "no round yet" rather than blocking the delete or dangling an id
   — the same call 0044 makes for `charge_type_accounts.gl_account_id` and 0045
   for `suppliers.expense_account_id`. A schedule with no board still says the
   customer is due; it simply cannot raise the stop until one is chosen.';

-- A weekday is 1..7 or nothing. Stated as a constraint rather than trusted to
-- the form, because `customers` is published on /rest/v1/customers and a 0 or an
-- 8 would silently match no day for ever.
alter table public.customers
  drop constraint if exists chk_customers_collection_weekday;
alter table public.customers
  add constraint chk_customers_collection_weekday
  check (collection_weekday is null or collection_weekday between 1 and 7);

-- --------------------------------------------- 2. a round that can call ---
-- The three refusals every foreign reference written from a form in this schema
-- already makes (`guard_supplier_expense_account` 0045, `guard_charge_type_account`
-- 0044, `guard_job_charge_account` 0039): not another laundry's row, not a row
-- that does not exist, and not one that has been retired.
--
-- A trigger rather than a check constraint because two of the three questions are
-- about *another row*, which a check constraint cannot ask; and it raises out
-- loud where a restrictive policy would write zero rows in silence — the failure
-- this project has shipped twice.
--
-- Note what is deliberately *not* refused: a weekday with no board. That is not a
-- broken schedule, it is precisely the "due, but no round yet" list the screen has
-- to be able to show — so only the meaningless half (a board with no day, which
-- names a round that will never be asked to call) is left to the application,
-- which can say so in a sentence rather than raising at the boundary.
create or replace function public.guard_customer_collection_board()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  b record;
begin
  if tg_op = 'UPDATE' and new.collection_board_id is not distinct from old.collection_board_id then
    return new;
  end if;
  if new.collection_board_id is null then
    return new;
  end if;

  select id, tenant_id, deleted_at into b
    from public.boards where id = new.collection_board_id;

  if b.id is null then
    raise exception 'that round could not be found';
  end if;
  if b.tenant_id <> new.tenant_id then
    raise exception 'that round belongs to another business';
  end if;
  if b.deleted_at is not null then
    raise exception 'that round has been removed, so it cannot be given a collection day';
  end if;

  return new;
end $$;

-- `authenticated` named as well as `public, anon` — the trap 0019 recorded and
-- 0036 shipped. Supabase hands every new function a *direct* EXECUTE grant to
-- `authenticated`, which a `from public, anon` revoke leaves standing, and a
-- SECURITY DEFINER trigger function published at /rest/v1/rpc/… can only error.
revoke execute on function public.guard_customer_collection_board() from public, anon, authenticated;

drop trigger if exists guard_customer_collection_board on public.customers;
create trigger guard_customer_collection_board
  before insert or update of collection_board_id on public.customers
  for each row execute procedure public.guard_customer_collection_board();

-- ------------------------------------------------------- 3. who is due ---
-- The one query the schedule exists to answer: *which of this laundry's customers
-- are collected on this weekday?* Partial, because on this deployment 0 of 511
-- rows carry a day today and most never will — an unfiltered index would be 511
-- entries to answer a question about a handful.
create index if not exists idx_customers_collection_day
  on public.customers(tenant_id, collection_weekday)
  where collection_weekday is not null and archived_at is null and deleted_at is null;

create index if not exists idx_customers_collection_board
  on public.customers(collection_board_id) where collection_board_id is not null;

-- ====================================================== assert the outcome ==
-- Self-asserting, so a partial apply fails rather than half-landing. Structural
-- only: the behaviour — a weekday of 8 refused, another laundry's board refused,
-- a valid pair accepted — needs two laundries to be worth proving and is in
-- `supabase/tests/collection_schedule.test.sql`, which creates its own.
do $$
declare
  v int;
  v_missing text[] := '{}';
begin
  -- 1. Both columns arrived, both nullable with no default — the whole claim
  --    that this migration cannot change what an existing row means.
  select count(*) into v from information_schema.columns
   where table_schema = 'public' and table_name = 'customers'
     and column_name in ('collection_weekday','collection_board_id')
     and is_nullable = 'YES' and column_default is null;
  if v <> 2 then
    v_missing := v_missing || format('expected 2 nullable no-default columns, found %s', v);
  end if;

  -- 2. The round link points at `boards` and clears rather than blocks when a
  --    round is deleted, so retiring a board cannot make a customer undeletable.
  --
  --    **Exactly one**, which is the load-bearing half: `dueCollections` and the
  --    customer record both embed `boards(name)` through it, and a second
  --    reference would make that embed ambiguous and kill both reads with
  --    PGRST201 at request time — where no typecheck and no unit test can see
  --    it. The trap 0038 records for `invoice_lines → gl_accounts`.
  select count(*) into v from pg_constraint
   where conrelid = 'public.customers'::regclass and contype = 'f'
     and confrelid = 'public.boards'::regclass;
  if v <> 1 then
    v_missing := v_missing || format('expected exactly 1 FK from customers to boards, found %s', v);
  end if;

  select count(*) into v from pg_constraint
   where conrelid = 'public.customers'::regclass and contype = 'f'
     and confrelid = 'public.boards'::regclass and confdeltype = 'n';
  if v <> 1 then
    v_missing := v_missing || 'the collection-board FK is not on delete set null'::text;
  end if;

  -- 3. The weekday is bounded in the database, not only on the form: `customers`
  --    is published on /rest/v1/customers, where a 0 or an 8 would silently match
  --    no day for ever.
  select count(*) into v from pg_constraint
   where conrelid = 'public.customers'::regclass and contype = 'c'
     and conname = 'chk_customers_collection_weekday';
  if v <> 1 then v_missing := v_missing || 'the weekday range constraint is missing'::text; end if;

  -- 4. The guard is attached as a row-level BEFORE trigger and is not on the RPC
  --    surface.
  select count(*) into v from pg_trigger
   where tgrelid = 'public.customers'::regclass
     and tgname = 'guard_customer_collection_board' and not tgisinternal
     and tgtype & 1 = 1 and tgtype & 2 = 2;
  if v <> 1 then
    v_missing := v_missing || 'the collection-board guard is not attached as a row-level BEFORE trigger'::text;
  end if;

  if has_function_privilege('authenticated', 'public.guard_customer_collection_board()', 'execute')
     or has_function_privilege('anon', 'public.guard_customer_collection_board()', 'execute') then
    v_missing := v_missing || 'guard_customer_collection_board is on the RPC surface'::text;
  end if;

  -- 5. RLS is untouched, and — the 0028 trap, which *does* apply here because
  --    `customers` is in `archivable_tables()` — 0017's clause is still on the
  --    policy. A column added to a table whose policy lost that clause would be
  --    a column on rows the archive was supposed to have hidden.
  select count(*) into v from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'customers' and c.relrowsecurity;
  if v <> 1 then v_missing := v_missing || 'RLS is off on customers'::text; end if;

  -- `ilike`, not `like`: `pg_get_expr` renders the clause as `archived_at IS
  --  NULL`, so the lowercase form this file is written in matches nothing. That
  --  is not hypothetical — it is what the first draft of this assertion did, and
  --  it failed the migration on a policy that was perfectly intact.
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'customers'
     and coalesce(qual, '') ilike '%archived_at is null%';
  if v < 1 then
    v_missing := v_missing || 'the customers policy no longer carries archived_at is null'::text;
  end if;

  -- 6. 0029's posture: `anon` holds nothing on this table.
  select count(*) into v from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'customers' and grantee = 'anon';
  if v <> 0 then v_missing := v_missing || format('anon holds %s grants on customers', v); end if;

  if array_length(v_missing, 1) is not null then
    raise exception '0047 did not apply cleanly: %', array_to_string(v_missing, '; ');
  end if;
end $$;
