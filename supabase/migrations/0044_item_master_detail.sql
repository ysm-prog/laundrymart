-- ============================================================================
-- 0044_item_master_detail — the fields MYOB's item page actually holds.
--
-- `items` carries what the MYOB **inventory export** carries, because that is
-- the export that was read (0032 added the columns, 0040 gated the writes, and
-- §25 records the discipline: read the real file, do not guess its column
-- names). The owner has since opened all 257 of Adelaide's active items in MYOB
-- one at a time and captured every field on the item page. Nine of those fields
-- have nowhere to live in this schema, and two of them change what an invoice
-- line should say.
--
-- **Additive by construction.** Every column below is nullable or
-- `not null default`, no column is renamed, no row is rewritten, and nothing
-- reads any of them until the screens in the same commit do. So every existing
-- screen, every price tier, every report and every historical row behaves
-- exactly as it did before this applied — which is what makes it safe to put on
-- a table holding a real business's 254-line master list.
--
-- **All twelve arrive null (or at their default) for all 254 imported rows**,
-- and stay that way until either somebody edits an item or the detail import
-- lands. That importer is deliberately **not** written here: §25 records what it
-- cost the bills import to guess at a column name, and the same rule applies —
-- it belongs beside `myob/inventory.ts` and it reads the real file first.
--
-- ---------------------------------------------------------------------------
-- Two decisions worth stating rather than making quietly.
--
-- **1. Three of the fifteen fields already exist, from `0043`, and are reused
-- rather than added again under new names.** `0043_myob_invoice_lines` shipped
-- `items.selling_unit`, `items.items_per_selling_unit` and
-- `items.sell_price_basis` — the same three facts, with the same meanings and
-- (for the basis) the identical `('inclusive','exclusive')` check constraint. It
-- came from a branch that never reached this repository and was reconstructed
-- from the live ledger, which is why **nothing in `src/` has ever read them**:
-- they are columns with no reader. Adding `sell_unit` and `sell_units_per`
-- beside them would have produced two answers to one question on a table the
-- whole application resolves through — the duplication this repo argues against
-- everywhere — and the older pair is the one the live database already holds. So
-- this migration adds **twelve** columns and asserts the other three are present,
-- which is also what gives 0043's three their first reader.
--
--   asked for            what is used            added by
--   sell_price_basis     sell_price_basis        0043
--   sell_unit            selling_unit            0043
--   sell_units_per       items_per_selling_unit  0043
--
-- `buy_units_per` therefore lands at `numeric(12,2)` and not `(12,3)`: it is the
-- same question as `items_per_selling_unit` on the other side of the ledger, and
-- two sides of one pair disagreeing about precision is a difference somebody
-- would later have to explain.
--
-- **2. The chart of accounts is `gl_accounts`, not `accounts`.** All four
-- account references below point at `public.gl_accounts(id)`, which is the table
-- 0021 created and 0036 gated.
--
-- Every account and supplier reference is `on delete set null`, matching
-- `items.income_account_id` (0036) and for its reason: losing the link is
-- recoverable, and a chart of accounts is reference data that gets tidied.
-- `restrict` would make an account undeletable because one item mentions it.
--
-- ---------------------------------------------------------------------------
-- **RLS: nothing new, and that is asserted rather than assumed.** 0040 replaced
-- 0002's permissive `for all` on `items` with four explicit policies — read to
-- every member, insert/update/delete on `can_write_items()` — and a policy is
-- attached to a *table*, so a column added here is covered by all four the
-- moment it exists. What this migration has to prove is that it did not undo
-- that: no permissive `for all` has come back, the four are still there, and
-- `anon` still holds no grant on the table (0029's posture, which every
-- migration since has had to keep).
-- ============================================================================

-- ----------------------------------------------------- what MYOB calls it ---
-- Nine fields, in the order MYOB's own item page asks them, so somebody holding
-- the two screens side by side can read down.
alter table public.items
  -- "Use item description on sales and purchases". MYOB's own switch between
  -- printing the item *name* on a document and printing its longer description.
  -- A boolean and not a nullable one: an item nobody has answered for prints its
  -- name, which is what every document this app has produced so far does.
  add column if not exists use_item_description boolean not null default false,

  -- "I track stock for this item". Distinct from anything already here:
  -- `inventory_pools` records what is *where*, and this records whether MYOB
  -- counts the item at all. Most of Adelaide's 254 are consumables it buys and
  -- does not count.
  add column if not exists track_stock boolean not null default false,

  -- "Asset category for tracking inventory" — where the stock on hand sits on
  -- the balance sheet. Only meaningful when `track_stock` is on, and deliberately
  -- **not** constrained to that: MYOB itself lets the account survive the switch
  -- being turned off, and a check constraint here would refuse an import of a row
  -- that is legal in the system it came from.
  add column if not exists asset_account_id uuid references public.gl_accounts(id) on delete set null,

  -- "Cost of sales category". The other half of a sale: the income account says
  -- where the money lands, this says where the cost of what was sold is booked.
  add column if not exists cost_of_sales_account_id uuid references public.gl_accounts(id) on delete set null,

  -- The buying side of the three questions the selling side already answers
  -- (`sell_price_basis`, `selling_unit`, `items_per_selling_unit` — all 0043).
  -- Same shapes, same constraint vocabulary, so the two halves of the item page
  -- read identically.
  add column if not exists buy_price_basis text,
  add column if not exists buy_unit text,
  add column if not exists buy_units_per numeric(12,2),

  -- "Buying tax code". **The existing `tax_code` is the *selling* one and is
  -- deliberately not renamed**: `line-form.tsx` already reads it that way
  -- (`taxableFromTaxCode(chosen.tax_code)` when an item is picked onto an
  -- invoice line), so renaming it would move a live read for no gain and leave
  -- every caller to be found by hand. Unchecked, for the reason 0021 gives about
  -- `gl_accounts.tax_code` and 0032 about this one: it is somebody else's
  -- vocabulary, and a check constraint here needs migrating every time the
  -- bookkeeper adds a code.
  add column if not exists buy_tax_code text,

  -- "Expense category for tracking purchases", for an item that is bought and
  -- not stocked — which is most of this laundry's list.
  add column if not exists expense_account_id uuid references public.gl_accounts(id) on delete set null,

  -- "Supplier item ID": what the *supplier* calls it, which is routinely not
  -- what we call it. Free text, and no unique index — two suppliers can use one
  -- code, and this laundry's own codes are already unique through `uq_items_code`.
  add column if not exists supplier_item_code text,

  add column if not exists primary_supplier_id uuid references public.suppliers(id) on delete set null,

  -- "Default reorder quantity", per **buying** unit. Distinct from the existing
  -- `reorder_level`, which is MYOB's "Minimum stock level" — the point at which
  -- to reorder, against how much to order. Both are real and they are not the
  -- same number, so `reorder_level` is left exactly as it is.
  add column if not exists default_reorder_qty numeric(12,2) not null default 0;

do $$ begin
  -- The buying basis, spelled the same way as 0043 spelled the selling one, so
  -- one rule reads both. Guarded because this migration is expected to be
  -- re-runnable against a database that already has it.
  if not exists (select 1 from pg_constraint where conname = 'chk_items_buy_price_basis') then
    alter table public.items add constraint chk_items_buy_price_basis
      check (buy_price_basis is null or buy_price_basis in ('inclusive','exclusive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_items_buy_units_per') then
    alter table public.items add constraint chk_items_buy_units_per
      check (buy_units_per is null or buy_units_per > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_items_default_reorder_qty') then
    alter table public.items add constraint chk_items_default_reorder_qty
      check (default_reorder_qty >= 0);
  end if;
end $$;

comment on column public.items.use_item_description is
  'MYOB''s "Use item description on sales and purchases" — print the description '
  'on a document rather than the name.';
comment on column public.items.track_stock is
  'MYOB''s "I track stock for this item". Whether the item is counted at all, '
  'which is a different question from where inventory_pools says it is.';
comment on column public.items.buy_tax_code is
  'The BUYING tax code. items.tax_code is the selling one and is not renamed — '
  'line-form.tsx already reads it as the sell-side answer.';
comment on column public.items.default_reorder_qty is
  'MYOB''s "Default reorder quantity", per buying unit. items.reorder_level is '
  'the separate "Minimum stock level" — how much to order against when to order.';
comment on column public.items.primary_supplier_id is
  'Who this is ordered from. Nullable and null everywhere until somebody says so; '
  'set null on delete, so removing a supplier never makes an item unsaveable.';

-- The two lookups a screen actually does over these: "what do I buy from this
-- supplier?" and "which items post to this account?". Partial, because both
-- columns are null on every row today and an index over 254 nulls is a cost with
-- no reader.
create index if not exists idx_items_primary_supplier
  on public.items(tenant_id, primary_supplier_id) where primary_supplier_id is not null;
create index if not exists idx_items_expense_account
  on public.items(tenant_id, expense_account_id) where expense_account_id is not null;

-- ====================================================== assert the outcome ==
-- Fail rather than half-apply, the way 0032, 0036, 0040 and 0043 do.
do $$
declare n int;
begin
  -- 1. All twelve new columns landed. Counted rather than eyeballed, because a
  --    typo in a column name inside one `alter table` is silent — the statement
  --    succeeds and the screen reading the misspelt name fails at request time,
  --    where no typecheck and no unit test can see it.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'items'
     and column_name in (
       'use_item_description','track_stock','asset_account_id','cost_of_sales_account_id',
       'buy_price_basis','buy_unit','buy_units_per','buy_tax_code','expense_account_id',
       'supplier_item_code','primary_supplier_id','default_reorder_qty');
  if n <> 12 then
    raise exception '0044: % of the 12 new item columns are present', n;
  end if;

  -- 2. **0043's three are here, which is the half this migration depends on
  --    rather than creates.** The selling unit and the price basis are what the
  --    invoice line composer in this same commit reads; if 0043 has not applied,
  --    the screens ship against columns that do not exist and fail in the
  --    browser. Asserting it here is what turns that into a failed migration.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'items'
     and column_name in ('selling_unit','items_per_selling_unit','sell_price_basis');
  if n <> 3 then
    raise exception '0044: 0043''s three selling columns are not all present (% of 3) — '
                    'this migration reuses them rather than adding sell_unit/sell_units_per', n;
  end if;

  -- 3. The existing pair this deliberately did **not** touch. `tax_code` stays
  --    the selling code and `reorder_level` stays the minimum stock level; if
  --    either had been renamed by a future edit to this file, the new column
  --    beside it would silently become the only answer.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'items' and column_name = 'tax_code')
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'items' and column_name = 'reorder_level') then
    raise exception '0044: items.tax_code or items.reorder_level is gone — both are kept, '
                    'and buy_tax_code / default_reorder_qty sit beside them rather than replacing them';
  end if;

  -- 4. Every reference points at the real tables. `gl_accounts`, not `accounts`.
  select count(*) into n
    from pg_constraint c
   where c.conrelid = 'public.items'::regclass and c.contype = 'f'
     and c.confrelid = 'public.gl_accounts'::regclass;
  -- income_account_id (0036) + the three added here.
  if n <> 4 then
    raise exception '0044: items has % foreign keys to gl_accounts, expected 4', n;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.items'::regclass and contype = 'f'
                   and confrelid = 'public.suppliers'::regclass) then
    raise exception '0044: items has no foreign key to suppliers';
  end if;

  -- 5. Additive means additive: nothing here may make an existing row illegal.
  --    Asked of the real rows rather than reasoned about, so a check constraint
  --    written the wrong way round fails the migration instead of the next save.
  select count(*) into n from public.items
   where default_reorder_qty is null or default_reorder_qty < 0;
  if n > 0 then
    raise exception '0044: % existing item(s) violate the new reorder-quantity check', n;
  end if;

  -- 6. 0040's gate is intact. This migration writes no policy, so the failure it
  --    is guarding against is a future edit adding one — and the shape that has
  --    had to be replaced four times in this schema (0006, 0018, 0021, 0002) is a
  --    permissive `for all`, whose USING half grants SELECT as well as the writes.
  select count(*) into n from pg_policy
   where polrelid = 'public.items'::regclass and polcmd = '*';
  if n <> 0 then
    raise exception '0044: % permissive for-all policy/policies are back on items', n;
  end if;

  select count(*) into n from pg_policy
   where polrelid = 'public.items'::regclass
     and polname in ('items_read','items_insert','items_update','items_delete');
  if n <> 4 then
    raise exception '0044: % of 0040''s 4 policies on items', n;
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.items'::regclass) then
    raise exception '0044: row level security is not enabled on items';
  end if;

  -- 7. 0029's posture. A column added to an existing table must not have handed
  --    `anon` a grant back — which is exactly the drift 0029 exists to stop, and
  --    which 0032 asserts here for the same reason.
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'items' and grantee = 'anon';
  if n > 0 then
    raise exception '0044: anon holds % table grant(s) on items', n;
  end if;
end $$;
