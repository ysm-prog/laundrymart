-- ============================================================================
-- 0017_archive_records — put the business records out of sight, reversibly.
--
-- The ask is "hide the real data for now", not "delete it": the customers, the
-- jobs and the invoices have to stop appearing anywhere in the app, and have to
-- come back whole later. So nothing here removes a row. Every record table
-- below gains an `archived_at` stamp, and the tables' own RLS policies gain
-- `archived_at is null` — which is what makes the hiding real rather than
-- cosmetic. A filter added to fifty-odd queries is a filter somebody forgets on
-- the fifty-first; a predicate in the policy is applied to every query that has
-- ever been written and every query that ever will be, including anything
-- reaching PostgREST directly with a valid session.
--
-- Three consequences of putting it in the policy, all of them wanted:
--   * an archived row cannot be read, updated or deleted by a signed-in member;
--   * `with check` carries the clause too, so nobody can insert a pre-archived
--     row, and no ordinary session can archive or restore one by hand;
--   * therefore **restoring cannot be done by the app's own client** — an
--     invisible row cannot be updated back into view. That is why the archive
--     and restore entry point below is SECURITY DEFINER, membership-checked and
--     role-checked, rather than an UPDATE in a server action.
--
-- The policy rewrite is deliberately *generic*. This repo's migrations and the
-- hosted project have diverged (CLAUDE.md §11): `invoices` here carries the
-- inline `is_member`/`has_role` policies of 0006, while the live project's were
-- since replaced with `can_read_billing`/`can_write_billing` helpers from a
-- branch that has not landed. Re-stating either shape would silently drop the
-- other's predicate and hand somebody another tenant's invoices. So instead of
-- writing new policies, `apply_archive_policy()` reads each policy's existing
-- expression back out of the catalogue and appends to it — whatever it says.
--
-- No table is created and no row is deleted, moved or rewritten. The only edit
-- to existing data is the `archived_at` stamp itself, written by the function
-- at the bottom when somebody asks for it. Applying this migration alone
-- changes nothing anyone can see.
-- ============================================================================

-- --------------------------------------------------------------- the set ---
-- Stated once, and read by both the DDL loop below and the archive function,
-- so the two can never disagree about what "the business records" means.
--
-- The scope is a customer and the paperwork that hangs off one: who they are,
-- what was agreed with them, the laundry taken in for them, the visits made to
-- them and the money billed to them. Configuration and reference data is
-- deliberately *not* in it — depots, items, vehicles, drivers, public holidays,
-- route templates, inventory pools and the tenant's own settings all survive an
-- archive, because an operator who hides last year's customers still needs an
-- app that knows what a bath towel is and which vans they own.
--
-- Child rows carry their own stamp rather than leaning on the parent's policy.
-- Two of them (`laundry_order_items`, `laundry_order_activity`) would in fact
-- be hidden by their parent's RLS anyway, since their policies already gate on
-- an EXISTS against `laundry_orders`. The others would not, and a uniform rule
-- is worth more than the handful of predicates it saves: one stamp, one clause,
-- one restore, and no reasoning about which tables are covered by accident.
create or replace function public.archivable_tables()
returns text[] language sql immutable set search_path = public as $$
  select array[
    'customers', 'customer_locations', 'customer_contacts',
    'service_agreements', 'service_agreement_lines',
    'laundry_orders', 'laundry_order_items', 'laundry_order_activity',
    'invoices', 'invoice_lines', 'payments', 'credit_notes', 'credit_note_lines',
    'jobs', 'pickups', 'pickup_lines', 'deliveries', 'delivery_lines',
    'additional_charges'
  ]::text[];
$$;

comment on function public.archivable_tables() is
  'The tables an archive covers: a customer and the paperwork hanging off one. '
  'Configuration and reference data is excluded on purpose.';

-- ------------------------------------------------- the generic transform ---
create or replace function public.apply_archive_policy(tbl text)
returns void language plpgsql set search_path = public as $$
declare
  p          record;
  new_qual   text;
  new_check  text;
begin
  execute format('alter table public.%I add column if not exists archived_at timestamptz', tbl);

  -- Partial: the index exists to find archived rows for the restore, and in the
  -- ordinary case (nothing archived) it stays empty and costs nothing to
  -- maintain. The tenant index from `apply_tenant_policy` still serves reads.
  execute format('create index if not exists %I on public.%I (tenant_id) where archived_at is not null',
                 'idx_' || tbl || '_archived', tbl);

  for p in
    select pol.polname,
           pg_get_expr(pol.polqual,      pol.polrelid) as qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as wcheck
      from pg_policy       pol
      join pg_class        c on c.oid = pol.polrelid
      join pg_namespace    n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = tbl
  loop
    -- Idempotent. `create or replace` on this function plus a re-run of the
    -- migration must not stack the clause twice, and a policy that already
    -- carries it is already correct.
    if coalesce(p.qual, '') ilike '%archived_at IS NULL%'
       or coalesce(p.wcheck, '') ilike '%archived_at IS NULL%' then
      continue;
    end if;

    -- The existing expression is wrapped, never rewritten: whatever tenancy,
    -- role or driver-scoping predicate a policy carries keeps applying exactly
    -- as it did, and the archive clause is an additional narrowing.
    new_qual  := case when p.qual   is null then null else '(' || p.qual   || ') and archived_at is null' end;
    new_check := case when p.wcheck is null then null else '(' || p.wcheck || ') and archived_at is null' end;

    if new_qual is not null and new_check is not null then
      execute format('alter policy %I on public.%I using (%s) with check (%s)',
                     p.polname, tbl, new_qual, new_check);
    elsif new_qual is not null then
      execute format('alter policy %I on public.%I using (%s)', p.polname, tbl, new_qual);
    elsif new_check is not null then
      execute format('alter policy %I on public.%I with check (%s)', p.polname, tbl, new_check);
    end if;
  end loop;
end $$;

comment on function public.apply_archive_policy(text) is
  'Adds archived_at + its partial index to a table and appends `archived_at is '
  'null` to every policy already on it, preserving each policy''s own predicate.';

do $$
declare t text;
begin
  foreach t in array public.archivable_tables() loop
    perform public.apply_archive_policy(t);
  end loop;
end $$;

-- ------------------------------------------------------- archive/restore ---
-- One entry point for both directions, because they are the same statement with
-- the sign flipped and two copies would drift on the table list.
--
-- SECURITY DEFINER for the reason set out at the top: once a row is archived
-- the caller's own client cannot see it, so only a definer-rights function can
-- bring it back. That makes the membership and role check below the whole
-- boundary, so it is written the way 0010 wrote `next_number()`'s — the tenant
-- is an argument, and the function refuses a tenant the caller is not an
-- administrator of. `has_role` resolves `auth.uid()` from the request, so this
-- is safe to call on the app's ordinary RLS-bound client and must not be called
-- on the service-role one, where there is no user to check.
create or replace function public.set_records_archived(t uuid, archive boolean)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  tbl     text;
  n       bigint;
  total   bigint := 0;
begin
  if not public.has_role(t, array['super_admin','operations_manager']) then
    raise exception 'you cannot archive or restore records for that business'
      using errcode = '42501';
  end if;

  foreach tbl in array public.archivable_tables() loop
    if archive then
      -- `archived_at is null` in the predicate keeps a second archive from
      -- re-stamping rows hidden by the first, so an archive run is repeatable
      -- and the stamps keep saying when each row actually went out of sight.
      execute format(
        'update public.%I set archived_at = now() where tenant_id = $1 and archived_at is null', tbl)
        using t;
    else
      execute format(
        'update public.%I set archived_at = null where tenant_id = $1 and archived_at is not null', tbl)
        using t;
    end if;
    get diagnostics n = row_count;
    total := total + n;
  end loop;

  return total;
end $$;

comment on function public.set_records_archived(uuid, boolean) is
  'Hides (archive = true) or restores (false) a tenant''s customer, job and '
  'invoice records. Returns the number of rows moved. Administrators only.';

-- --------------------------------------------------------------- counting ---
-- The screen has to say what is hidden, and an archived row is invisible to the
-- client that would ask — so the count needs definer rights for the same reason
-- the restore does. Read-only, and scoped to a tenant the caller belongs to;
-- `is_member` rather than `has_role`, since seeing that records are hidden is
-- not an administrative act and a blank screen with no explanation is worse.
create or replace function public.archived_record_counts(t uuid)
returns table (table_name text, archived bigint, live bigint)
language plpgsql security definer set search_path = public as $$
declare tbl text; a bigint; l bigint;
begin
  if not public.is_member(t) then
    raise exception 'that business is not yours' using errcode = '42501';
  end if;

  foreach tbl in array public.archivable_tables() loop
    execute format(
      'select count(*) filter (where archived_at is not null),
              count(*) filter (where archived_at is null)
         from public.%I where tenant_id = $1', tbl)
      into a, l using t;
    table_name := tbl; archived := a; live := l;
    return next;
  end loop;
end $$;

comment on function public.archived_record_counts(uuid) is
  'Per-table archived/live row counts for a tenant the caller belongs to.';

-- ------------------------------------------------------------------ grants ---
-- 0011 revoked the implicit PUBLIC grant and set default privileges to keep it
-- revoked, so a new function is reachable by nobody until it is granted. Only
-- the two the app calls are granted; `apply_archive_policy` is DDL and stays
-- unreachable. CLAUDE.md §7: `anon` is never granted anything here.
revoke all on function public.archivable_tables()               from public, anon;
revoke all on function public.apply_archive_policy(text)        from public, anon;
revoke all on function public.set_records_archived(uuid, boolean) from public, anon;
revoke all on function public.archived_record_counts(uuid)      from public, anon;

grant execute on function public.set_records_archived(uuid, boolean) to authenticated, service_role;
grant execute on function public.archived_record_counts(uuid)        to authenticated, service_role;

-- The trap 0011 documents: the membership check above raises 42501, which is
-- also "permission denied", so a probe asserting only on the SQLSTATE passes
-- while the grant is still open. Assert on the privilege itself.
do $$
declare v_leaked text;
begin
  select string_agg(p.proname, ', ') into v_leaked
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('archivable_tables','apply_archive_policy',
                       'set_records_archived','archived_record_counts')
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_leaked is not null then
    raise exception 'anon can still execute: %', v_leaked using errcode = 'P0001';
  end if;
end $$;

-- Every listed table really did get the column and the clause. Cheap, and it
-- turns a typo in the table list from a feature that silently leaks one table's
-- rows into a migration that refuses to apply.
do $$
declare t text; v_missing text[] := '{}';
begin
  foreach t in array public.archivable_tables() loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = t
                      and column_name = 'archived_at') then
      v_missing := v_missing || t;
    end if;

    if exists (
      select 1 from pg_policy pol
        join pg_class c on c.oid = pol.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = t
         and pg_get_expr(pol.polqual, pol.polrelid) not ilike '%archived_at IS NULL%'
    ) then
      v_missing := v_missing || (t || ' (policy)');
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'archive not applied to: %', array_to_string(v_missing, ', ')
      using errcode = 'P0001';
  end if;
end $$;
