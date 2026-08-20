-- ============================================================================
-- 0011_revoke_public_execute — finish what 0010 started.
--
-- 0010 revoked EXECUTE from `anon` and that changed nothing: Postgres grants
-- EXECUTE to the pseudo-role PUBLIC automatically when a function is created,
-- and revoking the *explicit* anon grant leaves the implicit PUBLIC one behind.
-- `has_function_privilege('anon', …)` stayed true, and every function in the
-- schema — including the SECURITY DEFINER helpers — remained reachable on
-- /rest/v1/rpc/… without signing in.
--
-- Worth naming the trap: the membership check added to next_number() in 0010
-- raises 42501, which is the same SQLSTATE Postgres uses for "permission
-- denied". A probe that only asserted "anon gets 42501" therefore passed while
-- the grant was still wide open. The check below asserts on the privilege
-- itself instead.
--
-- `authenticated` and `service_role` keep working because 0002–0009 grant them
-- EXECUTE explicitly; only the implicit PUBLIC path is closed.
-- ============================================================================

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;

-- Anything created later inherits the same posture rather than relying on
-- whoever writes the next migration remembering to revoke.
alter default privileges in schema public revoke execute on functions from public;

-- Re-state the grants the app actually depends on, so the revoke above can
-- never be read as having taken them away too.
grant execute on all functions in schema public to authenticated, service_role;

do $$
declare v_leaked text;
begin
  select string_agg(p.proname, ', ') into v_leaked
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_leaked is not null then
    raise exception 'anon can still execute: %', v_leaked using errcode = 'P0001';
  end if;
end $$;
