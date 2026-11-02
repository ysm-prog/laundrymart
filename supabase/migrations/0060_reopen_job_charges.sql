-- 0060_reopen_job_charges — Send back for review works.
--
-- Found on 2026-11-02 by a dry run on the live app, with a marked test job.
-- `reopenJobCharges` moves an approved job back to `awaiting_review` and then
-- deletes its frozen charges, so the job can be priced again. The second half has
-- never worked: `guard_job_charge_snapshot` refuses to delete a frozen row whatever
-- the job's state, so the action stopped with "this job's charges were approved
-- and can no longer be removed", **after** the status had already moved. The job
-- sat in review with charges nobody could edit or re-price, because
-- `save_job_charge_snapshot` deletes first and met the same refusal. Only Approve
-- got it out, at the same numbers.
--
-- It stayed hidden because nothing drove the two halves together:
-- `job_billing.test.sql` proves the refusal on a job that is still `approved`,
-- which is right and stays right. Automatic approval (brief 2.3) is what made it
-- matter, since a job can now be approved without anybody having looked at it,
-- and Send back is then the only way to correct it.
--
-- The rule now: **a frozen charge may be deleted while its job is back in
-- `awaiting_review`, and at no other time.** That state is the proof the delete is
-- safe. The billing guard only allows `approved → awaiting_review`, so nothing is
-- on a live invoice, and that is the reasoning `reopenJobCharges` has always given.
-- A frozen row still cannot be **updated** in any state, so the numbers on it can
-- only go by being replaced through review. An approved job, an invoiced job and
-- a paid job refuse the delete exactly as they did.
--
-- Rebuilt from **0044's** body, the latest definition (0050 only mentions it).
-- SECURITY DEFINER and the revoke from `authenticated` are carried across, because
-- `create or replace` keeps neither the intent nor the review of them.
-- Adds no table, column or policy; changes no row.

create or replace function public.guard_job_charge_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_billing text;
  v_account_only boolean := false;
begin
  -- Read first now: the delete below turns on it. Definer rights, so a caller RLS
  -- hid the job from reads the real state rather than null (0044's reasoning).
  select billing_status into v_billing
    from public.laundry_orders
   where id = coalesce(new.order_id, old.order_id);

  if tg_op = 'UPDATE' then
    v_account_only :=
      new.gl_account_id is distinct from old.gl_account_id
      and (to_jsonb(new) - 'gl_account_id' - 'updated_at')
          is not distinct from
          (to_jsonb(old) - 'gl_account_id' - 'updated_at');
  end if;

  if tg_op = 'UPDATE' and old.frozen_at is not null and not v_account_only then
    raise exception 'this job''s charges were approved and can no longer be changed'
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' and old.frozen_at is not null
     and v_billing is distinct from 'awaiting_review' then
    raise exception 'this job''s charges were approved and can no longer be removed'
      using errcode = 'P0001';
  end if;

  -- Belt and braces on the parent's state: a job past review has no business
  -- gaining new charges either, and an INSERT has no `old` row to consult.
  if v_billing in ('invoice_generated','invoice_sent','paid') and not v_account_only then
    raise exception 'this job has been invoiced, so its charges can no longer be changed'
      using errcode = 'P0001';
  end if;

  -- The one refusal a re-coding still meets. `invoice_generated` covers both a
  -- running draft and an invoice already issued but not yet sent, so the job's
  -- own billing status cannot answer this — the invoice's status has to.
  if v_account_only and exists (
    select 1
      from public.invoice_source_jobs isj
      join public.invoices i on i.id = isj.invoice_id
     where isj.order_id = new.order_id
       and i.status <> 'draft'
  ) then
    raise exception 'this job is on an invoice that has already been issued, so its coding can no longer be changed'
      using errcode = 'P0001';
  end if;

  return coalesce(new, old);
end $$;
alter function public.guard_job_charge_snapshot() set search_path = public;
revoke execute on function public.guard_job_charge_snapshot() from public, anon, authenticated;

-- ====================================================== assert the outcome ==
do $$
declare
  v_src text;
  v_definer boolean;
begin
  select p.prosrc, p.prosecdef into v_src, v_definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guard_job_charge_snapshot';

  if v_src not like '%v_billing is distinct from ''awaiting_review''%' then
    raise exception '0060: the delete is not conditional on the job being back in review';
  end if;
  if v_src not like '%can no longer be changed%' then
    raise exception '0060: the frozen update refusal was lost';
  end if;
  if v_src not like '%this job has been invoiced%' then
    raise exception '0060: the invoiced refusal was lost';
  end if;
  if v_src not like '%already been issued%' then
    raise exception '0060: 0044''s coding refusal was lost';
  end if;
  if not v_definer then
    raise exception '0060: the guard must stay SECURITY DEFINER';
  end if;
  if has_function_privilege('authenticated', 'public.guard_job_charge_snapshot()', 'execute') then
    raise exception '0060: authenticated can execute the guard';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = 'public.job_charge_snapshots'::regclass
       and p.proname = 'guard_job_charge_snapshot' and not t.tgisinternal
  ) then
    raise exception '0060: the guard is not attached to job_charge_snapshots';
  end if;
end $$;
