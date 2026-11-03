-- 0063_park_number_sequence_owner — only the Owner may move a number sequence.
--
-- `park_number_sequence` (0023) moves a laundry's invoice, customer or job
-- numbering past what a MYOB import used. It is SECURITY DEFINER because
-- `number_sequences` is deny-all to `authenticated` on purpose, and it checked
-- only `is_member(t)`. So any member, whether a board, a driver, the counter or
-- the plant floor, could call `/rest/v1/rpc/park_number_sequence` and jump the
-- invoice sequence forward. The jump is a gap in the tax-invoice numbering. Nothing
-- on screen would show it, and it cannot be undone, because `greatest()` never
-- lets the sequence go back.
--
-- The one caller is the MYOB importer (`src/lib/import/commit.ts`), behind
-- `/api/import`, which refuses anybody without `admin.write`. That capability is
-- `super_admin` alone, so the check inside now names the same role, through
-- `has_role()`, which also admits a platform admin (0019). The body is otherwise
-- 0023's exactly: same `greatest()`, same pinned search_path, same grants.
--
-- `clear_superseded_openings` (0023) is left as it is: it is SECURITY INVOKER, so
-- RLS (0048 on customers, 0036 on suppliers) already decides whose rows it can
-- touch, and a role that cannot write a customer clears nothing.
--
-- Adds no table, column, policy or trigger; changes no row.

create or replace function public.park_number_sequence(t uuid, k text, p text, n integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  parked integer;
begin
  if not public.has_role(t, array['super_admin']) then
    raise exception 'only the owner can move a number sequence'
      using errcode = '42501';
  end if;

  insert into public.number_sequences (tenant_id, kind, prefix, next_value)
  values (t, k, p, greatest(n, 1))
  on conflict (tenant_id, kind) do update
    set next_value = greatest(public.number_sequences.next_value, excluded.next_value)
  returning next_value into parked;

  return parked;
end;
$$;

-- `create or replace` keeps existing grants, but restate them so this file alone
-- says who may call it (0011's rule: nothing in `public` is anon-executable).
revoke execute on function public.park_number_sequence(uuid, text, text, integer) from public, anon;
grant execute on function public.park_number_sequence(uuid, text, text, integer) to authenticated;

do $$
declare
  v_src text;
  v_def boolean;
  v_cfg text[];
begin
  select prosrc, prosecdef, proconfig into v_src, v_def, v_cfg
    from pg_proc where oid = 'public.park_number_sequence(uuid, text, text, integer)'::regprocedure;
  if v_src not like '%has_role(t, array[''super_admin''])%' then
    raise exception '0063: park_number_sequence must check the owner role';
  end if;
  if v_src like '%is_member(t)%' then
    raise exception '0063: park_number_sequence must not fall back to membership';
  end if;
  if v_src not like '%greatest(public.number_sequences.next_value%' then
    raise exception '0063: park_number_sequence must never wind a sequence back';
  end if;
  if not v_def then
    raise exception '0063: park_number_sequence must stay SECURITY DEFINER';
  end if;
  if v_cfg is null or not ('search_path=public' = any(v_cfg)) then
    raise exception '0063: park_number_sequence must keep its pinned search_path';
  end if;
  if has_function_privilege('anon', 'public.park_number_sequence(uuid, text, text, integer)', 'EXECUTE') then
    raise exception '0063: anon must not execute park_number_sequence';
  end if;
  if not has_function_privilege('authenticated', 'public.park_number_sequence(uuid, text, text, integer)', 'EXECUTE') then
    raise exception '0063: the importer runs as authenticated and must be able to call it';
  end if;
end $$;
