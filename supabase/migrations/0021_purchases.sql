-- ============================================================================
-- 0014_purchases — the money going out, and the ledger it codes to.
--
-- The app had only the receivable half of the books: customers, invoices,
-- payments, credit notes. Everything payable — who we buy from, what they
-- billed us, what we ordered — had no home, and neither did the chart of
-- accounts that every one of those documents is coded against.
--
-- Four tables, all plain tenant-scoped records. No document here drives stock
-- or triggers anything: a bill is a statement of what is owed, so unlike
-- `move_inventory()` or `recalculate_invoice()` there is nothing to keep in
-- step. The guards below are therefore integrity checks only.
-- ============================================================================

-- -------------------------------------------------------------- suppliers ---
-- Deliberately not folded into `customers`. The two share a name and an email
-- and nothing else: a customer has locations, contracts, routing and RLS that
-- reaches drivers, none of which mean anything for a supplier. A shared
-- "contacts" table would have made every customer query filter on a type flag.
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_number text not null,
  name text not null,
  phone text,
  email text,
  -- Balance carried in from the previous system. Not a running total: bills
  -- hold that, and a stored duplicate would drift the moment one is paid.
  opening_balance numeric(12,2) not null default 0,
  notes text,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_suppliers_number on public.suppliers(tenant_id, supplier_number);
create unique index uq_suppliers_name on public.suppliers(tenant_id, lower(name))
  where deleted_at is null;

-- ------------------------------------------------------------ gl accounts ---
-- The chart of accounts, kept flat with the level it sat at in the source
-- rather than as a parent FK. The export gives a depth, not a parent, and
-- inferring one from code prefixes would invent a hierarchy the business never
-- stated. `is_header` marks the classification rows that carry no code of their
-- own (Assets, Liability, Equity, Income, Cost of Sales, Expenses).
create table public.gl_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  account_type text not null,
  -- AU GST codes as the books use them: GST, FRE (GST-free), N-T (not
  -- reportable). Left unchecked because a chart of accounts is reference data
  -- copied from an accounting package, and a check constraint here would need
  -- migrating every time the bookkeeper adds a code.
  tax_code text,
  is_linked boolean not null default false,
  is_header boolean not null default false,
  level integer not null default 1 check (level between 1 and 4),
  current_balance numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_gl_accounts_code on public.gl_accounts(tenant_id, code);
create index idx_gl_accounts_type on public.gl_accounts(tenant_id, account_type);

-- ----------------------------------------------------------------- bills ---
-- What a supplier has invoiced us. `amount` and `balance_due` are both stored
-- rather than balance being derived: there are no payment rows behind a bill
-- imported from a previous system, so a generated column would read zero and
-- silently claim every historical bill is unpaid.
create table public.supplier_bills (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  account_id uuid references public.gl_accounts(id) on delete set null,
  bill_number text not null,
  supplier_invoice_no text,
  issue_date date not null default current_date,
  due_date date,
  amount numeric(12,2) not null default 0,
  balance_due numeric(12,2) not null default 0,
  -- The three states the books use. `debit` is a supplier debit note — money
  -- owed back to us — which is why a negative balance is legal throughout.
  status text not null default 'open' check (status in ('open','closed','debit')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz,
  constraint supplier_bills_due_after_issue check (due_date is null or due_date >= issue_date)
);
create unique index uq_supplier_bills_number on public.supplier_bills(tenant_id, bill_number);
create index idx_supplier_bills_supplier on public.supplier_bills(supplier_id, issue_date desc);
-- The chase query: what is still owed, oldest first.
create index idx_supplier_bills_outstanding on public.supplier_bills(tenant_id, due_date)
  where balance_due <> 0;

-- ------------------------------------------------------- purchase orders ---
create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  po_number text not null,
  supplier_invoice_no text,
  issue_date date not null default current_date,
  promised_date date,
  amount numeric(12,2) not null default 0,
  balance_due numeric(12,2) not null default 0,
  status text not null default 'open' check (status in ('open','received','closed','cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz,
  constraint purchase_orders_promised_after_issue
    check (promised_date is null or promised_date >= issue_date)
);
create unique index uq_purchase_orders_number on public.purchase_orders(tenant_id, po_number);
create index idx_purchase_orders_supplier on public.purchase_orders(supplier_id, issue_date desc);

-- ------------------------------------------------- the receivable side too ---
-- Two facts the customer list carried over from the previous system that had
-- nowhere to live. Both are per-customer, so neither fits `tenants.settings`.
alter table public.customers
  -- What the customer owed on the day the books were carried across, and how
  -- much of that was already past terms. Kept apart from anything the app
  -- computes: invoices raised here have their own balances, and adding an
  -- opening figure into them would double-count from the first period.
  add column if not exists opening_balance numeric(12,2) not null default 0,
  add column if not exists opening_balance_overdue numeric(12,2) not null default 0,
  -- Per-customer consent for the overdue chase. The tenant-wide switch decides
  -- whether the chase runs at all; this decides who is in it, which is a
  -- decision the business had already made customer by customer. Honoured in
  -- the sweep — a switch that looks like it stops mail but does not would be
  -- worse than not importing the column.
  add column if not exists reminders_enabled boolean not null default true;

-- ------------------------------------------------------------------- RLS ---
-- §3: a new table cannot ship without a policy. Tenant isolation only — these
-- are not resource-scoped the way a driver's paperwork is, and the capability
-- gate (`purchases.read` / `purchases.write`) is applied in the app on top.
select public.apply_tenant_policy('suppliers');
select public.apply_tenant_policy('gl_accounts');
select public.apply_tenant_policy('supplier_bills');
select public.apply_tenant_policy('purchase_orders');

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
-- No function grants: §7 keeps `anon` revoked, and 0011 is what enforces it.
