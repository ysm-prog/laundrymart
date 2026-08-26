-- ============================================================================
-- 0040_open_draft_invoices — one running draft per customer per period.
--
-- The owner's flow: a job is reviewed, the charges are set, the job is approved,
-- and **that charge lands on the customer's draft invoice for the month**. The
-- next job the same customer sends in joins the same draft. At the end of the
-- month — or on the 9th, or twice in a month — the owner issues it.
--
-- The app could not do that, and the reason is one line of `from-jobs.ts`:
-- `generateInvoicesForJobs` always **inserts** an invoice. `groupJobsForInvoicing`
-- groups the jobs *in the call it was given*, so a `monthly_consolidated` customer
-- got one invoice per **button press**, not one per month. Approve on the 3rd and
-- press Generate; approve on the 11th and press Generate; the customer receives
-- two invoices for one August. Nothing was billed twice — `uq_invoice_source_jobs_once`
-- sees to that — the month was simply split across two documents.
--
-- Three things are needed for the running draft to be a fact rather than a
-- convention, and this migration is all three. Everything else is application
-- code over rows that already exist.
--
--   1. **A key to find the draft by.** The invoice already carries
--      `period_start`/`period_end`; what it lacked was a rule that there is at
--      most one open one. A partial unique index, so two reviewers approving at
--      the same instant cannot open two drafts — a reader that merely looks
--      first is a race, not a rule.
--
--   2. **A way to say where a line came from.** Appending a job re-consolidates:
--      towels from the new job are added to the towel line rather than written
--      underneath it. That means deleting the invoice's job-derived lines and
--      re-deriving them from every job the invoice bills — which is only safe if
--      a line a person typed by hand can be told apart from one the generator
--      wrote. Nothing on `invoice_lines` said so.
--
--   3. **A boundary around a document that has left the building.** The rebuild
--      writes lines programmatically, so "an invoice that is not a draft has
--      fixed lines" has to be true in the database rather than in the two actions
--      that happen to check today. It is not true now: `addInvoiceLine` and
--      `removeInvoiceLine` check the caller's capability and never the invoice's
--      status, and `invoice_lines` is published on `/rest/v1/invoice_lines`, so a
--      line can be added to an issued, sent, paid or **voided** invoice from a
--      browser's network tab.
--
-- Adds no table, drops nothing, and changes no row's meaning: the backfill in
-- part 2 states what each existing line already was.
-- ============================================================================

-- ============================================== 1. one open draft, per period ==
-- Partial, and every term in the WHERE clause is load-bearing:
--
--   status = 'draft'          an issued invoice is closed — the next approval for
--                             that period opens a *new* draft, which is right,
--                             because the first document has gone to the customer.
--   invoice_type              a per-job invoice must never collide with the
--                             customer's running draft, and a legacy `recurring`
--                             invoice must not either.
--   period_* not null         a per-job invoice carries no period and is excluded
--                             by its own nullity rather than by a special case.
--   deleted_at / archived_at  an archived invoice is invisible to every session
--                             (0017_archive_records), so counting one here would
--                             block a draft the app cannot see, look up, or fix.
create unique index if not exists uq_invoices_open_draft
  on public.invoices (tenant_id, customer_id, period_start, period_end)
  where status = 'draft'
    and invoice_type = 'consolidated'
    and period_start is not null
    and period_end is not null
    and deleted_at is null
    and archived_at is null;

comment on index public.uq_invoices_open_draft is
  'At most one open draft per customer per billing period. The running invoice a '
  'job''s approved charges are placed on; issuing it closes it and the next '
  'approval opens another.';

-- ==================================================== 2. where a line came from ==
-- Three origins, because three different things write lines and only one of them
-- may be rebuilt:
--
--   job       written by the generator from frozen `job_charge_snapshots`.
--             Deleted and re-derived every time a job joins or leaves the draft.
--   contract  written by the recurring run from a service agreement's own
--             calendar, minimum and levies. Rebuilt only by that run.
--   manual    typed on the invoice screen. **Never touched by anything.**
--
-- Default `manual` on purpose: an unmarked line is one nothing may delete, which
-- is the safe direction for a column that gates a delete.
alter table public.invoice_lines
  add column if not exists origin text not null default 'manual';

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.invoice_lines'::regclass
                   and conname = 'invoice_lines_origin_check') then
    alter table public.invoice_lines add constraint invoice_lines_origin_check
      check (origin in ('job','contract','manual'));
  end if;
end $$;

comment on column public.invoice_lines.origin is
  'Who wrote this line: job (re-derivable from frozen job charges), contract '
  '(the recurring run), or manual (typed by a person, never rewritten).';

-- The backfill states what each existing line already is, and does not guess.
-- A line pointing at a job is a job line; a line pointing at an agreement and no
-- job is a contract line; anything else was typed.
--
-- **One imprecision, stated rather than glossed:** a *rolled-up* consolidated
-- line written before this migration carries neither pointer — it belongs to
-- several jobs, so `laundry_order_id` is null by design — and therefore reads as
-- `manual`. That is the harmless direction (a rebuild leaves it alone rather than
-- deleting somebody's typed line), and it is unreachable in practice: an invoice
-- written by the pre-0040 job generator carries no period at all, so it can never
-- be found as an open draft and never rebuilt. It stays as it is, on an invoice
-- that has already been issued.
update public.invoice_lines
   set origin = case
                  when laundry_order_id is not null then 'job'
                  when agreement_id is not null then 'contract'
                  else 'manual'
                end
 where origin = 'manual';

create index if not exists idx_invoice_lines_origin
  on public.invoice_lines(invoice_id, origin);

-- ============================================ 3. a closed invoice is closed ==
-- A trigger rather than a restrictive policy, for the reason 0036's sequence
-- guard gives: RLS is *row*-level and this rule is about the parent's state, and
-- a restrictive policy writes **zero rows in silence** to a caller it excludes —
-- the failure this project has shipped twice (0031 for boards, §26 for the
-- counter). A trigger raising 42501 reaches the flash toast as a sentence.
--
-- 42501 and not P0001, so it reads as what it is — a refusal of permission to
-- change a document that has been issued — and so the existing proofs that assert
-- 42501 on this table keep their meaning.
create or replace function public.guard_invoice_line_draft_only()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_id uuid;
begin
  v_id := coalesce(new.invoice_id, old.invoice_id);
  select status into v_status from public.invoices where id = v_id;

  -- The parent is gone. This is the ON DELETE CASCADE path — Postgres deletes the
  -- invoice row first and the lines after it — and refusing here would make an
  -- invoice undeletable. Nothing in the app deletes an invoice except the
  -- generator unwinding its own failed insert, on a draft it has just made.
  if v_status is null then
    return coalesce(new, old);
  end if;

  if v_status <> 'draft' then
    raise exception 'the lines on invoice % cannot be changed — it is no longer a draft', v_id
      using errcode = '42501';
  end if;

  -- An UPDATE that moves a line onto another invoice has two parents to check.
  if tg_op = 'UPDATE' and new.invoice_id is distinct from old.invoice_id then
    select status into v_status from public.invoices where id = old.invoice_id;
    if v_status is not null and v_status <> 'draft' then
      raise exception 'a line cannot be moved off invoice % — it is no longer a draft',
        old.invoice_id using errcode = '42501';
    end if;
  end if;

  return coalesce(new, old);
end $$;

-- SECURITY DEFINER, so it can read `invoices` whatever the caller's policies say
-- — and therefore it must be taken off the RPC surface. `authenticated` is named
-- explicitly: Postgres grants EXECUTE to PUBLIC at creation and a hosted Supabase
-- project *additionally* hands each new function a direct grant to `anon` and
-- `authenticated`, which `revoke ... from public` does not touch. 0019 set this
-- pattern, 0036 shipped without it and the live advisors caught it within the
-- hour; the assertion at the foot of this file is what stops a third time.
revoke execute on function public.guard_invoice_line_draft_only() from public, anon, authenticated;

drop trigger if exists guard_invoice_lines_draft_only on public.invoice_lines;
create trigger guard_invoice_lines_draft_only
  before insert or update or delete on public.invoice_lines
  for each row execute procedure public.guard_invoice_line_draft_only();

-- ====================================================== assert the outcome ==
-- `apply_migration` is atomic, so a failed assertion rolls the whole thing back.
do $$
declare
  v_tenant uuid;
  v_customer uuid;
  v_draft uuid;
  v_issued uuid;
  v_blocked boolean := false;
begin
  if not exists (select 1 from pg_class where relname = 'uq_invoices_open_draft') then
    raise exception '0040: uq_invoices_open_draft is missing';
  end if;

  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='invoice_lines'
                   and column_name='origin') then
    raise exception '0040: invoice_lines.origin is missing';
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid='public.invoice_lines'::regclass
                   and conname='invoice_lines_origin_check') then
    raise exception '0040: the origin check constraint is missing';
  end if;

  if not exists (select 1 from pg_trigger
                 where tgrelid='public.invoice_lines'::regclass
                   and tgname='guard_invoice_lines_draft_only') then
    raise exception '0040: the draft-only guard is not attached';
  end if;

  -- The trap 0019 recorded and 0036 repeated: a SECURITY DEFINER trigger function
  -- published at /rest/v1/rpc for every signed-in user, where it can only error.
  if has_function_privilege('authenticated', 'public.guard_invoice_line_draft_only()', 'execute')
     or has_function_privilege('anon', 'public.guard_invoice_line_draft_only()', 'execute') then
    raise exception '0040: the trigger function is published at /rest/v1/rpc';
  end if;

  -- Every backfilled row says something the constraint accepts. Asserted rather
  -- than assumed, because the UPDATE above is the only statement here that
  -- touches existing data.
  if exists (select 1 from public.invoice_lines
              where origin not in ('job','contract','manual')) then
    raise exception '0040: a backfilled line carries an origin the constraint refuses';
  end if;

  -- ---------------------------------------------------- behavioural proof ---
  -- Both new rules, against real rows, inside the migration's own transaction.
  -- The index is the one that would otherwise be trusted on its WHERE clause
  -- alone, and the guard is the one whose failure mode is a silent success.
  select id into v_tenant from public.tenants limit 1;
  if v_tenant is not null then
    select id into v_customer from public.customers where tenant_id = v_tenant limit 1;
  end if;

  if v_customer is not null then
    insert into public.invoices (tenant_id, customer_id, invoice_number, invoice_type,
                                 status, period_start, period_end)
    values (v_tenant, v_customer, '0040-probe-a', 'consolidated', 'draft',
            date '1900-01-01', date '1900-01-31')
    returning id into v_draft;

    begin
      insert into public.invoices (tenant_id, customer_id, invoice_number, invoice_type,
                                   status, period_start, period_end)
      values (v_tenant, v_customer, '0040-probe-b', 'consolidated', 'draft',
              date '1900-01-01', date '1900-01-31');
    exception when unique_violation then
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception '0040: a second open draft was accepted for the same customer and period';
    end if;

    -- A line goes on while it is a draft …
    insert into public.invoice_lines (tenant_id, invoice_id, description, quantity,
                                      unit_price, amount, origin)
    values (v_tenant, v_draft, '0040 probe', 1, 1.00, 1.00, 'job');

    -- … and does not once it is not.
    update public.invoices set status = 'issued' where id = v_draft;
    v_blocked := false;
    begin
      insert into public.invoice_lines (tenant_id, invoice_id, description, quantity,
                                        unit_price, amount)
      values (v_tenant, v_draft, '0040 probe 2', 1, 1.00, 1.00);
    exception when insufficient_privilege then
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception '0040: a line was added to an invoice that is no longer a draft';
    end if;

    -- The same invoice, issued, still deletes cleanly — the cascade path the
    -- guard has to let through or an invoice becomes undeletable.
    delete from public.invoices where id = v_draft;

    select id into v_issued from public.invoices where invoice_number = '0040-probe-a';
    if v_issued is not null then
      raise exception '0040: the probe invoice could not be deleted';
    end if;
  end if;
end $$;
