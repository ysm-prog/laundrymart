-- ============================================================================
-- 0016_import_helpers — the two set-based steps an import finishes with.
--
-- Both were written inline by `scripts/import/myob-import.py` and applied once
-- by 0015. Uploading an export from the app has to do the same two things on
-- every run, and neither is expressible in one PostgREST call: the first is a
-- correlated update over two tables, the second needs `greatest()` in an
-- upsert. Doing them from the app instead would mean paging every invoice in
-- the tenant back to a request handler and racing on a read-modify-write —
-- so they live here, where they are one statement each.
--
-- They differ in rights, and the difference is not arbitrary:
--
-- * `clear_superseded_openings` is SECURITY **INVOKER**. Every table it touches
--   carries RLS with a member policy, so the caller's own policies already
--   confine it and there is nothing to elevate. Its membership check exists only
--   to fail with a sentence instead of silently updating nothing.
-- * `park_number_sequence` is SECURITY **DEFINER**, for the same reason
--   `next_number()` is: `number_sequences` has RLS enabled and *no policy at
--   all*, so it is deny-all to `authenticated` on purpose — the numbering is
--   reachable only through a function that vets the caller first. An invoker
--   version of this simply fails. The membership check is therefore load-bearing
--   rather than cosmetic, exactly as 0010 made it in `next_number()`.
--
-- EXECUTE is revoked from PUBLIC and anon on both, per 0011.
-- ============================================================================

-- An opening balance is what a party arrived with that **no imported document
-- accounts for**. The moment a document carrying that same money is loaded, the
-- opening has to go to zero, or any query that added the two would count one
-- debt twice. 0015 states the rule and the column comments repeat it; this is
-- the rule as a callable step, because a later import can bring in the very
-- document that supersedes an opening an earlier run had to keep.
create or replace function public.clear_superseded_openings(t uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  cleared integer := 0;
  touched integer;
begin
  if not public.is_member(t) then
    raise exception 'not a member of tenant %', t using errcode = '42501';
  end if;

  update public.customers c
     set opening_balance = 0, opening_balance_overdue = 0
   where c.tenant_id = t
     and (c.opening_balance <> 0 or c.opening_balance_overdue <> 0)
     and exists (
       select 1 from public.invoices i
        where i.customer_id = c.id and i.deleted_at is null
          and i.total - i.amount_paid <> 0);
  get diagnostics touched = row_count;
  cleared := cleared + touched;

  update public.suppliers s
     set opening_balance = 0
   where s.tenant_id = t
     and s.opening_balance <> 0
     and exists (
       select 1 from public.supplier_bills b
        where b.supplier_id = s.id and b.deleted_at is null
          and b.balance_due <> 0);
  get diagnostics touched = row_count;
  return cleared + touched;
end;
$$;

-- Park a sequence past what an import used, so the first number the app issues
-- cannot collide with an imported one. `greatest()` is the point: a smaller
-- import must never wind a sequence backwards over numbers already handed out.
create or replace function public.park_number_sequence(t uuid, k text, p text, n integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  parked integer;
begin
  if not public.is_member(t) then
    raise exception 'not a member of tenant %', t using errcode = '42501';
  end if;

  insert into public.number_sequences (tenant_id, kind, prefix, next_value)
  values (t, k, p, greatest(n, 1))
  on conflict (tenant_id, kind) do update
    set next_value = greatest(public.number_sequences.next_value, excluded.next_value)
  returning next_value into parked;

  return parked;
end;
$$;

-- PostgREST publishes `public` as RPC, and Postgres grants EXECUTE to PUBLIC at
-- creation. Both grants have to go, or these are unauthenticated endpoints.
revoke execute on function public.clear_superseded_openings(uuid) from public, anon;
revoke execute on function public.park_number_sequence(uuid, text, text, integer) from public, anon;
grant execute on function public.clear_superseded_openings(uuid) to authenticated;
grant execute on function public.park_number_sequence(uuid, text, text, integer) to authenticated;
