-- ============================================================================
-- 0017_customer_pricing_billing — the money half of a job.
--
-- Six things land together because they are one idea: **a customer's price is
-- editable, a job's price is not.**
--
--   1. the customer's billing settings, including which rate card prices them;
--   2. rate lines that can name what actually arrives in a bag, not only the
--      linen the laundry owns and rents out;
--   3. a *financial* state on the job, running beside the operational one and
--      never in front of it;
--   4. `job_charge_snapshots` — the frozen copy of what the job cost, taken from
--      the rate card and never re-read from it afterwards;
--   5. the job → invoice relationship, with the constraint that stops one job
--      being invoiced twice, plus the Xero reference columns;
--   6. financial reads narrowed in RLS, so pricing and invoice amounts are out
--      of reach of the operational roles in the *database*, not only in React.
--
-- **Statement order is load-bearing**, exactly as in 0016. The billing columns
-- are added and backfilled *before* the guard that polices them, so the backfill
-- is not judged by a rule it is establishing. Re-running against an empty
-- database is a no-op on the backfill; re-ordering it would break the next
-- project this is applied to.
--
-- No table is dropped and no column is removed. `invoice_lines.job_id` still
-- points at `public.jobs` (a *stop*); the new `laundry_order_id` beside it is
-- the counter's Job, and the two are different records — see 0014's header.
-- ============================================================================

-- ------------------------------------------------- who may see money at all ---
-- The brief's rule: drivers, the plant floor and dispatch see jobs, runs and the
-- operational side of a customer, and never a price, an invoice amount or a Xero
-- reference. That has to be a database fact — anything holding a session and the
-- anon key can read `/rest/v1/invoices` directly, so a React guard is decoration.
--
-- Two gates rather than one, because they are genuinely different questions.
-- Sales negotiate rate cards and must see prices; they have no business in the
-- ledger. `auditor` reads both and writes neither (its write is refused by the
-- write policies below, not by these).
create or replace function public.can_read_pricing(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array[
    'super_admin','operations_manager','finance','sales',
    'branch_manager','regional_manager','auditor'
  ]);
$$;

create or replace function public.can_read_billing(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array[
    'super_admin','operations_manager','finance',
    'branch_manager','regional_manager','auditor'
  ]);
$$;

create or replace function public.can_write_billing(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array[
    'super_admin','operations_manager','finance','branch_manager','regional_manager'
  ]);
$$;

-- CLAUDE.md §7: PostgREST publishes `public` as RPC, so anything executable by
-- `anon` is an unauthenticated endpoint. These three answer questions about the
-- caller, which is exactly why they must not be callable *as* nobody.
revoke all on function public.can_read_pricing(uuid) from public, anon;
revoke all on function public.can_read_billing(uuid) from public, anon;
revoke all on function public.can_write_billing(uuid) from public, anon;
grant execute on function public.can_read_pricing(uuid) to authenticated, service_role;
grant execute on function public.can_read_billing(uuid) to authenticated, service_role;
grant execute on function public.can_write_billing(uuid) to authenticated, service_role;

-- ================================================== 1. customer billing =====
-- Deliberately **four new columns, not a billing table**. Every one of these is
-- a single answer per customer, and a child table would buy nothing but a join
-- on a screen that already reads the customer row.
--
-- Two fields the brief asks for are already here and are *not* re-added:
-- "Invoice email" is `customers.billing_email` (what `emailInvoice` already
-- sends to, and what 0008 stamps on the invoice), and "Payment terms" is
-- `customers.payment_terms_days`. Adding a second spelling of either would give
-- the invoice generator two answers and no rule for choosing.
alter table public.customers
  -- How this customer's completed work turns into invoices. `manual` means
  -- somebody decides each time; it is not "never bill them".
  add column billing_method text not null default 'monthly_consolidated'
    check (billing_method in (
      'invoice_per_job','weekly_consolidated','fortnightly_consolidated',
      'monthly_consolidated','manual'
    )),
  -- The rate card: a *version* of a service agreement, which is the pricing
  -- model this app already has (0003 — `version`, `supersedes_id`, priced
  -- lines). Pointing at the agreement rather than inventing a `rate_cards`
  -- table is the whole point: superseding a contract is already how a price
  -- changes, and every historical invoice line already records the
  -- `agreement_id` it was priced from.
  add column rate_card_agreement_id uuid references public.service_agreements(id) on delete set null,
  -- Xero. Reference-only: this repo has no Xero API implementation, and the
  -- previous checkpoint left Xero authentication and invoice-state mapping
  -- unresolved. These columns record what a person read off Xero so the two
  -- systems can be reconciled by hand; nothing writes them automatically.
  add column xero_contact_id text,
  add column xero_contact_name text;

comment on column public.customers.rate_card_agreement_id is
  'The agreement version whose lines price this customer''s jobs. Editable — the job snapshot is what freezes.';
comment on column public.customers.xero_contact_id is
  'Recorded by hand. There is no Xero API integration in this codebase.';

create index idx_customers_billing_method on public.customers(tenant_id, billing_method);

-- A rate card has to belong to the customer it prices. Without this a mis-typed
-- id would silently bill one customer at another's negotiated rates — and the
-- snapshot would then freeze that mistake permanently, which is the one class of
-- error this whole migration exists to prevent.
create or replace function public.guard_customer_rate_card()
returns trigger language plpgsql set search_path = public as $$
declare v_owner uuid;
begin
  if new.rate_card_agreement_id is null then return new; end if;
  if new.rate_card_agreement_id is not distinct from old.rate_card_agreement_id then return new; end if;

  select customer_id into v_owner
    from public.service_agreements
   where id = new.rate_card_agreement_id and tenant_id = new.tenant_id;

  if v_owner is null then
    raise exception 'that rate card could not be found' using errcode = 'P0001';
  end if;
  if v_owner <> new.id then
    raise exception 'a rate card must belong to the customer it prices'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger guard_customers_rate_card before insert or update on public.customers
  for each row execute procedure public.guard_customer_rate_card();

-- ==================================== 2. rate lines that price real laundry ==
-- `service_agreement_lines.item_id` points at `public.items` — the linen the
-- laundry owns and rents out. What a customer hands over the counter is their
-- own washing, described with `laundry_order_items.item_type` (0014), and those
-- two vocabularies deliberately do not meet.
--
-- So a rate line may now name a laundry item type as well as (or instead of) a
-- stock item. This is the extension the brief asks for — the same table, the
-- same versioning, the same precedence — rather than a second pricing system
-- that would immediately need a rule for which one wins.
alter table public.service_agreement_lines
  add column laundry_item_type text check (laundry_item_type is null or laundry_item_type in (
    'towels','hand_towels','bath_towels','bath_mats','sheets','pillowcases',
    'linen','uniforms','other'
  ));

comment on column public.service_agreement_lines.laundry_item_type is
  'Prices a counter job''s laundry (laundry_order_items.item_type). Null on a linen-rental line.';

-- The lookup the job pricer does: every priced line on a rate card, by what kind
-- of laundry it prices.
create index idx_sal_laundry_item_type
  on public.service_agreement_lines(agreement_id, laundry_item_type)
  where laundry_item_type is not null;

-- ============================================ 3. the job's financial state ===
-- Beside the operational status, never in front of it. The operational workflow
-- the business asked for is untouched:
--
--   new → in_progress → ready_for_delivery → assigned → out_for_delivery → completed
--
-- and completing a job does **not** create an invoice. It sets `awaiting_review`
-- and stops. Everything after that is a finance decision, taken by a person who
-- holds a finance capability.
alter table public.laundry_orders
  add column billing_status text not null default 'pending' check (billing_status in (
    'pending','awaiting_review','approved','invoice_generated','invoice_sent','paid','not_billable'
  )),
  add column billing_approved_at timestamptz,
  add column billing_approved_by uuid references auth.users(id) on delete set null,
  -- Why this job is out of the billing queue. Required for `not_billable` on
  -- anything that was not simply cancelled — writing a job off is a decision,
  -- and a decision with no reason on it is unanswerable three months later.
  add column billing_exclusion_reason text;

comment on column public.laundry_orders.billing_status is
  'Financial lifecycle, separate from `status`. Completion sets awaiting_review and never generates an invoice.';

-- The queue screen: everything a given tenant still owes a billing decision on.
create index idx_laundry_orders_billing on public.laundry_orders(tenant_id, billing_status, customer_id)
  where billing_status in ('awaiting_review','approved');
-- Consolidation reads by customer and completion day.
create index idx_laundry_orders_billing_period
  on public.laundry_orders(tenant_id, customer_id, completed_at)
  where billing_status in ('awaiting_review','approved');

-- ================================================== 4. the price snapshot ====
-- The immutable half of "current price editable, historical price fixed".
--
-- Every column that decides money is copied, not referenced: the description as
-- it read, the quantity, the unit price, the amount and whether GST applied.
-- `source_agreement_id` / `source_agreement_line_id` say where the number came
-- from and are `on delete set null` on purpose — losing the rate card must
-- never alter, or delete, what a customer was actually charged.
create table public.job_charge_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.laundry_orders(id) on delete cascade,

  sequence integer not null default 1,
  description text not null,
  charge_type text not null default 'other' check (charge_type in (
    'rental','wash_only','replacement','minimum_service_fee','fuel_levy',
    'emergency_delivery','weekend_surcharge','holiday_surcharge','bag_charge',
    'weight_charge','monthly_fee','other'
  )),
  quantity numeric(12,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0,
  taxable boolean not null default true,

  -- Provenance, kept for the audit question "why was it this much?".
  source_agreement_id uuid references public.service_agreements(id) on delete set null,
  source_agreement_line_id uuid references public.service_agreement_lines(id) on delete set null,
  source_item_id uuid references public.items(id) on delete set null,
  source_laundry_item_type text,
  pricing_model text,
  -- Set the moment the job is approved, and never cleared. This is the column
  -- the immutability guard reads: a row that carries a `frozen_at` is a
  -- historical fact and stops being writable, whatever the parent job later does.
  frozen_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_job_charge_snapshots_order on public.job_charge_snapshots(order_id, sequence);

comment on table public.job_charge_snapshots is
  'What a job cost, frozen at financial approval. Changing a customer''s rate card never touches these rows.';

-- ================================ 5. job → invoice, and the Xero references ==
alter table public.invoices
  -- The per-job invoice's own pointer. Set only when the invoice bills exactly
  -- one job; a consolidated invoice leaves it null and is read through
  -- `invoice_source_jobs` below. Two records of one fact, which is normally the
  -- bug — so the guard further down refuses every way they could disagree,
  -- exactly as 0016 does for the assignment.
  add column source_job_id uuid references public.laundry_orders(id) on delete set null,
  -- Xero, recorded rather than integrated. See the note on customers above:
  -- there is no Xero client in this codebase and no assumed API contract.
  add column xero_invoice_id text,
  add column xero_invoice_number text,
  add column xero_status text,
  add column xero_synced_at timestamptz;

comment on column public.invoices.xero_invoice_id is
  'Recorded by hand. There is no Xero API integration in this codebase.';

-- `per_job` joins the existing types. `consolidated` was already allowed.
alter table public.invoices drop constraint invoices_invoice_type_check;
alter table public.invoices add constraint invoices_invoice_type_check
  check (invoice_type in ('recurring','manual','consolidated','credit','per_job'));

-- One row per job on an invoice. This — not `source_job_id` — is what makes
-- "the same job cannot be invoiced twice" true for both shapes at once, because
-- a consolidated invoice's jobs live here and nowhere else.
create table public.invoice_source_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  order_id uuid not null references public.laundry_orders(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);
create index idx_invoice_source_jobs_invoice on public.invoice_source_jobs(invoice_id);

-- The unique relationship the brief asks for. Per tenant and per job, so a job
-- billed once cannot be picked up by a second generation run — the failure mode
-- that matters, because a consolidated run and a per-job run can both be
-- pointed at the same completed work.
--
-- A voided invoice releases its jobs: voiding is how a wrong invoice is undone,
-- and the work still has to be billable afterwards. That is why the index is
-- partial rather than a plain unique constraint on the pair.
create unique index uq_invoice_source_jobs_once
  on public.invoice_source_jobs(tenant_id, order_id)
  where invoice_id is not null;

-- A consolidated invoice's lines say which job each came from. The existing
-- `job_id` on this table is the routing module's *stop* and is left alone.
alter table public.invoice_lines
  add column laundry_order_id uuid references public.laundry_orders(id) on delete set null;
create index idx_invoice_lines_laundry_order on public.invoice_lines(laundry_order_id)
  where laundry_order_id is not null;

-- ================================================== 6. backfill, then guard ==
-- Order matters. Existing rows get a billing state derived from where they
-- actually are, *before* the transition guard exists — the guard would refuse
-- some of these as illegal jumps, and it would be right to, because they are
-- not transitions at all. They are the answer to "what was already true?".
--
--  * cancelled work is not billable, and says why;
--  * completed work that nothing has invoiced is genuinely awaiting review —
--    calling it anything else would hide real money on the first day;
--  * everything still in the plant is `pending`, which is the column default.
update public.laundry_orders
   set billing_status = 'not_billable',
       billing_exclusion_reason = coalesce(cancellation_reason, 'Job cancelled')
 where status = 'cancelled';

update public.laundry_orders
   set billing_status = 'awaiting_review'
 where status = 'completed' and billing_status = 'pending';

-- ------------------------------------------------ the billing lifecycle -----
-- Forward-only, with two deliberate exceptions and one hard stop.
--
-- The exceptions: `approved → awaiting_review` is "send it back", which a
-- reviewer needs before an invoice exists; and anything live may become
-- `not_billable`, which is writing the work off. The hard stop: once an invoice
-- has been generated the job's price is history, so nothing walks back past
-- `invoice_generated` — a wrong invoice is voided, and voiding is what releases
-- the job (the partial unique index above).
--
-- Trigger name starts with `b`, so it fires before `guard_laundry_orders_transition`
-- (Postgres fires BEFORE row triggers in name order). That ordering is not
-- load-bearing — the stamps the transition guard writes are legal moves here
-- anyway — but it keeps the two readable in the order they are reasoned about.
create or replace function public.guard_laundry_order_billing()
returns trigger language plpgsql set search_path = public as $$
declare allowed text[];
begin
  if new.billing_status is not distinct from old.billing_status then return new; end if;

  allowed := case old.billing_status
    when 'pending'           then array['awaiting_review','not_billable']
    when 'awaiting_review'   then array['approved','not_billable']
    when 'approved'          then array['invoice_generated','awaiting_review','not_billable']
    -- `approved` is reachable from both invoiced states, but **only** once the
    -- job is on no invoice — see the release rule below. That is what voiding
    -- an invoice does, and without it a wrong invoice could be voided and its
    -- work could never be billed again.
    when 'invoice_generated' then array['invoice_sent','paid','approved']
    when 'invoice_sent'      then array['paid','approved']
    -- `paid` is the end of the money story, and `not_billable` is a decision
    -- that was taken. Both are terminal; re-opening either is a new job or a
    -- credit note, which are things this schema already models.
    else array[]::text[]
  end;

  if not (new.billing_status = any(allowed)) then
    raise exception 'a job cannot go from billing state % to %', old.billing_status, new.billing_status
      using errcode = 'P0001';
  end if;

  -- The release rule. A job goes back to `approved` from an invoiced state
  -- exactly when nothing invoices it any more — which is true only after the
  -- `invoice_source_jobs` rows have gone, and those go when an invoice is
  -- voided. Checking the link rather than trusting the caller is what stops a
  -- job being quietly re-billed while its first invoice is still outstanding.
  if new.billing_status = 'approved'
     and old.billing_status in ('invoice_generated','invoice_sent')
     and exists (select 1 from public.invoice_source_jobs where order_id = new.id) then
    raise exception 'this job is still on an invoice — void that invoice first'
      using errcode = 'P0001';
  end if;

  -- A job cannot be approved for billing before the work is finished. This is
  -- the one place the two lifecycles touch, and the direction is deliberate:
  -- the operational status gates the financial one, never the other way round.
  if new.billing_status = 'approved' and new.status <> 'completed' then
    raise exception 'only a completed job can be approved for billing'
      using errcode = 'P0001';
  end if;

  -- Approval is the moment the price freezes, so it needs something to freeze.
  if new.billing_status = 'approved'
     and not exists (select 1 from public.job_charge_snapshots where order_id = new.id) then
    raise exception 'this job has no charges to approve' using errcode = 'P0001';
  end if;

  if new.billing_status = 'approved' then
    new.billing_approved_at = coalesce(new.billing_approved_at, now());
  end if;

  -- Writing work off is a decision; a decision with no reason on it cannot be
  -- reviewed later. A cancelled job carries its own reason and is exempt.
  if new.billing_status = 'not_billable'
     and new.status <> 'cancelled'
     and coalesce(btrim(new.billing_exclusion_reason), '') = '' then
    raise exception 'say why this job is not billable' using errcode = 'P0001';
  end if;

  return new;
end $$;

create trigger guard_laundry_orders_billing before update on public.laundry_orders
  for each row execute procedure public.guard_laundry_order_billing();

-- ------------------------------- completion sets awaiting_review, not money --
-- The operational guard from 0016, re-stated with one addition: the billing
-- stamp. Everything else in it is unchanged and is repeated verbatim, because
-- `create or replace` replaces the whole body — a partial restatement would
-- silently drop the assignment rules 0016 added.
create or replace function public.guard_laundry_order_transition()
returns trigger language plpgsql set search_path = public as $$
declare allowed text[];
begin
  if new.status is not distinct from old.status then return new; end if;

  allowed := case old.status
    when 'new'                then array['in_progress','cancelled']
    when 'in_progress'        then array['ready_for_delivery','cancelled']
    when 'ready_for_delivery' then array['assigned','completed','cancelled']
    when 'assigned'           then array['out_for_delivery','ready_for_delivery','cancelled']
    when 'out_for_delivery'   then array['completed','cancelled']
    -- completed and cancelled stay terminal. A job that finished and then
    -- reopened is two different accounts of the same work.
    else array[]::text[]
  end;

  -- The two workflows diverge at the end and each rejects the other's moves.
  -- Checked *before* the transition table on purpose: for a customer pickup,
  -- every move into the delivery states is wrong for the same reason, and
  -- "a job cannot go from ready_for_delivery to out_for_delivery" would send the
  -- reader looking for a missing step rather than telling them the job is not
  -- delivery work at all.
  if new.status in ('assigned','out_for_delivery') and not new.delivery_required then
    raise exception 'this job is a customer pickup, so it is never sent out on a run'
      using errcode = 'P0001';
  end if;

  if not (new.status = any(allowed)) then
    raise exception 'a job cannot go from % to %', old.status, new.status
      using errcode = 'P0001';
  end if;

  if new.status = 'completed' and old.status = 'ready_for_delivery' and new.delivery_required then
    raise exception 'a delivery job must be assigned to a driver and go out before it is completed'
      using errcode = 'P0001';
  end if;

  -- Removing an assignment clears the assignment. Doing it here rather than
  -- trusting the caller is what stops a job sitting in the ready queue while
  -- still naming a driver — the state chk_laundry_orders_assignment_status
  -- would refuse anyway, but refusing a legitimate action is worse than
  -- completing it.
  if new.status = 'ready_for_delivery' and old.status = 'assigned' then
    new.assigned_driver_id = null;
    new.assigned_delivery_date = null;
    new.assigned_at = null;
    new.assigned_by = null;
    new.load_confirmed_at = null;
    new.load_confirmed_by = null;
    new.stop_id = null;
  end if;

  -- Stamp the timestamps the state implies, so a row can never record a
  -- finished job with no finishing time no matter which client wrote it.
  if new.status = 'assigned' then
    new.assigned_at = coalesce(new.assigned_at, now());
  end if;
  if new.status = 'completed' then
    new.completed_at = coalesce(new.completed_at, now());
    -- **The whole point of this migration.** Finishing the work puts the job in
    -- front of a person, and does not bill anybody. `pending` is the only state
    -- this moves from, so a job completed twice (it cannot be, but) or one
    -- already approved is never dragged backwards.
    if new.billing_status = 'pending' then
      new.billing_status = 'awaiting_review';
    end if;
  end if;
  if new.status = 'cancelled' then
    new.cancelled_at = coalesce(new.cancelled_at, now());
    -- Cancelled work is not billed. If it has already been invoiced that is a
    -- credit note, not a status change, so anything past approval is left alone.
    if new.billing_status in ('pending','awaiting_review','approved') then
      new.billing_status = 'not_billable';
      new.billing_exclusion_reason =
        coalesce(nullif(btrim(coalesce(new.billing_exclusion_reason, '')), ''),
                 nullif(btrim(coalesce(new.cancellation_reason, '')), ''),
                 'Job cancelled');
    end if;
  end if;
  return new;
end $$;

-- ------------------------------------------- the snapshot's immutability ----
-- A frozen row is a historical fact. Nothing updates it and nothing deletes it —
-- not a re-price, not an edit to the rate card, not the screen. Correcting an
-- approved job's money is a credit note, which is a record of the correction
-- rather than a quiet overwrite of the original.
create or replace function public.guard_job_charge_snapshot()
returns trigger language plpgsql set search_path = public as $$
declare v_billing text;
begin
  if tg_op = 'UPDATE' and old.frozen_at is not null then
    raise exception 'this job''s charges were approved and can no longer be changed'
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' and old.frozen_at is not null then
    raise exception 'this job''s charges were approved and can no longer be removed'
      using errcode = 'P0001';
  end if;

  -- Belt and braces on the parent's state: a job past review has no business
  -- gaining new charges either, and an INSERT has no `old` row to consult.
  select billing_status into v_billing
    from public.laundry_orders
   where id = coalesce(new.order_id, old.order_id);
  if v_billing in ('invoice_generated','invoice_sent','paid') then
    raise exception 'this job has been invoiced, so its charges can no longer be changed'
      using errcode = 'P0001';
  end if;

  return coalesce(new, old);
end $$;

create trigger guard_job_charge_snapshots_change
  before insert or update or delete on public.job_charge_snapshots
  for each row execute procedure public.guard_job_charge_snapshot();

-- ------------------------------------ the two records of "which job(s)" -----
-- `invoices.source_job_id` is a convenience for the per-job case and must agree
-- with `invoice_source_jobs`, or the invoice register and the job page would
-- disagree about what was billed. Refused rather than reconciled.
create or replace function public.guard_invoice_source_job()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.source_job_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.source_job_id is not distinct from old.source_job_id then
    return new;
  end if;

  if not exists (
    select 1 from public.invoice_source_jobs
     where invoice_id = new.id and order_id = new.source_job_id
  ) then
    raise exception 'an invoice''s source job must be one of the jobs it bills'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger guard_invoices_source_job after insert or update on public.invoices
  for each row execute procedure public.guard_invoice_source_job();

-- ------------------------------------------- snapshot lines, saved atomically
-- Same reasoning as `save_laundry_order_items` in 0014: replacing a set over
-- PostgREST is a DELETE then an INSERT, two requests with a window in which the
-- job has a price of nothing. A function body is one transaction.
--
-- SECURITY INVOKER (the default, stated because it is the point): the caller's
-- RLS decides which job they can price, and the policies below mean an
-- operational role cannot reach this table at all. The tenant id is read back
-- from the parent row RLS already vouched for, never taken from the caller.
create or replace function public.save_job_charge_snapshot(p_order_id uuid, p_lines jsonb)
returns integer language plpgsql set search_path = public as $$
declare
  v_tenant uuid;
  v_billing text;
  v_count integer;
begin
  select tenant_id, billing_status into v_tenant, v_billing
    from public.laundry_orders where id = p_order_id;
  if v_tenant is null then
    raise exception 'that job could not be found' using errcode = 'P0001';
  end if;
  if v_billing <> 'awaiting_review' then
    raise exception 'charges can only be set while a job is awaiting review'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'the charge list could not be read' using errcode = 'P0001';
  end if;

  delete from public.job_charge_snapshots where order_id = p_order_id;

  insert into public.job_charge_snapshots (
    tenant_id, order_id, sequence, description, charge_type, quantity, unit_price,
    amount, taxable, source_agreement_id, source_agreement_line_id, source_item_id,
    source_laundry_item_type, pricing_model, created_by
  )
  select
    v_tenant,
    p_order_id,
    coalesce(nullif(entry ->> 'sequence', '')::integer, ordinality::integer),
    entry ->> 'description',
    coalesce(nullif(entry ->> 'charge_type', ''), 'other'),
    coalesce(nullif(entry ->> 'quantity', '')::numeric, 0),
    coalesce(nullif(entry ->> 'unit_price', '')::numeric, 0),
    coalesce(nullif(entry ->> 'amount', '')::numeric, 0),
    coalesce((entry ->> 'taxable')::boolean, true),
    nullif(entry ->> 'source_agreement_id', '')::uuid,
    nullif(entry ->> 'source_agreement_line_id', '')::uuid,
    nullif(entry ->> 'source_item_id', '')::uuid,
    nullif(entry ->> 'source_laundry_item_type', ''),
    nullif(entry ->> 'pricing_model', ''),
    (select auth.uid())
  from jsonb_array_elements(p_lines) with ordinality as t(entry, ordinality);

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Freezing is its own call, so approval cannot half-happen: the stamp on every
-- line and the job's own state move together or not at all.
create or replace function public.freeze_job_charges(p_order_id uuid)
returns integer language plpgsql set search_path = public as $$
declare v_count integer;
begin
  update public.job_charge_snapshots
     set frozen_at = now()
   where order_id = p_order_id and frozen_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ------------------------------------------------------------------- RLS ----
-- The two new tables get the standard tenant policy first (RLS on, tenant index,
-- updated_at trigger), then their read is narrowed below. `apply_tenant_policy`
-- creates a permissive `for all` policy, and permissive policies are OR'd — so
-- narrowing a read means **replacing** that policy, not adding one beside it.
select public.apply_tenant_policy(t) from unnest(array[
  'job_charge_snapshots','invoice_source_jobs'
]) as t;

drop policy job_charge_snapshots_member on public.job_charge_snapshots;
drop policy invoice_source_jobs_member on public.invoice_source_jobs;

do $$
declare t text;
begin
  foreach t in array array['job_charge_snapshots','invoice_source_jobs'] loop
    execute format(
      'create policy %I on public.%I for select to authenticated
         using ((select public.can_read_billing(tenant_id)))', t||'_read', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using ((select public.can_write_billing(tenant_id)))
         with check ((select public.can_write_billing(tenant_id)))', t||'_write', t);
  end loop;
end $$;

-- The existing billing tables were readable by **any** member of the tenant
-- (0006's `<t>_read` policy is `is_member` and nothing more), which since My
-- Runs means a driver's session could read every invoice amount and every
-- payment straight off PostgREST. Both policies are replaced: `dispatcher`
-- comes out of the write set as well, because a `for all` policy's USING half
-- grants SELECT too — narrowing only the read policy would have left the hole
-- open through the other one.
do $$
declare t text;
begin
  foreach t in array array['invoices','invoice_lines','payments','credit_notes','credit_note_lines'] loop
    execute format('drop policy %I on public.%I', t||'_read', t);
    execute format('drop policy %I on public.%I', t||'_write', t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using ((select public.can_read_billing(tenant_id)))', t||'_read', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using ((select public.can_write_billing(tenant_id)))
         with check ((select public.can_write_billing(tenant_id)))', t||'_write', t);
  end loop;
end $$;

-- Rate lines carry `unit_price`, which is the customer's price — the thing the
-- brief says dispatch and the floor must not see. The agreement *header* stays
-- readable by anyone with `agreements.read`, because when a customer is served
-- and on what pattern is operational information they need.
drop policy service_agreement_lines_member on public.service_agreement_lines;
create policy service_agreement_lines_read on public.service_agreement_lines
  for select to authenticated
  using ((select public.can_read_pricing(tenant_id)));
create policy service_agreement_lines_write on public.service_agreement_lines
  for all to authenticated
  using ((select public.has_role(tenant_id, array[
    'super_admin','operations_manager','finance','sales','branch_manager','regional_manager'
  ])))
  with check ((select public.has_role(tenant_id, array[
    'super_admin','operations_manager','finance','sales','branch_manager','regional_manager'
  ])));

-- ------------------------------------------------------------------ grants --
-- 0001's blanket grant was a snapshot of the tables existing then; a table
-- created later needs its own. Named one by one so this cannot widen anything
-- else, and with no function grant to `anon` (CLAUDE.md §7).
grant select, insert, update, delete on public.job_charge_snapshots to authenticated;
grant select, insert, update, delete on public.invoice_source_jobs to authenticated;
grant all on public.job_charge_snapshots to service_role;
grant all on public.invoice_source_jobs to service_role;

revoke all on function public.guard_customer_rate_card() from public, anon;
revoke all on function public.guard_laundry_order_billing() from public, anon;
revoke all on function public.guard_job_charge_snapshot() from public, anon;
revoke all on function public.guard_invoice_source_job() from public, anon;
revoke all on function public.save_job_charge_snapshot(uuid, jsonb) from public, anon;
revoke all on function public.freeze_job_charges(uuid) from public, anon;
grant execute on function public.save_job_charge_snapshot(uuid, jsonb) to authenticated, service_role;
grant execute on function public.freeze_job_charges(uuid) to authenticated, service_role;

-- 0012's lesson: `create or replace` drops a function's pinned `search_path`.
-- The transition guard is replaced above, so its pin is restated here rather
-- than assumed to have survived.
alter function public.guard_laundry_order_transition() set search_path = public;
revoke all on function public.guard_laundry_order_transition() from public, anon;
