-- ============================================================================
-- 0043_myob_invoice_lines — GST inside the price, and the columns MYOB's
-- invoice line carries.
--
-- **This file was reconstructed from the statements this migration applied to
-- `laundrymart-syd` on 2026-08-26 (`20260826115214`), and every statement below
-- is byte-identical to what ran there** — verified by md5 against the ledger
-- (`63e12d194b94fd82c793947d579842a0`) rather than by eye. It was authored on a
-- branch that has not reached this repository; what is missing here is that
-- author's prose, not any of their SQL. If their branch lands, this path
-- conflicts and theirs is the one to keep.
--
-- It is in the repo because the divergence was not cosmetic. CI builds a fresh
-- database from `supabase/migrations/` alone, so without this file that database
-- computes invoice totals **differently from production**: 0006's
-- `recalculate_invoice` adds GST on top of the lines (`total = sub + tax`),
-- and this one treats the line amount as GST-inclusive and extracts the tax out
-- of it (`total = sub`, `tax = sub * rate/(1+rate)`). A proof passing against
-- one and a customer being billed by the other is the shape of defect this
-- repository has recorded more than once.
--
-- What it does, in four parts:
--
--   1. the columns a MYOB invoice line carries — a discount, a unit label and a
--      tax code — on `invoice_lines` and on `job_charge_snapshots`, so a charge
--      frozen at approval can hold the same facts the invoice line will;
--   2. `items.selling_unit` / `items_per_selling_unit` / `sell_price_basis`,
--      which is where "this price already includes GST" is recorded per item;
--   3. `invoices.freight_amount` / `freight_tax_code`, so delivery is a field on
--      the invoice rather than a line somebody has to remember to add;
--   4. `sync_tax_code_taxable()`, which derives the existing `taxable` boolean
--      from the new `tax_code` so the two can never disagree — `GST` is taxable,
--      `FRE` and `N-T` are not — and leaves `taxable` alone when no code is set.
--
-- Every column is nullable or `not null default`, so nothing that inserted a row
-- before this names them now and nothing already stored changes value. The
-- trigger function is revoked from `authenticated` as well as `public, anon` —
-- the trap 0019 recorded and 0036 shipped — and the migration asserts that
-- itself, along with a worked example: $72.70 GST-inclusive holds $6.61 of tax.
-- ============================================================================

alter table public.items
  add column if not exists selling_unit text,
  add column if not exists items_per_selling_unit numeric(12,2),
  add column if not exists sell_price_basis text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_items_sell_price_basis') then
    alter table public.items add constraint chk_items_sell_price_basis
      check (sell_price_basis is null or sell_price_basis in ('inclusive','exclusive'));
  end if;
end $$;

alter table public.invoice_lines
  add column if not exists discount_percent numeric(5,2) not null default 0,
  add column if not exists unit_label text,
  add column if not exists tax_code text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_invoice_lines_discount') then
    alter table public.invoice_lines add constraint chk_invoice_lines_discount
      check (discount_percent >= 0 and discount_percent <= 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_invoice_lines_tax_code') then
    alter table public.invoice_lines add constraint chk_invoice_lines_tax_code
      check (tax_code is null or tax_code in ('GST','FRE','N-T'));
  end if;
end $$;

alter table public.job_charge_snapshots
  add column if not exists discount_percent numeric(5,2) not null default 0,
  add column if not exists unit_label text,
  add column if not exists tax_code text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_job_charges_discount') then
    alter table public.job_charge_snapshots add constraint chk_job_charges_discount
      check (discount_percent >= 0 and discount_percent <= 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_job_charges_tax_code') then
    alter table public.job_charge_snapshots add constraint chk_job_charges_tax_code
      check (tax_code is null or tax_code in ('GST','FRE','N-T'));
  end if;
end $$;

alter table public.invoices
  add column if not exists freight_amount numeric(12,2) not null default 0,
  add column if not exists freight_tax_code text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_invoices_freight') then
    alter table public.invoices add constraint chk_invoices_freight check (freight_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_invoices_freight_tax_code') then
    alter table public.invoices add constraint chk_invoices_freight_tax_code
      check (freight_tax_code is null or freight_tax_code in ('GST','FRE','N-T'));
  end if;
end $$;

create or replace function public.sync_tax_code_taxable()
returns trigger language plpgsql set search_path = public as $fn$
begin
  if new.tax_code is not null then
    new.taxable := (new.tax_code = 'GST');
  end if;
  return new;
end $fn$;

revoke all on function public.sync_tax_code_taxable() from public, anon, authenticated;

drop trigger if exists sync_invoice_line_tax_code on public.invoice_lines;
create trigger sync_invoice_line_tax_code
  before insert or update of tax_code on public.invoice_lines
  for each row execute procedure public.sync_tax_code_taxable();

drop trigger if exists sync_job_charge_tax_code on public.job_charge_snapshots;
create trigger sync_job_charge_tax_code
  before insert or update of tax_code on public.job_charge_snapshots
  for each row execute procedure public.sync_tax_code_taxable();

create or replace function public.recalculate_invoice(p_invoice uuid)
returns void language plpgsql security invoker set search_path = public as $fn$
declare
  v_rate numeric(5,4);
  v_freight numeric(12,2);
  v_freight_taxed boolean;
begin
  select coalesce(t.gst_rate, 0.10), coalesce(i.freight_amount, 0),
         coalesce(i.freight_tax_code, 'GST') = 'GST'
    into v_rate, v_freight, v_freight_taxed
    from public.invoices i join public.tenants t on t.id = i.tenant_id
   where i.id = p_invoice;

  update public.invoices i set
    subtotal = coalesce(l.sub, 0) + v_freight,
    tax_amount = case when v_rate > 0
      then round((coalesce(l.taxable_sub, 0) + case when v_freight_taxed then v_freight else 0 end)
                 * (v_rate / (1 + v_rate)), 2)
      else 0 end,
    total = coalesce(l.sub, 0) + v_freight,
    amount_paid = coalesce(p.paid, 0)
  from (
    select sum(amount) as sub, sum(case when taxable then amount else 0 end) as taxable_sub
      from public.invoice_lines where invoice_id = p_invoice
  ) l
  left join (select sum(amount) as paid from public.payments where invoice_id = p_invoice) p on true
  where i.id = p_invoice;
end $fn$;

revoke all on function public.recalculate_invoice(uuid) from public, anon;

do $$
declare n int; v_tax numeric;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='invoice_lines'
     and column_name in ('discount_percent','unit_label','tax_code');
  if n <> 3 then raise exception '0043: invoice_lines is missing a column (% of 3)', n; end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='invoices'
     and column_name in ('freight_amount','freight_tax_code');
  if n <> 2 then raise exception '0043: invoices is missing a freight column (% of 2)', n; end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='items'
     and column_name in ('selling_unit','items_per_selling_unit','sell_price_basis');
  if n <> 3 then raise exception '0043: items is missing a register column (% of 3)', n; end if;

  select count(*) into n from pg_trigger
   where tgname in ('sync_invoice_line_tax_code','sync_job_charge_tax_code') and not tgisinternal;
  if n <> 2 then raise exception '0043: the tax-code triggers are not both attached (%)', n; end if;

  if has_function_privilege('authenticated', 'public.sync_tax_code_taxable()', 'execute') then
    raise exception '0043: authenticated can execute the tax-code trigger function';
  end if;

  select round((72.70) * (0.10 / 1.10), 2) into v_tax;
  if v_tax <> 6.61 then raise exception '0043: 72.70 inclusive should hold 6.61 of GST, got %', v_tax; end if;
end $$;

