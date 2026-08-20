-- ============================================================================
-- 0010_function_hardening — close two holes that only exist once PostgREST is
-- actually exposed. Both were invisible against local Postgres, which has no
-- REST layer and no `anon` traffic.
--
-- 1. `next_number()` is SECURITY DEFINER and takes the tenant id as a plain
--    argument. Every function in `public` was granted to `anon`, and PostgREST
--    publishes the schema, so anyone holding the (public by design) anon key
--    could POST /rest/v1/rpc/next_number with someone else's tenant id and
--    increment their invoice sequence. Nothing is disclosed by that, but §11
--    requires invoice numbers to be sequential *without gaps*, and this let an
--    outsider punch permanent holes in a finance record. The definer rights are
--    needed — the sequence table is deliberately not writable by members — so
--    the fix is a membership check inside the function.
--
-- 2. `anon` had EXECUTE on every function in `public`. The role exists only to
--    reach the login page, which calls no RPC at all, so the whole surface is
--    revoked. NOTE for future migrations: the boilerplate `grant execute on all
--    functions ... to anon` in 0002–0009 predates this; do not repeat it.
--
-- Also pins `search_path` on the functions that were missing it, so a caller
-- cannot influence name resolution inside them.
-- ============================================================================

create or replace function public.next_number(t uuid, k text, p text default '')
returns text language plpgsql security definer set search_path = public as $$
declare n bigint; pre text;
begin
  -- Definer rights end at the tenant boundary: a caller may only draw numbers
  -- for a tenant they belong to.
  if not public.is_member(t) then
    raise exception 'not a member of that tenant' using errcode = '42501';
  end if;

  insert into public.number_sequences (tenant_id, kind, prefix)
    values (t, k, p) on conflict (tenant_id, kind) do nothing;
  update public.number_sequences
     set next_value = next_value + 1
   where tenant_id = t and kind = k
   returning next_value - 1, prefix into n, pre;
  return coalesce(nullif(pre, ''), p) || lpad(n::text, 5, '0');
end $$;

-- Pin the search_path on everything that was missing it. `alter` rather than
-- a redefinition so the bodies stay where they were written.
alter function public.set_updated_at()            set search_path = public;
alter function public.apply_tenant_policy(text)   set search_path = public;
alter function public.guard_item_soft_delete()    set search_path = public;
alter function public.guard_route_transition()    set search_path = public;
alter function public.guard_batch_transition()    set search_path = public;
alter function public.guard_batch_line_change()   set search_path = public;
-- media_tenant calls storage.foldername, which it already schema-qualifies.
alter function public.media_tenant(text)          set search_path = public;

-- The pre-login role needs no RPC whatsoever.
revoke execute on all functions in schema public from anon;
