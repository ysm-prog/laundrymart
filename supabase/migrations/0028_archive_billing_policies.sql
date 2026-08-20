-- ============================================================================
-- 0028_archive_billing_policies — put the archive clause back on the twelve
-- billing policies that `0017_customer_pricing_billing` replaced.
--
-- ## The bug this fixes, and why it never appeared in production
--
-- Two migrations are numbered 0017, and on the hosted project they went on in
-- this order:
--
--   2026-08-15  0017_customer_pricing_billing   (replaced the billing policies
--                                                with the can_read_billing /
--                                                can_write_billing shape)
--   2026-08-16  0017_archive_records            (wrapped every policy it found
--                                                with `and archived_at is null`)
--
-- `apply_archive_policy()` reads each policy's *existing* expression out of the
-- catalogue and wraps it, so going second is exactly what made it correct
-- there: it wrapped the shape the pricing migration had just written.
--
-- **A fresh database applies them the other way round.** `supabase/migrations`
-- is applied in filename order and `0017_archive_records.sql` sorts before
-- `0017_customer_pricing_billing.sql` (`_` < `c`), so the pricing migration's
-- `drop policy` / `create policy` on the five billing tables — and on
-- `service_agreement_lines` — landed *after* the wrap and silently discarded
-- the clause it had added. Twelve policies, six archivable tables, and the
-- visible consequence is the one that matters: **an archived invoice becomes
-- readable again**.
--
-- Caught by `archive_records.test.sql` — `not ok 10 - the invoice is hidden` —
-- which is the entire reason that proof exists. CI is the only place this could
-- have been caught, because production had the lucky ordering.
--
-- ## Why a new migration rather than renumbering
--
-- Renaming one of the two 0017s would give a fresh database the right order and
-- is what §7 did for the branch migrations that collided at 0012 and 0015. It is
-- rejected here for one reason: **it would fix only fresh databases.** Any
-- deployment that has already applied the pair in filename order is carrying the
-- hole right now, and a rename is invisible to it — the migration is recorded as
-- run and never runs again. A forward-only migration fixes both, which is what
-- forward-only is for.
--
-- Idempotent, and that is not incidental: `apply_archive_policy()` skips any
-- policy already carrying `archived_at is null`, so on the hosted project —
-- where the ordering was lucky and all twelve are already correct — every one of
-- these calls is a no-op. Nothing is dropped, no policy is rewritten, and no row
-- is touched.
-- ============================================================================

-- **Permissive policies only, and named one at a time.** `apply_archive_policy()`
-- wraps *every* policy on the table it is given, which was right in 0017 and is
-- wrong now: 0025 has since added restrictive `…_main_flow_{insert,update,delete}`
-- policies to five of these six tables, and a restrictive policy ANDs with the
-- permissive one rather than replacing it. Wrapping those too would add a clause
-- that changes nothing (the permissive policy already refuses an archived row)
-- while quietly editing 0025's work on a live database. So this walks the
-- catalogue itself and touches only what it means to.
do $$
declare
  p       record;
  n_fixed int := 0;
  n_left  int;
begin
  for p in
    select pol.polname,
           c.relname as tbl,
           pg_get_expr(pol.polqual,      pol.polrelid) as qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as wcheck
      from pg_policy    pol
      join pg_class     c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       -- The six tables `0017_customer_pricing_billing` replaces policies on
       -- that are also archivable. Its own two new tables
       -- (`job_charge_snapshots`, `invoice_source_jobs`) are deliberately not
       -- here and carry no `archived_at`: a job's frozen charges are hidden
       -- with the job, through the job's own policy.
       and c.relname in ('invoices', 'invoice_lines', 'payments',
                         'credit_notes', 'credit_note_lines',
                         'service_agreement_lines')
       and pol.polpermissive                       -- never a restrictive one
       and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
             not ilike '%archived_at IS NULL%'
       and coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
             not ilike '%archived_at IS NULL%'
  loop
    -- The existing expression is wrapped, never restated. This repo and the
    -- hosted project have disagreed about what the `invoices` policies say
    -- since 0006 (§11), and writing a new one would silently drop whichever
    -- shape was not in front of us — the same reasoning 0017 recorded.
    if p.qual is not null and p.wcheck is not null then
      execute format('alter policy %I on public.%I using ((%s) and archived_at is null) '
                     || 'with check ((%s) and archived_at is null)',
                     p.polname, p.tbl, p.qual, p.wcheck);
    elsif p.qual is not null then
      execute format('alter policy %I on public.%I using ((%s) and archived_at is null)',
                     p.polname, p.tbl, p.qual);
    elsif p.wcheck is not null then
      execute format('alter policy %I on public.%I with check ((%s) and archived_at is null)',
                     p.polname, p.tbl, p.wcheck);
    end if;
    n_fixed := n_fixed + 1;
  end loop;

  raise notice '0028: restored the archive clause on % policy(ies)', n_fixed;

  -- Assert the outcome rather than trust the loop. A *permissive* policy on an
  -- archivable table that can still see an archived row is the whole defect, so
  -- it is checked here and not only in `archive_records.test.sql`.
  select count(*) into n_left
    from pg_policy    pol
    join pg_class     c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = any (public.archivable_tables())
     and pol.polpermissive
     and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
           not ilike '%archived_at IS NULL%'
     and coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
           not ilike '%archived_at IS NULL%';

  if n_left > 0 then
    raise exception
      '% permissive policy(ies) on archivable tables still do not filter archived_at', n_left
      using errcode = 'P0001';
  end if;
end $$;
