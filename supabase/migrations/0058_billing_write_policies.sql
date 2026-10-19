-- ============================================================================
-- 0058 — the billing tables' write policies name their verbs.
--
-- 0017 gave eight money tables a `<t>_read` SELECT policy and a `<t>_write`
-- policy `for all`. A `for all` policy's USING half is also a SELECT policy, so
-- every read on these tables evaluated two permissive policies and OR'd them.
-- The Supabase performance advisor reports exactly that, once per table
-- (multiple_permissive_policies, WARN).
--
-- **Nobody's access changes, and that was checked rather than assumed.** The
-- write set sits inside the read set on every one of the eight tables:
--   * can_write_billing() names super_admin, operations_manager, finance,
--     branch_manager and regional_manager, and can_read_billing() names all
--     five plus the auditor;
--   * service_agreement_lines' write list (super_admin, operations_manager,
--     finance, sales, branch_manager, regional_manager) sits inside
--     can_read_pricing(), which adds the auditor.
-- So the SELECT the `for all` granted only ever repeated what `<t>_read`
-- already granted. Splitting it into INSERT/UPDATE/DELETE drops a redundant
-- predicate from every read of the ledger, and it removes the last permissive
-- `for all` policy from the money tables. That shape has had to be replaced six
-- times in this schema, because its USING half quietly grants SELECT (0033,
-- 0035, 0036, 0040, 0048, 0049).
--
-- **The expressions are read out of the catalogue, not restated.** That is
-- 0017's reasoning for `apply_archive_policy()`. The archive clause (0017, put
-- back by 0028) is in six of these predicates and not in the other two.
-- Writing the policies out by hand is how a clause gets dropped, and an archived
-- invoice became readable that way once already (§3, the two 0017s). Each new
-- policy takes the old policy's own USING and WITH CHECK text verbatim, and the
-- assertions compare the two.
--
-- 0025's restrictive layer (`<t>_main_flow_*`) is untouched. It still ANDs
-- super_admin/operations_manager on top of every write here.
--
-- Adds no table, column, function or capability; changes no row. Idempotent: a
-- table whose `<t>_write` is already gone and whose three verb policies exist
-- is skipped with a notice.
-- ============================================================================

-- What each `<t>_write` said before it was dropped, so the assertions can
-- compare the new policies against it rather than against each other.
create temporary table _0058_before (tablename text primary key, qual text, with_check text);

do $$
declare
  v_tables text[] := array[
    'credit_note_lines', 'credit_notes', 'invoice_lines', 'invoice_source_jobs',
    'invoices', 'job_charge_snapshots', 'payments', 'service_agreement_lines'];
  v_table text;
  v_using text;
  v_check text;
  v_roles text;
begin
  foreach v_table in array v_tables loop
    select qual, with_check, array_to_string(roles, ', ')
      into v_using, v_check, v_roles
      from pg_policies
     where schemaname = 'public' and tablename = v_table
       and policyname = v_table || '_write'
       and permissive = 'PERMISSIVE' and cmd = 'ALL';

    if not found then
      if (select count(*) from pg_policies
           where schemaname = 'public' and tablename = v_table
             and policyname in (v_table || '_write_insert', v_table || '_write_update',
                                v_table || '_write_delete')) = 3 then
        raise notice '0058: %.% already split, skipped', 'public', v_table;
        continue;
      end if;
      raise exception '0058: public.% has no permissive for-all %_write policy to split',
        v_table, v_table;
    end if;

    -- A `for all` policy with no WITH CHECK uses its USING for both halves.
    v_check := coalesce(v_check, v_using);
    insert into _0058_before values (v_table, v_using, v_check);

    execute format('drop policy %I on public.%I', v_table || '_write', v_table);
    execute format('create policy %I on public.%I as permissive for insert to %s with check (%s)',
                   v_table || '_write_insert', v_table, v_roles, v_check);
    execute format('create policy %I on public.%I as permissive for update to %s using (%s) with check (%s)',
                   v_table || '_write_update', v_table, v_roles, v_using, v_check);
    execute format('create policy %I on public.%I as permissive for delete to %s using (%s)',
                   v_table || '_write_delete', v_table, v_roles, v_using);
  end loop;
end $$;

-- ------------------------------------------------------------- assertions ---
do $$
declare
  v_tables text[] := array[
    'credit_note_lines', 'credit_notes', 'invoice_lines', 'invoice_source_jobs',
    'invoices', 'job_charge_snapshots', 'payments', 'service_agreement_lines'];
  v_archivable text[] := array[
    'credit_note_lines', 'credit_notes', 'invoice_lines', 'invoices', 'payments',
    'service_agreement_lines'];
  v_table text;
  v_missing text[] := '{}';
  v_n integer;
  v_ins text;
  v_upd_using text;
  v_upd_check text;
  v_del text;
begin
  foreach v_table in array v_tables loop
    -- 1. No permissive `for all` left.
    select count(*) into v_n from pg_policies
     where schemaname = 'public' and tablename = v_table
       and permissive = 'PERMISSIVE' and cmd = 'ALL';
    if v_n > 0 then
      v_missing := v_missing || (v_table || ': a permissive for-all policy remains')::text;
    end if;

    -- 2. Exactly one permissive SELECT path: the read policy. This is the
    --    advisor's finding, asked directly.
    select count(*) into v_n from pg_policies
     where schemaname = 'public' and tablename = v_table
       and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL');
    if v_n <> 1 then
      v_missing := v_missing || (v_table || ': ' || v_n || ' permissive policies grant SELECT, not 1')::text;
    end if;

    -- 3. One permissive policy per write verb, each carrying the old `for all`
    --    policy's own predicate, so no verb is gated differently from before.
    select with_check into v_ins from pg_policies
     where schemaname = 'public' and tablename = v_table and policyname = v_table || '_write_insert'
       and permissive = 'PERMISSIVE' and cmd = 'INSERT';
    select qual, with_check into v_upd_using, v_upd_check from pg_policies
     where schemaname = 'public' and tablename = v_table and policyname = v_table || '_write_update'
       and permissive = 'PERMISSIVE' and cmd = 'UPDATE';
    select qual into v_del from pg_policies
     where schemaname = 'public' and tablename = v_table and policyname = v_table || '_write_delete'
       and permissive = 'PERMISSIVE' and cmd = 'DELETE';
    if v_ins is null or v_upd_using is null or v_upd_check is null or v_del is null then
      v_missing := v_missing || (v_table || ': a write verb has no policy')::text;
    elsif exists (select 1 from _0058_before b
                   where b.tablename = v_table
                     and not (b.with_check = v_ins and b.with_check = v_upd_check
                              and b.qual = v_upd_using and b.qual = v_del)) then
      v_missing := v_missing || (v_table || ': a write verb is gated differently from the old policy')::text;
    end if;

    -- 4. The archive clause survived where it was: the 0028 trap. `ilike`,
    --    because pg_get_expr renders it `archived_at IS NULL` (0047).
    if v_table = any (v_archivable) then
      select count(*) into v_n from pg_policies
       where schemaname = 'public' and tablename = v_table
         and permissive = 'PERMISSIVE'
         and policyname like v_table || '_write_%'
         and coalesce(qual, '') || ' ' || coalesce(with_check, '') not ilike '%archived_at is null%';
      if v_n > 0 then
        v_missing := v_missing || (v_table || ': a write policy lost archived_at is null')::text;
      end if;
    end if;

    -- 5. 0025's restrictive layer is still there on the tables that carry it.
    if v_table not in ('invoice_source_jobs', 'job_charge_snapshots', 'service_agreement_lines') then
      select count(*) into v_n from pg_policies
       where schemaname = 'public' and tablename = v_table and permissive = 'RESTRICTIVE';
      if v_n < 3 then
        v_missing := v_missing || (v_table || ': 0025''s restrictive write policies are missing')::text;
      end if;
    end if;

    -- 6. RLS is still on.
    if not (select relrowsecurity from pg_class where oid = ('public.' || v_table)::regclass) then
      v_missing := v_missing || (v_table || ': row level security is off')::text;
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception '0058 did not apply cleanly: %', array_to_string(v_missing, '; ');
  end if;
end $$;

drop table _0058_before;
