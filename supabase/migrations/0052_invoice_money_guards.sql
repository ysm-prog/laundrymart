-- ============================================================================
-- 0052_invoice_money_guards — a credit note counts, a paid invoice stays paid
--
-- From the 12 October end-to-end test on ats.coreit.com.au (INV00006, CN00001,
-- CN00002). Three money defects, each of which the app let through and the
-- database did nothing to stop:
--
--  1. **A fully paid invoice could be voided.** INV00006 carried $74.80 of
--     payments and two credit notes; Void went through, the payments stayed
--     attached to a void invoice, and the job stayed `paid`. A void is the
--     statement "this was never owed" — it cannot be true of an invoice
--     somebody has paid against or been credited on. `guard_invoice_void`
--     refuses it out loud. The remedy is to reverse the payments (new in the
--     app) and void the credit notes first.
--
--  2. **Credit notes had no cumulative cap.** $11 and then $70 were both
--     accepted on a $74.80 invoice, because the action checked each note
--     against the invoice total alone. **The rule chosen: the issued credit
--     notes on an invoice may never total more than what is still owed on it —
--     total less payments.** Not merely the invoice total: a credit beyond the
--     outstanding balance is a refund, this app has no way to pay one, and the
--     balance it leaves is negative with nothing that can ever settle it. A
--     paid invoice that genuinely needs crediting has its payment reversed
--     first, or the refund is made outside the app.
--
--  3. **A credit note did not reduce the balance.** `balance` was
--     `total - amount_paid`, so paid $30 + credited $11 on $74.80 still read
--     $44.80. `invoices.amount_credited` now carries the issued credit, kept by
--     a trigger on `credit_notes`, and `balance` is re-derived as
--     `total - amount_paid - amount_credited`. A trigger rather than the action
--     because it must be true of the 646 header-only MYOB imports too, whose
--     `amount_paid` is not `sum(payments)` and which `recalculate_invoice` must
--     never be run over.
--
-- Plus the billing guard gains **one** edge, `paid → invoice_sent`, so a
-- reversed payment can take its jobs back off `paid`. Only while the job is
-- still on an invoice that is no longer paid; `paid` stays terminal otherwise.
-- Rebuilt from **0017's** body, the only migration that defines it (checked).
--
-- Adds one column, re-derives one generated column, two trigger functions and
-- their triggers. Drops nothing else. **Changes stored values only where a
-- credit note already exists**: the backfill sets `amount_credited` from them.
-- On the live project that is INV00006 alone, which is already void.
--
-- **And the Owner can save their own settings.** `tenants` has carried a SELECT
-- policy (0001) and a platform-admin policy (0019) and nothing else, so every
-- `update tenants set settings = …` from an Owner who is not a platform admin —
-- Settings › Notifications, since 2026-08-05 — matched zero rows with no error
-- and reported "saved". `save_tenant_settings` and `save_tenant_abn` are the door:
-- SECURITY DEFINER, `super_admin` (or platform admin) checked inside, and the
-- settings write merges **one whitelisted key** server-side, so a save cannot
-- reset a preference it does not show and cannot touch name, status or GST rate.
-- An UPDATE policy was the alternative and would have handed the Owner the
-- whole row — suspending their own laundry included.
--
-- RLS: nothing new. `invoices` keeps 0017/0025/0028's policies. Both new
-- functions are SECURITY DEFINER — the void check must see payments and credit
-- notes the caller's RLS might hide, and the credit sync writes the invoice row
-- whatever the caller's write policy — so both are revoked from `public, anon`
-- **and `authenticated`** (the trap 0019 recorded and 0036 shipped).
-- ============================================================================

-- ------------------------------------------------- the credited figure -----
alter table public.invoices
  add column if not exists amount_credited numeric(12,2) not null default 0;

comment on column public.invoices.amount_credited is
  'Sum of issued/applied credit notes against this invoice. Maintained by '
  'sync_invoice_credits; never written by the application.';

-- `balance` is generated, and Postgres 16 cannot change a generated expression
-- in place, so it is dropped and re-added. Nothing in the schema depends on it
-- (no index, view, policy or function names it — checked), and every reader in
-- `src/` selects it by name, which a re-added column satisfies.
alter table public.invoices drop column if exists balance;
alter table public.invoices
  add column balance numeric(12,2)
  generated always as (total - amount_paid - amount_credited) stored;

update public.invoices i
   set amount_credited = c.credited
  from (select invoice_id, sum(total) as credited
          from public.credit_notes
         where status in ('issued','applied') and invoice_id is not null
         group by invoice_id) c
 where c.invoice_id = i.id
   and i.amount_credited is distinct from c.credited;

-- ----------------------------------------- credit notes count, and are capped
create or replace function public.sync_invoice_credits()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_invoice uuid;
  v_credited numeric(12,2);
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_status text;
  v_number text;
  v_grew boolean;
begin
  -- An invoice that lost a note (moved, or the note deleted) is re-summed too.
  if tg_op in ('UPDATE','DELETE') and old.invoice_id is not null
     and (tg_op = 'DELETE' or old.invoice_id is distinct from new.invoice_id) then
    update public.invoices i
       set amount_credited = coalesce((select sum(total) from public.credit_notes
                                        where invoice_id = old.invoice_id
                                          and status in ('issued','applied')), 0)
     where i.id = old.invoice_id;
  end if;

  if tg_op = 'DELETE' or new.invoice_id is null then return null; end if;
  v_invoice := new.invoice_id;

  select coalesce(sum(total), 0) into v_credited
    from public.credit_notes
   where invoice_id = v_invoice and status in ('issued','applied');

  select total, amount_paid, status, invoice_number
    into v_total, v_paid, v_status, v_number
    from public.invoices where id = v_invoice and tenant_id = new.tenant_id;
  if not found then
    raise exception 'that credit note names an invoice from another business'
      using errcode = 'P0001';
  end if;

  -- Only a note whose contribution *grew* is judged, so voiding or deleting a
  -- note is always possible even on an invoice an older bug left over-credited.
  v_grew := new.status in ('issued','applied')
    and (tg_op = 'INSERT'
         or old.status not in ('issued','applied')
         or new.total > old.total
         or old.invoice_id is distinct from new.invoice_id);

  if v_grew then
    if v_status in ('draft','void') then
      raise exception 'invoice % is %, so it cannot be credited', v_number, v_status
        using errcode = 'P0001';
    end if;
    if v_credited > v_total - v_paid + 0.005 then
      raise exception 'credit notes on % would total $%, more than the $% still owed on it ($% less $% paid). Reverse a payment first, or credit less.',
        v_number, to_char(v_credited, 'FM999999990.00'),
        to_char(greatest(v_total - v_paid, 0), 'FM999999990.00'),
        to_char(v_total, 'FM999999990.00'), to_char(v_paid, 'FM999999990.00')
        using errcode = 'P0001';
    end if;
  end if;

  update public.invoices set amount_credited = v_credited
   where id = v_invoice and amount_credited is distinct from v_credited;
  return null;
end $$;

drop trigger if exists sync_invoice_credits on public.credit_notes;
create trigger sync_invoice_credits
  after insert or update or delete on public.credit_notes
  for each row execute procedure public.sync_invoice_credits();

revoke all on function public.sync_invoice_credits() from public, anon, authenticated;

-- --------------------------------------------- a paid invoice is not voided
create or replace function public.guard_invoice_void()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'void' and old.status is distinct from 'void' then
    if exists (select 1 from public.payments where invoice_id = new.id)
       or old.amount_paid > 0.005 then
      raise exception 'invoice % has payments recorded against it, so it cannot be voided. Reverse the payments first.',
        old.invoice_number using errcode = 'P0001';
    end if;
    if exists (select 1 from public.credit_notes
                where invoice_id = new.id and status in ('issued','applied')) then
      raise exception 'invoice % has credit notes issued against it, so it cannot be voided. Void the credit notes first.',
        old.invoice_number using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_invoice_void on public.invoices;
create trigger guard_invoice_void
  before update of status on public.invoices
  for each row execute procedure public.guard_invoice_void();

revoke all on function public.guard_invoice_void() from public, anon, authenticated;

-- ------------------------------ the billing lifecycle, plus one way back ----
create or replace function public.guard_laundry_order_billing()
returns trigger language plpgsql set search_path = public as $$
declare allowed text[];
begin
  if new.billing_status is not distinct from old.billing_status then return new; end if;

  allowed := case old.billing_status
    when 'pending'           then array['awaiting_review','not_billable']
    when 'awaiting_review'   then array['approved','not_billable']
    when 'approved'          then array['invoice_generated','awaiting_review','not_billable']
    when 'invoice_generated' then array['invoice_sent','paid','approved']
    when 'invoice_sent'      then array['paid','approved']
    -- 0052: a reversed payment. `paid` is otherwise terminal.
    when 'paid'              then array['invoice_sent']
    else array[]::text[]
  end;

  if not (new.billing_status = any(allowed)) then
    raise exception 'a job cannot go from billing state % to %', old.billing_status, new.billing_status
      using errcode = 'P0001';
  end if;

  -- 0052: back off `paid` only while the job is still on an invoice and that
  -- invoice is no longer settled — which is what reversing a payment produces.
  if old.billing_status = 'paid' and new.billing_status = 'invoice_sent'
     and not exists (select 1 from public.invoice_source_jobs s
                       join public.invoices i on i.id = s.invoice_id
                      where s.order_id = new.id and i.status <> 'paid') then
    raise exception 'this job''s invoice is still paid, so the job stays paid'
      using errcode = 'P0001';
  end if;

  if new.billing_status = 'approved'
     and old.billing_status in ('invoice_generated','invoice_sent')
     and exists (select 1 from public.invoice_source_jobs where order_id = new.id) then
    raise exception 'this job is still on an invoice — void that invoice first'
      using errcode = 'P0001';
  end if;

  if new.billing_status = 'approved' and new.status <> 'completed' then
    raise exception 'only a completed job can be approved for billing'
      using errcode = 'P0001';
  end if;

  if new.billing_status = 'approved'
     and not exists (select 1 from public.job_charge_snapshots where order_id = new.id) then
    raise exception 'this job has no charges to approve' using errcode = 'P0001';
  end if;

  if new.billing_status = 'approved' then
    new.billing_approved_at = coalesce(new.billing_approved_at, now());
  end if;

  if new.billing_status = 'not_billable'
     and new.status <> 'cancelled'
     and coalesce(btrim(new.billing_exclusion_reason), '') = '' then
    raise exception 'say why this job is not billable' using errcode = 'P0001';
  end if;

  return new;
end $$;

revoke all on function public.guard_laundry_order_billing() from public, anon, authenticated;

-- ----------------------------------------------- the Owner's own settings -----
create or replace function public.save_tenant_settings(t uuid, p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(t, array['super_admin']) then
    raise exception 'only the owner can change these settings' using errcode = '42501';
  end if;
  if p_key not in ('notifications', 'invoiceProfile') then
    raise exception 'that is not a setting this screen may change' using errcode = '22023';
  end if;
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'settings must be an object' using errcode = '22023';
  end if;
  update public.tenants
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
   where id = t;
end $$;

create or replace function public.save_tenant_abn(t uuid, p_abn text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(t, array['super_admin']) then
    raise exception 'only the owner can change the business''s ABN' using errcode = '42501';
  end if;
  if p_abn is not null and p_abn !~ '^[0-9]{11}$' then
    raise exception 'an ABN is 11 digits' using errcode = '22023';
  end if;
  update public.tenants set abn = p_abn where id = t;
end $$;

revoke all on function public.save_tenant_settings(uuid, text, jsonb) from public, anon;
revoke all on function public.save_tenant_abn(uuid, text) from public, anon;
grant execute on function public.save_tenant_settings(uuid, text, jsonb) to authenticated;
grant execute on function public.save_tenant_abn(uuid, text) to authenticated;

-- ------------------------------------------------------- self-assertions ----
do $$
declare v_expr text; n int;
begin
  select pg_get_expr(d.adbin, d.adrelid) into v_expr
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.invoices'::regclass and a.attname = 'balance';
  if v_expr is null or v_expr not ilike '%amount_credited%' then
    raise exception '0052: invoices.balance does not subtract amount_credited (%)', v_expr;
  end if;

  select count(*) into n from pg_trigger
   where tgname in ('sync_invoice_credits','guard_invoice_void') and not tgisinternal;
  if n <> 2 then raise exception '0052: % of 2 triggers attached', n; end if;

  select count(*) into n from pg_proc
   where proname in ('sync_invoice_credits','guard_invoice_void') and prosecdef;
  if n <> 2 then raise exception '0052: a guard is not SECURITY DEFINER'; end if;

  if has_function_privilege('authenticated', 'public.sync_invoice_credits()', 'execute')
     or has_function_privilege('authenticated', 'public.guard_invoice_void()', 'execute')
     or has_function_privilege('anon', 'public.guard_invoice_void()', 'execute') then
    raise exception '0052: a SECURITY DEFINER trigger function is on the RPC surface';
  end if;

  if (select prosrc from pg_proc where proname = 'guard_laundry_order_billing')
       not like '%this job is still on an invoice%' then
    raise exception '0052: the billing guard lost 0017''s release rule';
  end if;

  select count(*) into n from public.invoices i
   where i.amount_credited <> coalesce((select sum(total) from public.credit_notes c
                                         where c.invoice_id = i.id
                                           and c.status in ('issued','applied')), 0);
  if n <> 0 then raise exception '0052: % invoices disagree with their credit notes', n; end if;

  if has_function_privilege('anon', 'public.save_tenant_settings(uuid, text, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.save_tenant_abn(uuid, text)', 'execute') then
    raise exception '0052: anon can call a settings writer';
  end if;
  if not has_function_privilege('authenticated', 'public.save_tenant_settings(uuid, text, jsonb)', 'execute') then
    raise exception '0052: the owner cannot call save_tenant_settings';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.invoices'::regclass) then
    raise exception '0052: RLS is off on invoices';
  end if;
end $$;
