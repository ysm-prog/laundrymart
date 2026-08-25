-- ============================================================================
-- 0036_invoice_account_codes — an invoice line says where the money lands.
--
-- The business keeps its books in MYOB against a chart of 268 accounts, 24 of
-- them income accounts, and every sale has to be coded to one: towels to
-- `4-1100 Towels - Black`, a delivery to `4-2000 Delivery Fees Collected`. This
-- app has held that chart since 0021 (`gl_accounts`) and has never once written
-- a code onto an invoice, so the bookkeeper re-codes every line by hand.
--
-- The client's ask, in their words: an invoice line can be added **by selecting
-- an item or by the code**, and something that is in neither list **is a line of
-- free text**. That is three ways to *fill* a line, not three kinds of line —
-- so nothing here adds a `line_kind` column. Every line still carries a
-- description, a quantity, a price and a GST flag, and may now additionally
-- name an item, an account, or both.
--
-- Three parts, and the first is not the feature:
--
--   1. the payable side stops being readable and writable by everybody;
--   2. an item names the income account its sales are tracked to;
--   3. an invoice line carries the account and a snapshot of its code.
--
-- ---------------------------------------------------------------------------
-- Part 1 is here because part 3 makes `gl_accounts` load-bearing for a screen,
-- and the table is wide open. `apply_tenant_policy` (0021) gave all six payable
-- tables one permissive `for all … using is_member(tenant_id)` policy, which is
-- the identical shape 0006 shipped on `invoices`, 0017 replaced, 0018 repeated
-- on `laundry_prices` and 0033 replaced one migration ago. **This is the third
-- time.** Probed as one of Adelaide's own `board` logins on 2026-08-25, before
-- anything here was written:
--
--     gl_accounts       268   (including Owner's Drawings, every loan balance)
--     suppliers         192
--     supplier_bills  1,515   ($65,724 outstanding)
--     invoices            0   ← 0017/0025 holding
--     laundry_prices      0   ← 0033 holding
--
-- and an UPDATE renaming `4-1600 Laundry` **succeeded**, because a `for all`
-- policy grants the writes too. A delivery round could rewrite the chart of
-- accounts. It hid for the same reason 0033's defect hid: the demo tenant has
-- no accounts and no bills, so the 2026-08-20 sweep that found `laundry_prices`
-- read 0 from these six and they looked clean. **An empty table is not a proof.**
--
-- `purchases.read` / `purchases.write` already exist in `roles.ts` and already
-- name the holders. This migration is the database finally saying the same.
-- ============================================================================

-- ================================================== 1. the payable side =====

-- `purchases.*` holders, from `src/lib/roles.ts`. Named as a role list rather
-- than derived from `can_read_billing()` because §3 records these two sets as
-- deliberately independent: a dispatcher holds `invoices.read` and no
-- `purchases.*`, and finance holds `purchases.*` and no `invoices.*`. Deriving
-- one from the other is exactly what that decision refused.
create or replace function public.can_read_purchases(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array[
    'super_admin','operations_manager','finance',
    'branch_manager','regional_manager','auditor'
  ]);
$$;

create or replace function public.can_write_purchases(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array[
    'super_admin','operations_manager','finance','branch_manager','regional_manager'
  ]);
$$;

comment on function public.can_read_purchases(uuid) is
  'Who may read the payable side and the chart of accounts: the holders of '
  'purchases.read in roles.ts. Not derived from can_read_billing — §3 keeps the '
  'two sets independent on purpose.';

-- §7: PostgREST publishes `public` as RPC, so anything executable by `anon` is
-- an unauthenticated endpoint. These answer a question about the caller, which
-- is exactly why they must not be callable *as* nobody.
revoke all on function public.can_read_purchases(uuid) from public, anon;
revoke all on function public.can_write_purchases(uuid) from public, anon;
grant execute on function public.can_read_purchases(uuid) to authenticated, service_role;
grant execute on function public.can_write_purchases(uuid) to authenticated, service_role;

-- The six tables 0021/0022/0024 created, each carrying one permissive `for all`
-- policy and nothing else. Replaced rather than supplemented, for the reason
-- 0033 states in full: **a `for all` policy's USING half grants SELECT too**, so
-- a narrowed read policy beside it would be a second door standing open.
--
-- None of these is in `archivable_tables()` — the payable ledger is not a
-- customer's paperwork — so there is no `archived_at` clause to preserve and the
-- 0028 trap does not apply.
do $$
declare
  t text;
begin
  foreach t in array array[
    'gl_accounts','suppliers','supplier_bills','purchase_orders',
    'supplier_payments','import_activation_state'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_member', t);

    execute format(
      'create policy %I on public.%I for select to authenticated
         using ((select public.can_read_purchases(tenant_id)))',
      t || '_read', t);

    -- Split from one `for all`, so no USING half is a second door onto SELECT.
    execute format(
      'create policy %I on public.%I for insert to authenticated
         with check ((select public.can_write_purchases(tenant_id)))',
      t || '_insert', t);

    execute format(
      'create policy %I on public.%I for update to authenticated
         using ((select public.can_write_purchases(tenant_id)))
         with check ((select public.can_write_purchases(tenant_id)))',
      t || '_update', t);

    execute format(
      'create policy %I on public.%I for delete to authenticated
         using ((select public.can_write_purchases(tenant_id)))',
      t || '_delete', t);
  end loop;
end $$;

-- ============================================ 2. an item names its account ==
-- MYOB's "Income Account for Tracking Sales", which is the bridge that makes
-- "select the item" produce a code without anybody typing one. Nullable, and
-- deliberately so: an item that has never been sold has no account, and refusing
-- to save one until somebody picks would put the item master behind the chart.
--
-- `on delete set null` rather than `restrict`: losing the link is recoverable,
-- and a chart of accounts is reference data that gets tidied.
alter table public.items
  add column if not exists income_account_id uuid references public.gl_accounts(id) on delete set null;

comment on column public.items.income_account_id is
  'The income account this item''s sales are tracked to. What makes picking an '
  'item on an invoice fill in the code.';

create index if not exists idx_items_income_account
  on public.items(tenant_id, income_account_id)
  where income_account_id is not null;

-- ======================================= 3. the invoice line's own code =====
-- Two columns for one fact, which is normally the bug this repo argues against
-- everywhere — so the trigger below refuses every way they could disagree,
-- exactly as 0016 does for the assignment and 0032 for the item's category.
--
-- The link is what a report joins on; the text is what survives. An invoice is a
-- legal record of what a customer was told, so a chart tidied next year must not
-- rewrite what a sent invoice said it was coded to. That is the same split
-- `item_id` + `description` has carried since 0006.
alter table public.invoice_lines
  add column if not exists gl_account_id uuid references public.gl_accounts(id) on delete set null,
  add column if not exists account_code text;

comment on column public.invoice_lines.gl_account_id is
  'The income account this line is coded to, when one has been chosen. Null is '
  'legal and visible: a free-text line codes to nothing until somebody says.';
comment on column public.invoice_lines.account_code is
  'The account''s code as it stood when the line was written. Kept as text so a '
  'renumbered or deleted account cannot rewrite a sent invoice.';

create index if not exists idx_invoice_lines_account
  on public.invoice_lines(tenant_id, gl_account_id)
  where gl_account_id is not null;

-- The coherence rule, in the database because `invoice_lines` is written by four
-- different paths — the manual composer, the month-end roll-up, the per-job
-- generator and any future import — and a rule stated in one of them is a rule
-- three of them can break.
--
-- **SECURITY DEFINER, and the tenant check inside is what pays for it.** Part 1
-- above puts `gl_accounts` behind `purchases.read`. Every holder of
-- `invoices.write` holds that today, but an invoker-rights trigger would make
-- that coincidence load-bearing: split the roles tomorrow and a legitimate line
-- would be refused with "that account could not be found" for an account that
-- plainly exists. So the lookup runs with definer rights and the function
-- compares `tenant_id` itself — the same trade `next_number()` made in 0010, and
-- the reason the comparison below is not optional.
create or replace function public.sync_invoice_line_account()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
  -- Fires only when the account actually changes, so re-costing or renumbering a
  -- line never re-judges history. Same reasoning as `guard_laundry_order_assignment`.
  if tg_op = 'UPDATE' and new.gl_account_id is not distinct from old.gl_account_id then
    return new;
  end if;

  if new.gl_account_id is null then
    -- Deliberately does **not** clear `account_code`. `on delete set null` fires
    -- this path when an account is removed from the chart, and the whole point of
    -- the snapshot is that the invoice still says what it was coded to.
    return new;
  end if;

  select id, tenant_id, code, is_header into a
    from public.gl_accounts where id = new.gl_account_id;

  if a.id is null then
    raise exception 'that account could not be found';
  end if;
  if a.tenant_id <> new.tenant_id then
    raise exception 'that account belongs to another business';
  end if;
  -- The six MYOB classification rows (Assets, Income, …) carry a synthetic code
  -- and no meaning. Nothing may be coded to one. Which *kind* of account is
  -- allowed is deliberately not policed here — a bookkeeper offsetting a
  -- recharge against an expense account is doing their job, and the screen
  -- offers income accounts first rather than refusing the rest.
  if a.is_header then
    raise exception 'that is a heading, not an account you can code to';
  end if;

  new.account_code := a.code;
  return new;
end $$;

revoke all on function public.sync_invoice_line_account() from public, anon;

drop trigger if exists sync_invoice_line_account on public.invoice_lines;
create trigger sync_invoice_line_account
  before insert or update of gl_account_id on public.invoice_lines
  for each row execute procedure public.sync_invoice_line_account();

-- ====================================================== assert the outcome ==
-- Self-asserting, so a partial apply fails rather than half-landing.
do $$
declare
  t text;
  v_for_all int;
  v_read text;
  v_missing text[] := '{}';
begin
  foreach t in array array[
    'gl_accounts','suppliers','supplier_bills','purchase_orders',
    'supplier_payments','import_activation_state'
  ] loop
    -- 1. No permissive `for all` policy survives, or its USING half is a second
    --    door onto SELECT and the read gate below means nothing.
    select count(*) into v_for_all from pg_policy
      where polrelid = format('public.%I', t)::regclass
        and polcmd = '*' and polpermissive;
    if v_for_all <> 0 then
      raise exception '0036: a permissive `for all` policy still stands on %', t;
    end if;

    -- 2. The read is gated.
    select pg_get_expr(polqual, polrelid) into v_read from pg_policy
      where polrelid = format('public.%I', t)::regclass and polname = t || '_read';
    if v_read is null or v_read not like '%can_read_purchases%' then
      v_missing := v_missing || t;
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception '0036: read policy not gated on can_read_purchases for: %',
      array_to_string(v_missing, ', ');
  end if;

  -- 3. The two new columns and the coherence trigger are actually there.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'invoice_lines'
                   and column_name = 'gl_account_id') then
    raise exception '0036: invoice_lines.gl_account_id is missing';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'items'
                   and column_name = 'income_account_id') then
    raise exception '0036: items.income_account_id is missing';
  end if;
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.invoice_lines'::regclass
                   and tgname = 'sync_invoice_line_account') then
    raise exception '0036: the account coherence trigger is not attached';
  end if;

  -- 4. Neither new helper is reachable without a login. §7's standing rule.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('can_read_purchases','can_write_purchases','sync_invoice_line_account')
      and has_function_privilege('anon', p.oid, 'execute')
  ) then
    raise exception '0036: a new function is executable by anon';
  end if;
end $$;
