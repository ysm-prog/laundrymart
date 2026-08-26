-- ============================================================================
-- 0038 — a line may be coded to an account of its own
--
-- `push.ts` reads two accounts per invoice line: the line's own
-- (`gl_account_id`) and its item's (`item_id → items.income_account_id`).
-- `resolveAccountCode` prefers the first, because it is somebody's deliberate
-- decision about one line and resolving the item's ahead of it would quietly
-- send a different code to Xero from the one they chose.
--
-- ## Why this migration exists at all
--
-- The column is **already live on `laundrymart-syd`**, added by
-- `0036_invoice_account_codes` from a branch that is not in this repository.
-- Without it here, a database built from these migrations would not carry the
-- column the query names, and the push would fail at request time on a schema
-- this repo produced — compile-clean, test-clean, dead in production.
--
-- So this is the 0018 arrangement again: `add column if not exists`, converging
-- with an unmerged branch rather than racing it. Applying it to the hosted
-- project is a **no-op** that puts the column in this repo's ledger; applying it
-- to a fresh database creates it. Both end in the same shape.
--
-- ## What it deliberately does not do
--
-- That branch also added `invoice_lines.account_code` — *our* chart's code,
-- snapshotted by a trigger when the line is written — and it is **not** added
-- here. Nothing in this repository reads it: the Xero payload needs a **Xero**
-- code, and sending a code from our chart to somebody else's books is the one
-- thing the whole coding design refuses to do. Adding a column no code reads,
-- and a trigger to fill it, would be guessing at that branch's shape.
--
-- Adds no table, no policy and no function. Changes no row, and cannot: the
-- column is nullable with no default, so every existing line is untouched.
-- ============================================================================

alter table public.invoice_lines
  add column if not exists gl_account_id uuid
    references public.gl_accounts(id) on delete set null;

comment on column public.invoice_lines.gl_account_id is
  'The account this line was explicitly coded to. Resolved to '
  'gl_accounts.xero_account_code at push time and preferred over the item''s '
  'income account, because coding one line is a deliberate decision about that '
  'line. Null means "nobody has coded this line", not "code it to nothing".';

-- Same name as the unmerged branch's, so this is a no-op where that ran first.
create index if not exists idx_invoice_lines_account
  on public.invoice_lines (tenant_id, gl_account_id)
  where gl_account_id is not null;

do $$
declare
  v_fks integer;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='invoice_lines'
                    and column_name='gl_account_id') then
    raise exception '0038: invoice_lines.gl_account_id is missing' using errcode='P0001';
  end if;

  -- Nullable, so no existing line is invalidated and none is coded by accident.
  if (select is_nullable from information_schema.columns
       where table_schema='public' and table_name='invoice_lines'
         and column_name='gl_account_id') <> 'YES' then
    raise exception '0038: gl_account_id is not nullable' using errcode='P0001';
  end if;

  -- **The assertion that earns its place.** The push embeds
  -- `line_account:gl_accounts(...)` on this table, and PostgREST resolves an
  -- embed by finding *one* foreign key. A second FK from `invoice_lines` to
  -- `gl_accounts` would make that embed ambiguous and the push would die with
  -- PGRST201 at request time — a failure no typecheck and no unit test can see,
  -- and one this repository has shipped once already.
  select count(*) into v_fks from pg_constraint
   where conrelid = 'public.invoice_lines'::regclass
     and contype = 'f'
     and confrelid = 'public.gl_accounts'::regclass;
  if v_fks <> 1 then
    raise exception '0038: invoice_lines has % foreign keys to gl_accounts, expected exactly 1', v_fks
      using errcode='P0001';
  end if;

  -- The other hop the same query makes, for the same reason.
  select count(*) into v_fks from pg_constraint
   where conrelid = 'public.items'::regclass
     and contype = 'f'
     and confrelid = 'public.gl_accounts'::regclass;
  if v_fks <> 1 then
    raise exception '0038: items has % foreign keys to gl_accounts, expected exactly 1', v_fks
      using errcode='P0001';
  end if;
end $$;
