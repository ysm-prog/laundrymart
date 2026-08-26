-- ============================================================================
-- 0039_job_charge_codes — code the charge where the charge is decided.
--
-- MYOB puts the **Item ID** and the **Category** (its name for the account code)
-- on an invoice line at the moment the line is written. This app splits that
-- decision in two: a job's Charges screen is where the price is agreed and
-- frozen, and the invoice line composer (0036) is where a line can still be added
-- by hand. Only the second half could carry a code, so a charge typed on the job
-- reached the invoice **uncoded and had to be coded again**.
--
-- That is not a convenience. `invoice_lines.gl_account_id` is resolved at
-- generation from `source_item_id → items.income_account_id`, so a charge with no
-- item can never be coded at the job stage at all — and a hand-added charge never
-- has one. Measured on the live project before this was written: `Adelaide Towel
-- Service` holds **1** frozen job charge and **0** of them carry an item, because
-- that laundry has no rate card and no price list, so every charge it will ever
-- raise is hand-added. The feature was, for the one real business using it,
-- entirely inert.
--
-- **One column, and deliberately not two.** `invoice_lines` carries both the link
-- and an `account_code` snapshot, because an invoice is a record of what a
-- customer was told and must survive the chart being tidied. A job charge is
-- internal provenance — "why was it this much" — and the invoice raised from it
-- is where the record lives. So the charge carries the *decision* and the invoice
-- line keeps the *record*: delete an account and the charge's link nulls while the
-- invoice still says `4-1100`.
--
-- **No backfill, and that is load-bearing rather than lazy.** `job_charge_snapshots`
-- carries `frozen_at`, and `guard_job_charge_snapshot` refuses every UPDATE and
-- DELETE on a frozen row — including to `super_admin`. An UPDATE here would be
-- refused by that guard and take the migration with it. The one live frozen row
-- keeps a null account, which is the truth: nobody coded it.
--
-- Adds no table, drops nothing and changes no row.
-- ============================================================================

alter table public.job_charge_snapshots
  add column if not exists gl_account_id uuid references public.gl_accounts(id) on delete set null;

comment on column public.job_charge_snapshots.gl_account_id is
  'The income account this charge codes to, chosen on the job''s Charges screen '
  'or inherited from the item the pricer used. Carried onto the invoice line at '
  'generation, so the code is decided once — where the work is — rather than '
  're-entered on the invoice.';

create index if not exists idx_job_charge_snapshots_account
  on public.job_charge_snapshots(tenant_id, gl_account_id)
  where gl_account_id is not null;

-- --------------------------------------------------------------- the guard ---
-- The same three refusals `sync_invoice_line_account` makes, in the same words,
-- because they are the same rule about the same table and a charge that could be
-- coded to a heading would put a heading on the invoice raised from it.
--
-- Validates only — it writes no snapshot column, because the invoice line is
-- where the code has to survive the chart changing and it already keeps one.
create or replace function public.guard_job_charge_account()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
  -- Only when the account actually changes, so re-costing or freezing a charge
  -- never re-judges a coding decision already made.
  if tg_op = 'UPDATE' and new.gl_account_id is not distinct from old.gl_account_id then
    return new;
  end if;
  if new.gl_account_id is null then
    return new;
  end if;

  select id, tenant_id, is_header into a
    from public.gl_accounts where id = new.gl_account_id;

  if a.id is null then
    raise exception 'that account could not be found';
  end if;
  if a.tenant_id <> new.tenant_id then
    raise exception 'that account belongs to another business';
  end if;
  if a.is_header then
    raise exception 'that is a heading, not an account you can code to';
  end if;

  return new;
end $$;

-- **`authenticated` too.** Supabase's default privileges hand every new function a
-- direct EXECUTE grant, which `revoke ... from public, anon` leaves standing — so
-- a SECURITY DEFINER trigger function would sit on `/rest/v1/rpc/…` for any
-- signed-in user. 0019 set this pattern and 0036 shipped without it; the assertion
-- below is what stops a third time.
revoke execute on function public.guard_job_charge_account() from public, anon, authenticated;

drop trigger if exists guard_job_charge_account on public.job_charge_snapshots;
create trigger guard_job_charge_account
  before insert or update of gl_account_id on public.job_charge_snapshots
  for each row execute procedure public.guard_job_charge_account();

-- ------------------------------------------------------------- the writer ----
-- Rebuilt from the body live today, which was verified to match 0017's byte for
-- byte before this was written — the trap the 2026-08-20 entry records, where
-- rebuilding a guard from the migration that introduced it silently dropped a
-- feature a later migration had added underneath. One column is added to the
-- insert; everything else is 0017's, unchanged.
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
    source_laundry_item_type, pricing_model, gl_account_id, created_by
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
    nullif(entry ->> 'gl_account_id', '')::uuid,
    (select auth.uid())
  from jsonb_array_elements(p_lines) with ordinality as t(entry, ordinality);

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- 0012's lesson: `create or replace` drops the pinned `search_path` and leaves the
-- grants to be restated. Both are above and here rather than assumed to survive.
alter function public.save_job_charge_snapshot(uuid, jsonb) set search_path = public;
revoke all on function public.save_job_charge_snapshot(uuid, jsonb) from public, anon;
grant execute on function public.save_job_charge_snapshot(uuid, jsonb) to authenticated, service_role;

-- ====================================================== assert the outcome ==
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='job_charge_snapshots'
                   and column_name='gl_account_id') then
    raise exception '0039: job_charge_snapshots.gl_account_id is missing';
  end if;

  if not exists (select 1 from pg_trigger
                 where tgrelid='public.job_charge_snapshots'::regclass
                   and tgname='guard_job_charge_account') then
    raise exception '0039: the account guard is not attached';
  end if;

  -- The writer really carries the column. Checked against the function body
  -- rather than assumed, because the failure this prevents is silent: the
  -- editor posts a code, the insert ignores it, and every charge stays uncoded
  -- exactly as before with nothing raising.
  if pg_get_functiondef('public.save_job_charge_snapshot(uuid, jsonb)'::regprocedure)
     not like '%gl_account_id%' then
    raise exception '0039: save_job_charge_snapshot does not carry gl_account_id';
  end if;

  -- SECURITY INVOKER, so RLS and 0025's restrictive layer still decide whose
  -- charges may be replaced. A definer rewrite here would hand every member the
  -- ability to re-price any job.
  if (select prosecdef from pg_proc
       where oid='public.save_job_charge_snapshot(uuid, jsonb)'::regprocedure) then
    raise exception '0039: save_job_charge_snapshot became SECURITY DEFINER';
  end if;

  -- Neither function is on the RPC surface for a caller that should not have it.
  if has_function_privilege('anon', 'public.save_job_charge_snapshot(uuid, jsonb)', 'execute') then
    raise exception '0039: anon can execute save_job_charge_snapshot';
  end if;
  if has_function_privilege('authenticated', 'public.guard_job_charge_account()', 'execute')
     or has_function_privilege('anon', 'public.guard_job_charge_account()', 'execute') then
    raise exception '0039: the trigger function is published at /rest/v1/rpc — the trap 0019 recorded';
  end if;
end $$;
