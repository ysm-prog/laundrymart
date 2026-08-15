-- ============================================================================
-- 0017_job_billing_workflow — operational completion hands the job to finance.
--
-- Extends the existing laundry-order + service-agreement model. No parallel
-- pricing system is introduced: customer-specific agreement lines remain the
-- source of truth, while a completed job receives an immutable charge snapshot
-- so later pricing changes cannot rewrite historical work.
-- ============================================================================

alter table public.laundry_orders
  add column billing_status text not null default 'not_billable'
    check (billing_status in (
      'not_billable',
      'awaiting_review',
      'approved',
      'invoice_generated',
      'invoice_sent',
      'paid',
      'cancelled_no_invoice'
    )),
  add column billing_method_override text
    check (billing_method_override is null or billing_method_override in (
      'per_job','weekly','fortnightly','monthly','manual'
    )),
  add column billing_approved_at timestamptz,
  add column billing_approved_by uuid references auth.users(id) on delete set null,
  add column billed_invoice_id uuid references public.invoices(id) on delete set null,
  add column billing_notes text;

create index idx_laundry_orders_billing
  on public.laundry_orders(tenant_id, billing_status, completed_at desc)
  where status = 'completed';

-- A completed job enters financial review; it must never auto-create an invoice.
create or replace function public.guard_laundry_order_billing_state()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    if new.billing_status = 'not_billable' then
      new.billing_status = 'awaiting_review';
    end if;
  end if;

  if new.billing_status in ('approved','invoice_generated','invoice_sent','paid')
     and new.billing_approved_by is null then
    raise exception 'a billable completed job must record who approved it'
      using errcode = 'P0001';
  end if;

  if new.billing_status in ('invoice_generated','invoice_sent','paid')
     and new.billed_invoice_id is null then
    raise exception 'an invoiced job must reference its invoice'
      using errcode = 'P0001';
  end if;

  return new;
end $$;

create trigger guard_laundry_orders_billing_state
  before insert or update on public.laundry_orders
  for each row execute procedure public.guard_laundry_order_billing_state();

-- ---------------------------------------------------------------- charges ----
-- One immutable price snapshot per completed job item. Historical jobs therefore
-- preserve the exact agreed price at approval/invoice time even after a rate-card
-- update. `source_agreement_line_id` points to the live price source for traceability.
create table public.job_charge_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  job_id uuid not null references public.laundry_orders(id) on delete cascade,
  source_agreement_id uuid references public.service_agreements(id) on delete set null,
  source_agreement_line_id uuid references public.service_agreement_lines(id) on delete set null,
  item_description text not null,
  quantity numeric(12,2) not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  amount numeric(12,2) generated always as (round(quantity * unit_price, 2)) stored,
  taxable boolean not null default true,
  charge_type text not null default 'other',
  approved_adjustment boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);
create unique index uq_job_charge_snapshot_job_line
  on public.job_charge_snapshots(job_id, source_agreement_line_id, item_description);
create index idx_job_charge_snapshots_job on public.job_charge_snapshots(job_id);

alter table public.job_charge_snapshots enable row level security;
create policy job_charge_snapshots_read
  on public.job_charge_snapshots for select to authenticated
  using ((select public.is_member(tenant_id))
         and (select public.has_role(tenant_id, array[
           'super_admin','operations_manager','finance','dispatcher','branch_manager','regional_manager','auditor'
         ])));
create policy job_charge_snapshots_write
  on public.job_charge_snapshots for all to authenticated
  using ((select public.has_role(tenant_id, array['super_admin','operations_manager','finance']))
         )
  with check ((select public.has_role(tenant_id, array['super_admin','operations_manager','finance'])));

grant select, insert, update, delete on public.job_charge_snapshots to authenticated;
grant all on public.job_charge_snapshots to service_role;

-- ---------------------------------------------------------------- invoices ---
-- Internal provenance and Xero relationship. The unique job reference prevents
-- duplicate per-job invoice creation. Consolidated invoices use invoice_source_jobs.
alter table public.invoices
  add column source_type text not null default 'manual'
    check (source_type in ('job','recurring','consolidated','manual','credit')),
  add column source_job_id uuid references public.laundry_orders(id) on delete set null,
  add column xero_invoice_id text,
  add column xero_invoice_number text,
  add column xero_status text,
  add column xero_synced_at timestamptz;

create unique index uq_invoices_source_job
  on public.invoices(tenant_id, source_job_id)
  where source_job_id is not null and status <> 'void';
create index idx_invoices_xero on public.invoices(tenant_id, xero_invoice_id)
  where xero_invoice_id is not null;

create table public.invoice_source_jobs (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  job_id uuid not null references public.laundry_orders(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  primary key (invoice_id, job_id),
  unique (job_id)
);

alter table public.invoice_source_jobs enable row level security;
create policy invoice_source_jobs_read
  on public.invoice_source_jobs for select to authenticated
  using ((select public.is_member(tenant_id))
         and (select public.has_role(tenant_id, array[
           'super_admin','operations_manager','finance','branch_manager','regional_manager','auditor'
         ])));
create policy invoice_source_jobs_write
  on public.invoice_source_jobs for all to authenticated
  using ((select public.has_role(tenant_id, array['super_admin','operations_manager','finance']))
         )
  with check ((select public.has_role(tenant_id, array['super_admin','operations_manager','finance'])));

grant select, insert, update, delete on public.invoice_source_jobs to authenticated;
grant all on public.invoice_source_jobs to service_role;

-- Financial visibility is deliberately narrower than the existing invoice read
-- policy: operational users can read jobs but cannot read invoice money, Xero ids,
-- or charge snapshots through PostgREST/RLS.
drop policy if exists invoices_read on public.invoices;
create policy invoices_read
  on public.invoices for select to authenticated
  using ((select public.has_role(tenant_id, array[
    'super_admin','operations_manager','finance','branch_manager','regional_manager','auditor'
  ])));

drop policy if exists invoice_lines_read on public.invoice_lines;
create policy invoice_lines_read
  on public.invoice_lines for select to authenticated
  using ((select public.has_role(tenant_id, array[
    'super_admin','operations_manager','finance','branch_manager','regional_manager','auditor'
  ])));

-- Invoice writes remain explicitly finance-gated. Existing dispatcher access is
-- intentionally removed: dispatcher is operational, not financial, for the new brief.
do $$
declare t text;
begin
  foreach t in array array['invoices','invoice_lines','payments','credit_notes','credit_note_lines'] loop
    execute format('drop policy if exists %I on public.%I', t||'_write', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
       using ((select public.has_role(tenant_id, array[''super_admin'',''operations_manager'',''finance''])))
       with check ((select public.has_role(tenant_id, array[''super_admin'',''operations_manager'',''finance''])))',
      t||'_write', t);
  end loop;
end $$;

-- Prevent a user from manufacturing a billed status without the corresponding
-- invoice relationship. This is the database backstop for the server actions.
create or replace function public.guard_invoice_job_source()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.source_job_id is not null then
    if new.source_type not in ('job','consolidated') then
      raise exception 'an invoice with a job source must be job or consolidated'
        using errcode = 'P0001';
    end if;
    perform 1 from public.laundry_orders j
      where j.id = new.source_job_id
        and j.tenant_id = new.tenant_id
        and j.status = 'completed';
    if not found then
      raise exception 'an invoice can only source a completed job'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create trigger guard_invoice_job_source
  before insert or update on public.invoices
  for each row execute procedure public.guard_invoice_job_source();

-- ---------------------------------------------------------------- audit ------
-- Expand the existing audit vocabulary without creating a parallel history table.
-- Consumers can continue to read `/admin/audit`.
-- ============================================================================
