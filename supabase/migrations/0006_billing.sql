-- ============================================================================
-- 0006_billing — invoices, lines, payments, credit notes. Spec §7.15 + §11.
-- Finance-privileged: writes are gated by role on top of tenant isolation.
-- ============================================================================

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  depot_id uuid references public.depots(id) on delete set null,
  invoice_number text not null,
  invoice_type text not null default 'recurring'
    check (invoice_type in ('recurring','manual','consolidated','credit')),
  status text not null default 'draft'
    check (status in ('draft','issued','part_paid','paid','overdue','void')),
  issue_date date not null default current_date,
  due_date date,
  period_start date,
  period_end date,
  purchase_order_number text,
  payment_terms_days integer not null default 14,
  subtotal numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  balance numeric(12,2) generated always as (total - amount_paid) stored,
  currency text not null default 'AUD',
  notes text,
  issued_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  pdf_url text,
  emailed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz,
  constraint invoices_due_after_issue check (due_date is null or due_date >= issue_date)
);
create unique index uq_invoices_number on public.invoices(tenant_id, invoice_number);
create index idx_invoices_customer on public.invoices(customer_id, status);
create index idx_invoices_status on public.invoices(tenant_id, status, due_date);

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  item_id uuid references public.items(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  agreement_id uuid references public.service_agreements(id) on delete set null,
  location_id uuid references public.customer_locations(id) on delete set null,
  description text not null,
  charge_type text not null default 'rental',
  quantity numeric(12,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0,
  taxable boolean not null default true,
  sequence integer not null default 1,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_invoice_lines_invoice on public.invoice_lines(invoice_id, sequence);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  customer_id uuid not null references public.customers(id) on delete restrict,
  paid_on date not null default current_date,
  amount numeric(12,2) not null check (amount > 0),
  method text not null default 'bank_transfer'
    check (method in ('bank_transfer','credit_card','direct_debit','cash','cheque','other')),
  reference text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_payments_invoice on public.payments(invoice_id);
create index idx_payments_customer on public.payments(customer_id, paid_on desc);

-- §10: credit notes must reference the original invoice.
create table public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  credit_note_number text not null,
  status text not null default 'draft' check (status in ('draft','issued','applied','void')),
  issue_date date not null default current_date,
  reason text,
  subtotal numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  pdf_url text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_credit_notes_number on public.credit_notes(tenant_id, credit_note_number);
create index idx_credit_notes_invoice on public.credit_notes(invoice_id);

create table public.credit_note_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  credit_note_id uuid not null references public.credit_notes(id) on delete cascade,
  invoice_line_id uuid references public.invoice_lines(id) on delete set null,
  description text not null,
  quantity numeric(12,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0,
  taxable boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_credit_note_lines_note on public.credit_note_lines(credit_note_id);

-- Keep invoice money columns consistent with their lines and payments.
create or replace function public.recalculate_invoice(p_invoice uuid)
returns void language plpgsql security invoker set search_path = public as $$
declare v_rate numeric(5,4);
begin
  select t.gst_rate into v_rate
    from public.invoices i join public.tenants t on t.id = i.tenant_id
   where i.id = p_invoice;

  update public.invoices i set
    subtotal   = coalesce(l.sub, 0),
    tax_amount = round(coalesce(l.taxable_sub, 0) * coalesce(v_rate, 0.10), 2),
    total      = coalesce(l.sub, 0) + round(coalesce(l.taxable_sub, 0) * coalesce(v_rate, 0.10), 2),
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

-- ------------------------------------------------------------------- RLS ----
-- Tenant isolation for reads; writes additionally require a finance/admin role.
do $$
declare t text;
begin
  foreach t in array array['invoices','invoice_lines','payments','credit_notes','credit_note_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create index if not exists %I on public.%I(tenant_id)', 'idx_'||t||'_tenant', t);
    execute format('create trigger %I before update on public.%I for each row
                    execute procedure public.set_updated_at()', 'set_'||t||'_updated_at', t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using ((select public.is_member(tenant_id)))', t||'_read', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using ((select public.has_role(tenant_id, array[''super_admin'',''operations_manager'',''finance'',''dispatcher''])))
         with check ((select public.has_role(tenant_id, array[''super_admin'',''operations_manager'',''finance'',''dispatcher''])))',
      t||'_write', t);
  end loop;
end $$;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
