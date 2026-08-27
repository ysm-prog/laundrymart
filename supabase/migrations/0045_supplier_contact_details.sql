-- ============================================================================
-- 0045_supplier_contact_details — the rest of a supplier's contact card, and
-- the account its purchases post to.
--
-- `suppliers` (0021) holds a name, a phone, an email and a note, and 0021's own
-- header says why it is deliberately not folded into `customers`: the two share
-- a name and an email and nothing else. That reasoning is untouched. What it did
-- not anticipate is that the *contact card* either system keeps is the same
-- card — MYOB's supplier record carries an ABN, a postal address and a person,
-- and this app had nowhere to put any of it. The client's own export carries 187
-- ABNs, 117 addresses and 55 contact people that were being dropped on the floor.
--
-- The column that earns this migration on its own is `expense_account_id`.
-- MYOB's contact card names the account a supplier's purchases post to — its
-- "Category" — and the live books hold **1,515 supplier bills with a null
-- `account_id`**, because the bills export carries no account column and nothing
-- else ever knew one. 177 of 191 suppliers state theirs on the contact card.
--
-- Additive throughout: every column is nullable with no default, so a caller
-- that never names one still does not, and no existing row changes meaning.
--
-- RLS: nothing new. `suppliers` carries 0036's four explicit policies on
-- `can_read_purchases()` / `can_write_purchases()`, so a column added here is
-- covered by all four the moment it exists. What this file asserts is that it
-- did not undo them — the permissive `for all` shape 0021 shipped and 0036
-- replaced must not be back. `suppliers` is not in `archivable_tables()`, so
-- there is no `archived_at` clause to preserve and the 0028 trap does not apply.
-- ============================================================================

-- ------------------------------------------------------- 1. the card ---
alter table public.suppliers
  add column if not exists abn text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists suburb text,
  add column if not exists state text,
  add column if not exists postcode text,
  add column if not exists contact_name text,
  add column if not exists website text;

comment on column public.suppliers.abn is
  'Stored as 11 digits with no spaces, the shape `customers.abn` uses and the one
   `normaliseAbn()` produces. An ABN that fails the ATO check digit is not stored
   at all: the customer form refuses one on save, so a bad value imported here
   would make the record un-editable on a field nobody touched.';

comment on column public.suppliers.contact_name is
  'The person named on the supplier''s own card. Deliberately a column and not a
   `supplier_contacts` table: a customer has many people because a run, an
   invoice and a delivery each reach a different one, and a supplier has one
   name on one card.';

-- ------------------------------------- 2. where this supplier's money lands ---
-- `on delete set null`, so a tidied chart of accounts degrades the default to
-- *unset* rather than blocking the delete or dangling an id — the same call 0044
-- makes for `charge_type_accounts.gl_account_id`.
alter table public.suppliers
  add column if not exists expense_account_id uuid
    references public.gl_accounts(id) on delete set null;

comment on column public.suppliers.expense_account_id is
  'MYOB''s "Category" on the contact card: the account this supplier''s bills post
   to by default. A default for a *new* bill, not a restatement of what any
   historical bill was coded to — `supplier_bills.account_id` is the record of
   that, and it is the column a report reads.';

create index if not exists idx_suppliers_expense_account
  on public.suppliers(expense_account_id) where expense_account_id is not null;

-- --------------------------------------------- 3. an account you can post to ---
-- The three refusals every writer of an account id in this schema already makes
-- (`sync_invoice_line_account` 0036, `guard_job_charge_account` 0039,
-- `guard_charge_type_account` 0044), so a default cannot be set to a heading, to
-- another laundry's account, or to an id that is not an account at all.
--
-- A trigger rather than a check constraint because two of the three questions are
-- about *another row*, which a check constraint cannot ask; and it raises out
-- loud where a restrictive policy would write zero rows in silence.
create or replace function public.guard_supplier_expense_account()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
  if tg_op = 'UPDATE' and new.expense_account_id is not distinct from old.expense_account_id then
    return new;
  end if;
  if new.expense_account_id is null then
    return new;
  end if;

  select id, tenant_id, is_header into a
    from public.gl_accounts where id = new.expense_account_id;

  if a.id is null then
    raise exception 'that account could not be found';
  end if;
  if a.tenant_id <> new.tenant_id then
    raise exception 'that account belongs to another business';
  end if;
  if a.is_header then
    raise exception 'that is a heading, not an account you can code to';
  end if;

  return new;
end $$;

-- `authenticated` named as well as `public, anon` — the trap 0019 recorded and
-- 0036 shipped. Supabase hands every new function a *direct* EXECUTE grant to
-- `authenticated`, which a `from public, anon` revoke leaves standing.
revoke execute on function public.guard_supplier_expense_account() from public, anon, authenticated;

drop trigger if exists guard_supplier_expense_account on public.suppliers;
create trigger guard_supplier_expense_account
  before insert or update of expense_account_id on public.suppliers
  for each row execute procedure public.guard_supplier_expense_account();

-- ====================================================== assert the outcome ==
-- Self-asserting, so a partial apply fails rather than half-landing.
do $$
declare
  v int;
  v_missing text[] := '{}';
begin
  -- 1. Every column arrived, and every one of them is nullable — the whole
  --    claim that this migration cannot change an existing row.
  select count(*) into v from information_schema.columns
   where table_schema = 'public' and table_name = 'suppliers'
     and column_name in ('abn','address_line1','address_line2','suburb','state',
                         'postcode','contact_name','website','expense_account_id')
     and is_nullable = 'YES' and column_default is null;
  if v <> 9 then
    v_missing := v_missing || format('expected 9 nullable no-default columns, found %s', v);
  end if;

  -- 2. The account link points at the chart of accounts — `gl_accounts`, which
  --    is what every other account reference in this schema names — and clears
  --    rather than blocks when one is deleted.
  select count(*) into v from pg_constraint
   where conrelid = 'public.suppliers'::regclass and contype = 'f'
     and confrelid = 'public.gl_accounts'::regclass and confdeltype = 'n';
  if v <> 1 then
    v_missing := v_missing || 'the expense-account FK is missing or not on delete set null'::text;
  end if;

  -- 3. 0036's gate is intact and the permissive `for all` shape 0021 shipped —
  --    replaced four times over in this schema — has not come back.
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'suppliers' and cmd = 'ALL';
  if v <> 0 then v_missing := v_missing || 'a permissive for-all policy is back on suppliers'::text; end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'suppliers'
     and coalesce(qual, '') || coalesce(with_check, '') like '%can_%_purchases%';
  if v <> 4 then
    v_missing := v_missing || format('expected 4 purchases-gated policies on suppliers, found %s', v);
  end if;

  select count(*) into v from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'suppliers' and c.relrowsecurity;
  if v <> 1 then v_missing := v_missing || 'RLS is off on suppliers'::text; end if;

  -- 4. The guard is attached as a row-level BEFORE trigger, and is not on the
  --    RPC surface: a SECURITY DEFINER trigger function published at
  --    /rest/v1/rpc/… can only ever error, which is why it must not be there.
  select count(*) into v from pg_trigger
   where tgrelid = 'public.suppliers'::regclass
     and tgname = 'guard_supplier_expense_account' and not tgisinternal
     and tgtype & 1 = 1 and tgtype & 2 = 2;
  if v <> 1 then v_missing := v_missing || 'the expense-account guard is not attached as a row-level BEFORE trigger'::text; end if;

  if has_function_privilege('authenticated', 'public.guard_supplier_expense_account()', 'execute')
     or has_function_privilege('anon', 'public.guard_supplier_expense_account()', 'execute') then
    v_missing := v_missing || 'guard_supplier_expense_account is on the RPC surface'::text;
  end if;

  -- 5. 0029's posture: `anon` holds nothing on this table.
  select count(*) into v from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'suppliers' and grantee = 'anon';
  if v <> 0 then v_missing := v_missing || format('anon holds %s grants on suppliers', v); end if;

  if array_length(v_missing, 1) is not null then
    raise exception '0045 did not apply cleanly: %', array_to_string(v_missing, '; ');
  end if;
end $$;
