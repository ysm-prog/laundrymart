-- ============================================================================
-- 0017_laundry_pricing — what a customer pays for the laundry they hand over,
-- and the link that lets a job be billed exactly once.
--
-- Until now the counter's Jobs (0014) carried no money at all: a job records
-- what arrived and what happened to it, and `laundry_order_items` has a
-- quantity but no price. Recurring invoicing (0006 + the generator) billed
-- *contracts* only — the scheduled service pattern, its per-kg weights and its
-- replacement charges. A customer who simply drops laundry at the counter was
-- therefore never billed for it by the app.
--
-- Two things are added, and nothing existing is altered:
--
--  1. `laundry_prices` — a price per kind of laundry, either for one customer
--     or as the tenant's default. Deliberately its own table rather than a
--     column on `items`: `items` is the linen *the laundry owns and rents out*,
--     and 0014 already refused to point the counter's item vocabulary at it,
--     for the same reason — a counter hand must not have to create a stock
--     record before they can take in a bag of sheets.
--
--     One table for both scopes, with `customer_id is null` meaning "the price
--     everyone gets unless they have their own". Two tables would have doubled
--     every read and left "which one wins" to be re-decided at each call site.
--
--  2. `invoice_lines.laundry_order_id` — the job a billed line came from. It is
--     what makes the monthly run idempotent: a job already carried on a
--     non-void invoice is skipped rather than billed a second time. Nullable
--     and `on delete set null`, exactly like the `job_id` (a *stop*) beside it.
--
-- No table is dropped, no policy is rewritten and no existing row is touched.
-- ============================================================================

-- ------------------------------------------------------------ the prices ----
create table public.laundry_prices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- Null is the tenant's default price list. A row with a customer is that
  -- customer's own price and wins over the default (src/lib/domain/laundry-billing.ts).
  customer_id uuid references public.customers(id) on delete cascade,

  -- The same nine values 0014 gives `laundry_order_items.item_type`, because a
  -- price that cannot be matched to a line of laundry prices nothing. Restated
  -- rather than shared through a lookup table: 0014 spells it as a check
  -- constraint too, and a third spelling in a third place is what drifts.
  item_type text not null check (item_type in (
    'towels','hand_towels','bath_towels','bath_mats','sheets','pillowcases',
    'linen','uniforms','other'
  )),

  -- Per piece. The counted case, which is most of them.
  unit_price numeric(12,2) not null default 0 check (unit_price >= 0),

  -- Per bag, for a bulk lot that was never counted. Optional and null by
  -- default: a laundry that counts everything should not be made to invent a
  -- bag rate, and a bulk lot with no bag price falls back to its estimated
  -- piece count rather than being priced from thin air.
  bag_price numeric(12,2) check (bag_price is null or bag_price >= 0),

  taxable boolean not null default true,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);

-- One price per kind of laundry per scope. `nulls not distinct` is what makes
-- that true of the default list as well — under the default rule every NULL
-- customer_id is distinct, so the tenant default is exactly the row that could
-- have been duplicated. Postgres 15+, as already required by 0013.
create unique index uq_laundry_prices_scope
  on public.laundry_prices(tenant_id, customer_id, item_type) nulls not distinct;

-- The read the invoice generator and both price screens make: everything for a
-- tenant, then the customer's own rows picked out of it.
create index idx_laundry_prices_customer
  on public.laundry_prices(tenant_id, customer_id);

comment on column public.laundry_prices.customer_id is
  'Null means the tenant default price list. A customer row overrides it.';
comment on column public.laundry_prices.bag_price is
  'Optional per-bag rate for bulk lots. Null means bulk lots are billed on their estimated piece count.';

-- ------------------------------------------------------------------- RLS ----
-- Reads are tenant-wide; writes need a finance/admin role. `apply_tenant_policy`
-- is deliberately not used here: it attaches one permissive `for all` policy,
-- which would OR with the role gate below and hand every member the ability to
-- change what a customer is charged. This is the same shape 0006 gives the
-- invoice tables, and the same four roles — a price list is a finance record.
alter table public.laundry_prices enable row level security;
create index idx_laundry_prices_tenant on public.laundry_prices(tenant_id);
create trigger set_laundry_prices_updated_at before update on public.laundry_prices
  for each row execute procedure public.set_updated_at();

create policy laundry_prices_read on public.laundry_prices
  for select to authenticated
  using ((select public.is_member(tenant_id)));

create policy laundry_prices_write on public.laundry_prices
  for all to authenticated
  using ((select public.has_role(tenant_id,
    array['super_admin','operations_manager','finance','dispatcher'])))
  with check ((select public.has_role(tenant_id,
    array['super_admin','operations_manager','finance','dispatcher'])));

-- Table grants only. **No function grants**: 0011 revoked the blanket
-- `grant execute … to anon` that exposed every SECURITY DEFINER helper on
-- /rest/v1/rpc, and re-adding it here would silently undo that.
grant select, insert, update, delete on public.laundry_prices to authenticated;
grant all on public.laundry_prices to service_role;

-- ------------------------------------------------- the billed-once link ----
-- Which job a line came from. Read by the generator to skip work already
-- invoiced, and by the invoice screen to link a line back to the job it bills.
alter table public.invoice_lines
  add column laundry_order_id uuid references public.laundry_orders(id) on delete set null;

-- Partial: only a minority of lines are laundry lines, and the lookup is always
-- "has this job been billed?".
create index idx_invoice_lines_laundry_order
  on public.invoice_lines(laundry_order_id)
  where laundry_order_id is not null;

comment on column public.invoice_lines.laundry_order_id is
  'The laundry job (0014) this line bills. Non-void lines on it are what stop a job being billed twice.';
