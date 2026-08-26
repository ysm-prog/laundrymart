-- ============================================================================
-- 0044_charge_type_accounts — a kind of charge knows where its money lands, and
-- a code may still be corrected while the invoice is a draft.
--
-- Two halves of one complaint, reported from the deployed app on 2026-08-26
-- against `LJ00007`: an invoice line reading `LJ00007 — fuel` with a code of
-- `—`, under a notice whose only advice was *"Remove and re-add a line to give
-- it a code."*
--
-- **Half one: nothing could ever code that line.** A job charge takes its
-- account from the item it names (0036) or from a hand-picked account on the
-- charge itself (0039), and the account picker was taken off the Charges card on
-- 2026-08-26 at the owner's instruction — MYOB's model, where you choose the
-- Item and the Category follows it. A fuel levy names no item, so it had no
-- first tier and no second, and there was nowhere in the application to give it
-- one. `charge_type_accounts` is the third tier: twelve rows at most, one per
-- kind of charge, so a levy lands somewhere without anybody picking anything.
--
-- `lib/invoices/account-coding.ts` argued against exactly this map — *"a second
-- place a laundry has to keep in step with its own books … the first wrong entry
-- would silently mis-post every invoice after it"* — and the owner overruled it.
-- The objection is answered rather than waved away, and this table is where the
-- answer lives: it is a **real table with a real foreign key**, gated on
-- `can_write_purchases()`, its account validated by trigger against the same
-- three rules `sync_invoice_line_account()` applies (exists, this laundry's, not
-- a heading), and `on delete set null` so a tidied chart degrades to *uncoded*
-- rather than to an insert that raises and takes a month's invoicing with it.
-- The failure that comment feared was a dangling id in a settings blob. There is
-- no blob.
--
-- **Half two: a frozen charge's coding could not be corrected.** 0017 froze a
-- charge whole at approval, which is right for the money and wrong for the code.
-- §20 already states the distinction in as many words — *"a code is a
-- classification, not money … What is frozen is the amount"* — and the running
-- draft (0040) is what makes it bite: `rebuildJobLines` deletes and re-derives
-- every `origin = 'job'` line each time a job joins the draft, so an account
-- written onto the *line* is discarded the moment the next job is approved. The
-- durable place for a job line's code is therefore the charge it came from, and
-- until now that was refused.
--
-- So `guard_job_charge_snapshot` is narrowed: an update touching **nothing but
-- `gl_account_id`** is allowed on a frozen charge, and refused the moment any
-- invoice carrying that job stops being a draft. Everything that decides what
-- the customer pays — quantity, unit price, amount, taxable, description, the
-- provenance columns and `frozen_at` itself — stays exactly as immutable as it
-- was, including to `super_admin`.
--
-- Adds one table and one trigger; drops nothing, and changes no existing row.
-- ============================================================================

-- =========================================== 1. the map, as a real table ====
-- **Deliberately not `apply_tenant_policy`.** That helper attaches a single
-- permissive `for all … using is_member(tenant_id)` policy, which would let any
-- member of the laundry rewrite where its revenue posts — the shape this repo
-- has now had to replace four times (0006→0017, 0018→0033, 0021→0036,
-- 0002→0040). It is not repeated a fifth time here.
create table if not exists public.charge_type_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- The same twelve values `job_charge_snapshots.charge_type` and
  -- `invoice_lines.charge_type` are constrained to, restated rather than
  -- referenced: there is no lookup table for them, and a thirteenth kind of
  -- charge should fail here as loudly as it does there.
  charge_type text not null check (charge_type in (
    'rental','wash_only','replacement','minimum_service_fee','fuel_levy',
    'emergency_delivery','weekend_surcharge','holiday_surcharge','bag_charge',
    'weight_charge','monthly_fee','other'
  )),

  -- Nullable, and that is a real answer rather than an unfinished row: "this
  -- kind of charge has no default" is what every charge type says until somebody
  -- decides otherwise, and it is what a deleted account leaves behind.
  gl_account_id uuid references public.gl_accounts(id) on delete set null,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,

  -- One answer per kind of charge, enforced rather than conventional: two rows
  -- would make "which account does a fuel levy use?" depend on the query plan.
  constraint uq_charge_type_accounts unique (tenant_id, charge_type)
);

comment on table public.charge_type_accounts is
  'The default income account for each kind of charge. The third and last tier '
  'of the coding ladder, behind the charge''s own account and its item''s — it '
  'answers for the lines that name no item at all, which is where every uncoded '
  'line came from.';
comment on column public.charge_type_accounts.gl_account_id is
  'Null is legal and means "no default". A chart tidied later clears this rather '
  'than leaving a dangling id, so invoicing degrades to uncoded, never to an error.';

create index if not exists idx_charge_type_accounts_account
  on public.charge_type_accounts(tenant_id, gl_account_id)
  where gl_account_id is not null;

alter table public.charge_type_accounts enable row level security;

drop trigger if exists set_updated_at on public.charge_type_accounts;
create trigger set_updated_at
  before update on public.charge_type_accounts
  for each row execute procedure public.set_updated_at();

-- ------------------------------------------------------------ the policies --
-- Four, one verb each, so no USING half is a second door onto SELECT — 0033's
-- trap, and the reason 0036 split the payable tables the same way.
--
-- Gated on `purchases`, not on `invoices`, because what this table holds is a
-- **chart of accounts** decision: every value in it is an account id, and 0036
-- put the chart itself behind `can_read_purchases()`. Reading this map through a
-- weaker gate would be a side channel onto the chart it points into.
--
-- Every role that can approve a job — `invoices.approve`, which is the Owner and
-- the Office manager alone — holds `purchases.read`, so the invoice writers can
-- resolve the map as the caller. `roles.test.ts` pins that, because the day the
-- two sets part company is the day invoices quietly stop being coded.
drop policy if exists charge_type_accounts_read on public.charge_type_accounts;
create policy charge_type_accounts_read on public.charge_type_accounts
  for select to authenticated
  using ((select public.can_read_purchases(tenant_id)));

drop policy if exists charge_type_accounts_insert on public.charge_type_accounts;
create policy charge_type_accounts_insert on public.charge_type_accounts
  for insert to authenticated
  with check ((select public.can_write_purchases(tenant_id)));

drop policy if exists charge_type_accounts_update on public.charge_type_accounts;
create policy charge_type_accounts_update on public.charge_type_accounts
  for update to authenticated
  using ((select public.can_write_purchases(tenant_id)))
  with check ((select public.can_write_purchases(tenant_id)));

drop policy if exists charge_type_accounts_delete on public.charge_type_accounts;
create policy charge_type_accounts_delete on public.charge_type_accounts
  for delete to authenticated
  using ((select public.can_write_purchases(tenant_id)));

-- ------------------------------------------------------------- the guard ----
-- The same three refusals `sync_invoice_line_account()` (0036) and
-- `guard_job_charge_account()` (0039) make, stated a third time because this is
-- a third writer of an account id and a rule enforced in two of three places is
-- a rule that has a hole in it.
--
-- **SECURITY DEFINER, and the tenant compare inside is what pays for it** —
-- 0036's reasoning, unchanged: `gl_accounts` sits behind `purchases.read`, and
-- an invoker-rights lookup would make that overlap load-bearing, so a legitimate
-- account would one day be refused as "could not be found".
create or replace function public.guard_charge_type_account()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
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

-- `authenticated` named as well as `public, anon` — the trap 0019 recorded and
-- 0036 shipped. Supabase's default privileges hand every new function a *direct*
-- EXECUTE grant to `authenticated`, which a `from public, anon` revoke leaves
-- standing, publishing a SECURITY DEFINER trigger function at `/rest/v1/rpc/…`
-- where it can only ever error.
revoke execute on function public.guard_charge_type_account() from public, anon, authenticated;

drop trigger if exists guard_charge_type_account on public.charge_type_accounts;
create trigger guard_charge_type_account
  before insert or update of gl_account_id on public.charge_type_accounts
  for each row execute procedure public.guard_charge_type_account();

-- =============================== 2. a frozen charge may still be re-coded ===
-- **Rebuilt from the body live today, which is 0017's** — 0039 added a *second*
-- trigger (`guard_job_charge_account`) and left this function untouched, so
-- 0017 is the latest ancestor and there is nothing later to preserve. That was
-- checked rather than assumed: it is the trap the 2026-08-20 entry records,
-- where rebuilding a guard from the migration that introduced it silently
-- dropped what a later one had added underneath.
--
-- Three changes, and nothing else moves:
--
--   a. `v_account_only` — is this update touching nothing but `gl_account_id`?
--      Asked of the whole row as jsonb rather than column by column, so a column
--      added to this table later is covered without anybody remembering to.
--      `updated_at` is excluded because it is bookkeeping about the row, not a
--      fact about the charge.
--   b. the frozen and invoiced refusals now stand aside for such an update;
--   c. a new refusal takes their place — the moment any invoice carrying this
--      job is no longer a draft, the invoice line is the record and neither it
--      (`guard_invoice_line_draft_only`, 0040) nor this may change.
--
-- **Now SECURITY DEFINER**, which strengthens rather than relaxes it: the
-- billing-status read was an invoker-rights select, so a caller RLS hid the job
-- from would have read null and sailed past the invoiced check. Both lookups are
-- of the row being written and neither returns anything to the caller.
create or replace function public.guard_job_charge_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_billing text;
  v_account_only boolean := false;
begin
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
  if tg_op = 'DELETE' and old.frozen_at is not null then
    raise exception 'this job''s charges were approved and can no longer be removed'
      using errcode = 'P0001';
  end if;

  -- Belt and braces on the parent's state: a job past review has no business
  -- gaining new charges either, and an INSERT has no `old` row to consult.
  select billing_status into v_billing
    from public.laundry_orders
   where id = coalesce(new.order_id, old.order_id);
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

-- 0012's lesson, restated: `create or replace` drops a pinned `search_path`, and
-- the definer switch above makes the revoke matter for the first time.
alter function public.guard_job_charge_snapshot() set search_path = public;
revoke execute on function public.guard_job_charge_snapshot() from public, anon, authenticated;

-- ====================================================== assert the outcome ==
-- Self-asserting, so a partial apply fails rather than half-landing.
do $$
declare
  v int;
  v_missing text[] := '{}';
begin
  -- 1. The table is there, with RLS on and no permissive `for all` policy.
  select count(*) into v from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'charge_type_accounts' and c.relrowsecurity;
  if v <> 1 then v_missing := v_missing || 'charge_type_accounts missing or RLS off'; end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'charge_type_accounts' and cmd = 'ALL';
  if v <> 0 then v_missing := v_missing || 'a permissive for-all policy survives'; end if;

  -- 2. Four policies, one verb each, on the purchases gate.
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'charge_type_accounts'
     -- `coalesce` on **both** halves: an INSERT policy has no USING clause and a
     -- DELETE policy has no WITH CHECK, so `qual || with_check` is NULL for two of
     -- the four and the count silently came back 3. Caught by this assertion.
     and coalesce(qual, '') || coalesce(with_check, '') like '%can_%_purchases%';
  if v <> 4 then
    v_missing := v_missing || format('expected 4 purchases-gated policies, found %s', v);
  end if;

  -- 3. One answer per charge type.
  select count(*) into v from pg_constraint
   where conname = 'uq_charge_type_accounts' and contype = 'u';
  if v <> 1 then v_missing := v_missing || 'the one-row-per-charge-type index is missing'; end if;

  -- 4. A tidied chart clears the default rather than blocking the delete.
  select count(*) into v from pg_constraint
   where conrelid = 'public.charge_type_accounts'::regclass
     and contype = 'f' and confrelid = 'public.gl_accounts'::regclass
     and confdeltype = 'n';
  if v <> 1 then v_missing := v_missing || 'the account FK is not on delete set null'; end if;

  -- 5. Both guards are attached, and neither is on the RPC surface.
  select count(*) into v from pg_trigger
   where tgrelid = 'public.charge_type_accounts'::regclass
     and tgname = 'guard_charge_type_account' and not tgisinternal;
  if v <> 1 then v_missing := v_missing || 'guard_charge_type_account is not attached'; end if;

  if has_function_privilege('authenticated', 'public.guard_charge_type_account()', 'execute')
     or has_function_privilege('anon', 'public.guard_charge_type_account()', 'execute') then
    v_missing := v_missing || 'guard_charge_type_account is on the RPC surface';
  end if;
  if has_function_privilege('authenticated', 'public.guard_job_charge_snapshot()', 'execute')
     or has_function_privilege('anon', 'public.guard_job_charge_snapshot()', 'execute') then
    v_missing := v_missing || 'guard_job_charge_snapshot is on the RPC surface';
  end if;

  -- 6. The rebuilt guard is still a row-level BEFORE trigger on all three verbs,
  --    and is now definer. 0042's own first draft had these bits backwards.
  select count(*) into v from pg_trigger
   where tgrelid = 'public.job_charge_snapshots'::regclass
     and tgname = 'guard_job_charge_snapshots_change'
     and tgtype & 1 = 1      -- row-level
     and tgtype & 2 = 2      -- before
     and tgtype & 4 = 4      -- insert
     and tgtype & 8 = 8      -- delete
     and tgtype & 16 = 16;   -- update
  if v <> 1 then v_missing := v_missing || 'the charge guard is no longer a row-level BEFORE trigger on insert/update/delete'; end if;

  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guard_job_charge_snapshot' and p.prosecdef;
  if v <> 1 then v_missing := v_missing || 'guard_job_charge_snapshot is not SECURITY DEFINER'; end if;

  -- 7. The immutability that did NOT move, asserted by reading the body rather
  --    than trusted: the money refusals are still in there.
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guard_job_charge_snapshot'
     and p.prosrc like '%can no longer be removed%'
     and p.prosrc like '%can no longer be changed%';
  if v <> 1 then v_missing := v_missing || 'the frozen-charge refusals were lost in the rebuild'; end if;

  if array_length(v_missing, 1) is not null then
    raise exception '0044 did not apply cleanly: %', array_to_string(v_missing, '; ');
  end if;
end $$;
