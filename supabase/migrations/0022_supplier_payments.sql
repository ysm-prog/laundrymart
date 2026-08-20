-- ============================================================================
-- 0015_supplier_payments — money actually leaving, and the end of a double count.
--
-- 0014 brought in what suppliers had billed. This brings in what was paid: the
-- remittance advices, which are the only record of a payment leaving the
-- business. They are not modelled as allocations against particular bills,
-- because the remittance export does not say which bills a payment settled —
-- only the supplier, the date, the reference and the amount. Inventing an
-- allocation would be a bookkeeping claim the source never made.
-- ============================================================================

create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  -- The payment's own reference, as it appears on the remittance. Unique per
  -- tenant: it is how the business identifies the payment to the supplier, and
  -- a repeated one would mean two payments the bank cannot tell apart.
  reference text not null,
  paid_on date not null default current_date,
  amount numeric(12,2) not null,
  -- Where the remittance advice was sent. Kept on the payment rather than read
  -- from the supplier, because it is a fact about what happened, and the
  -- supplier's address may since have changed.
  remittance_email text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  deleted_at timestamptz
);
create unique index uq_supplier_payments_reference
  on public.supplier_payments(tenant_id, reference);
create index idx_supplier_payments_supplier
  on public.supplier_payments(supplier_id, paid_on desc);
create index idx_supplier_payments_paid_on on public.supplier_payments(tenant_id, paid_on desc);

select public.apply_tenant_policy('supplier_payments');

-- ------------------------------------------------- the opening-balance trap ---
-- `opening_balance` on customers and suppliers was what each party owed, or was
-- owed, on the day the books were carried across. That was the right shape
-- while it was the *only* record of the money. It is not any more: the invoices
-- and the supplier bills now carry the same amounts as documents, so a query
-- that added an opening balance to a document balance would count the debt
-- twice — and the column name invites exactly that addition.
--
-- So the openings are cleared wherever document-level detail exists for that
-- party, and the comments below say what the column is for now: the balance a
-- party arrived with that no document accounts for. In a tenant where every
-- outstanding document has been imported, that is zero, which is the honest
-- answer rather than a figure sitting there waiting to be summed.
update public.customers c set opening_balance = 0, opening_balance_overdue = 0
 where exists (select 1 from public.invoices i
                where i.customer_id = c.id and i.deleted_at is null
                  and i.total - i.amount_paid <> 0);

update public.suppliers s set opening_balance = 0
 where exists (select 1 from public.supplier_bills b
                where b.supplier_id = s.id and b.deleted_at is null
                  and b.balance_due <> 0);

comment on column public.customers.opening_balance is
  'Balance carried in from a previous system that no imported invoice accounts for. Never add this to invoice balances — that double-counts.';
comment on column public.customers.opening_balance_overdue is
  'The past-terms part of opening_balance, on the same terms.';
comment on column public.suppliers.opening_balance is
  'Balance carried in from a previous system that no imported bill accounts for. Never add this to bill balances — that double-counts.';

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
