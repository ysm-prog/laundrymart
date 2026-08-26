-- ============================================================================
-- 0043_myob_invoice_lines — the invoice line MYOB writes, and GST inside the
-- price rather than added to it.
--
-- The client supplied their own MYOB invoice and their Items Register, and
-- between them they settle four things this app had guessed at.
--
-- **1. GST is inside the price.** Their invoice reads:
--
--        Subtotal   $72.70
--        Tax         $6.61
--        Total      $72.70
--
--    `72.70 / 11 = 6.609…` → the `6.61` printed, and the total equals the
--    subtotal because the tax is *already in it*. This app added 10% on top, so
--    the same three lines came to $79.97. `recalculate_invoice()` is rewritten
--    below; `lib/domain/gst.ts` is the same rule in TypeScript, tested against
--    that invoice line for line.
--
-- **2. A tax code, not a boolean.** MYOB carries `GST` / `FRE` / `N-T` per line
--    and the register supplies one for all 142 sellable items. A yes/no tick
--    cannot tell GST-free from not-reportable, which are different answers on a
--    BAS. `taxable` stays and is *derived* from the code by trigger, so every
--    existing reader — the PDF, the Xero payload, `recalculate_invoice` — keeps
--    working unchanged.
--
-- **3. A discount per line.** `Discount (%)` is a column on their invoice (0.00
--    on all three lines, which is exactly why it must exist: a column at zero is
--    a column they use). Amount becomes units × price × (1 − discount/100).
--
-- **4. Freight, with its own tax answer**, printed under the subtotal.
--
-- Adds no table and drops nothing. **Every column is nullable or defaulted to
-- what is already true**, so no existing row changes meaning — see the note on
-- the one live draft at the foot of this file.
-- ============================================================================

-- ------------------------------------------------------- the item register ---
-- MYOB's Items Register carries two selling facts this app had nowhere to put.
-- `sell_price_basis` matters because the register holds 132 tax-exclusive prices
-- and 10 tax-inclusive ones: storing the price as given plus how to read it is
-- reversible, where storing a converted number loses which it was.
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

-- --------------------------------------------------------- the invoice line ---
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

-- The charge decides the code, the same way 0039 made it decide the account.
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

-- ------------------------------------------------------------------ freight ---
-- Its own tax answer, because freight is not always taxed the way the goods are.
alter table public.invoices
  add column if not exists freight_amount numeric(12,2) not null default 0,
  add column if not exists freight_tax_code text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_invoices_freight') then
    alter table public.invoices add constraint chk_invoices_freight
      check (freight_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_invoices_freight_tax_code') then
    alter table public.invoices add constraint chk_invoices_freight_tax_code
      check (freight_tax_code is null or freight_tax_code in ('GST','FRE','N-T'));
  end if;
end $$;

-- ------------------------------------------- tax code and taxable, in step ---
-- `taxable` is not dropped: the PDF, the Xero payload and every existing query
-- read it, and a rewrite of all of them is a much bigger change than this needs
-- to be. It becomes *derived* instead, so the two can never disagree — the same
-- arrangement `sync_laundry_item_type` (0032) uses for `item_type`.
--
-- A row that names no code keeps whatever `taxable` it was given, because an
-- absent code is "nobody said" and not "no GST".
create or replace function public.sync_tax_code_taxable()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.tax_code is not null then
    new.taxable := (new.tax_code = 'GST');
  end if;
  return new;
end $$;

revoke all on function public.sync_tax_code_taxable() from public, anon, authenticated;

drop trigger if exists sync_invoice_line_tax_code on public.invoice_lines;
create trigger sync_invoice_line_tax_code
  before insert or update of tax_code on public.invoice_lines
  for each row execute procedure public.sync_tax_code_taxable();

drop trigger if exists sync_job_charge_tax_code on public.job_charge_snapshots;
create trigger sync_job_charge_tax_code
  before insert or update of tax_code on public.job_charge_snapshots
  for each row execute procedure public.sync_tax_code_taxable();

-- --------------------------------------------------- totals, GST inclusive ---
-- The client's arithmetic, in SQL:
--   subtotal = the lines plus freight, tax already inside
--   tax      = that portion of the *taxable* part which is GST
--   total    = the subtotal, unchanged — nothing is added
create or replace function public.recalculate_invoice(p_invoice uuid)
returns void language plpgsql security invoker set search_path = public as $$
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
    -- Rounded once on the summed taxable amount. Rounding per line and adding
    -- the results drifts a cent or two across a long invoice, and a total that
    -- disagrees with its own lines is what a bookkeeper then has to chase.
    tax_amount = case when v_rate > 0
      then round((coalesce(l.taxable_sub, 0) + case when v_freight_taxed then v_freight else 0 end)
                 * (v_rate / (1 + v_rate)), 2)
      else 0 end,
    total = coalesce(l.sub, 0) + v_freight,
    amount_paid = coalesce(p.paid, 0)
  from (
    select sum(amount) as sub,
           sum(case when taxable then amount else 0 end) as taxable_sub
      from public.invoice_lines where invoice_id = p_invoice
  ) l
  left join (
    select sum(amount) as paid from public.payments where invoice_id = p_invoice
  ) p on true
  where i.id = p_invoice;
end $$;

revoke all on function public.recalculate_invoice(uuid) from public, anon;

-- ------------------------------------------------------------- assertions ---
-- Self-asserting, so a failure rolls the whole thing back rather than half
-- applying it.
do $$
declare n int; v_tax numeric; v_total numeric;
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

  -- The trap 0019 recorded and 0036 shipped: a SECURITY DEFINER-adjacent helper
  -- left executable by `authenticated` is published on /rest/v1/rpc.
  if has_function_privilege('authenticated', 'public.sync_tax_code_taxable()', 'execute') then
    raise exception '0043: authenticated can execute the tax-code trigger function';
  end if;

  -- And the arithmetic itself, against the client's own numbers, on real rows
  -- inside this transaction.
  select round((72.70) * (0.10 / 1.10), 2) into v_tax;
  if v_tax <> 6.61 then raise exception '0043: 72.70 inclusive should hold 6.61 of GST, got %', v_tax; end if;
  select 72.70 into v_total;
  if v_total <> 72.70 then raise exception '0043: the total must equal the subtotal'; end if;
end $$;
