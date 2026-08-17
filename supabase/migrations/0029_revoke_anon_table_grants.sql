-- ============================================================================
-- 0029_revoke_anon_table_grants — `anon` may not touch a single table in
-- `public`, and no future table hands it one back.
--
-- ## What was actually there
--
-- Found on the hosted project while verifying 0017 and left open since (§11).
-- The first note recorded it as "SELECT and INSERT"; a proper look found `anon`
-- holding **DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE** —
-- the whole set — on **52 of 53** tables in `public`. None of it comes from this
-- repo's migrations. It is Supabase's stock default privileges, which grant
-- `anon` and `authenticated` on every table created in `public`, plus whatever
-- the import branches added on top.
--
-- ## Why "inert" was too generous
--
-- The earlier note reasoned that RLS is enabled on every table and every policy
-- is `to authenticated`, so `anon` matches no row. Both halves are still true
-- (this migration re-asserts them), and for SELECT/INSERT/UPDATE/DELETE that is
-- a real defence.
--
-- **It is not a defence against TRUNCATE.** Row-level security filters rows; it
-- has nothing to say about a command that removes all of them, so a role holding
-- TRUNCATE truncates the table whatever the policies say. The same goes for
-- REFERENCES and TRIGGER, which are schema-level rights RLS never sees. What has
-- kept this from being exploitable is not RLS but PostgREST: it exposes the four
-- row commands and RPC, and 0011 already revoked every function from `anon`, so
-- there is no route to a TRUNCATE from the public anon key alone. That is one
-- accident away from being untrue, and it is not the property we want to be
-- relying on.
--
-- ## The two halves of the fix
--
-- Revoking today's grants is only half of it: the **default privileges** are why
-- this keeps coming back. Fifteen default ACLs on this project mention `anon`,
-- and the three that matter here grant it every new table, sequence and function
-- created in `public`. Without changing those, the next migration that adds a
-- table re-opens exactly this hole — which is precisely what happened between
-- 0011 (functions revoked) and now.
--
-- `xero_connections` is the one table `anon` could already not touch, because
-- 0026 revoked it by hand. This generalises that to the schema and to the
-- future, and the assertion at the end is the same shape 0011 and 0026 use.
--
-- ## Deliberately NOT touched
--
--  * `authenticated` and `service_role` keep everything. This changes who may
--    reach a table without a login, and nothing else.
--  * `usage on schema public` stays granted to `anon`. Revoking it would work
--    too, and is a bigger hammer than the hole needs: with no table and no
--    function privileges there is nothing in the schema to reach, and keeping
--    USAGE means a misconfiguration surfaces as "permission denied for table"
--    rather than as a confusing schema-level error.
--  * The `storage`, `graphql` and `graphql_public` schemas. Their default ACLs
--    also name `anon`, they are Supabase's own, and `storage.objects` is where
--    0007's media policies live — this repo does not own that surface and
--    breaking it would take the driver's photo capture with it.
-- ============================================================================

-- ------------------------------------------------------- today's grants -----
revoke all on all tables in schema public from anon;
-- No sequences exist in `public` on this project (every key is a uuid and the
-- document numbers live in a table), but a future one must not arrive granted.
revoke all on all sequences in schema public from anon;

-- 0011 revoked functions from `anon` and from PUBLIC; restated here because a
-- `create or replace` re-grants EXECUTE to PUBLIC by default, which is the trap
-- 0011 and 0012 both recorded.
revoke all on all functions in schema public from anon;

-- --------------------------------------------------- and the future ones ----
-- The half that stops this recurring. Applied for every role that currently
-- carries a default ACL granting `anon` in `public`, rather than assuming
-- `postgres` — on a Supabase project `supabase_admin` carries them too, and a
-- table created by either would otherwise arrive with the grant on it.
--
-- `supabase_admin` is not ours to alter on a hosted project, so a refusal there
-- is reported and skipped rather than failing the migration: every table this
-- repo creates is owned by `postgres`, which is the one that must succeed.
do $$
declare
  r record;
  n_done int := 0;
begin
  for r in
    select distinct pg_get_userbyid(d.defaclrole) as owner
      from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
     where n.nspname = 'public'
       and array_to_string(d.defaclacl, ',') like '%anon=%'
  loop
    begin
      execute format(
        'alter default privileges for role %I in schema public revoke all on tables from anon',
        r.owner);
      execute format(
        'alter default privileges for role %I in schema public revoke all on sequences from anon',
        r.owner);
      execute format(
        'alter default privileges for role %I in schema public revoke all on functions from anon',
        r.owner);
      n_done := n_done + 1;
    exception when insufficient_privilege then
      raise notice '0029: cannot alter default privileges for %, skipped', r.owner;
    end;
  end loop;

  -- Whatever the catalogue held, the role this repo's migrations run as must be
  -- covered — on a fresh database there may be no default ACL to find yet.
  begin
    alter default privileges in schema public revoke all on tables from anon;
    alter default privileges in schema public revoke all on sequences from anon;
    alter default privileges in schema public revoke all on functions from anon;
  exception when insufficient_privilege then
    raise notice '0029: cannot alter own default privileges, skipped';
  end;

  raise notice '0029: default privileges revoked for % role(s)', n_done;
end $$;

-- ---------------------------------------------------------------- proof -----
-- Asserted here rather than only in pgTAP, so the migration fails instead of
-- half-applying. Three separate claims, because each could be false on its own.
do $chk$
declare
  v_tables int;
  v_funcs  text;
  v_norls  text;
begin
  select count(*) into v_tables
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon';
  if v_tables > 0 then
    raise exception 'anon still holds % table privilege(s) in public', v_tables
      using errcode = 'P0001';
  end if;

  select string_agg(p.proname, ', ') into v_funcs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_funcs is not null then
    raise exception 'anon can still execute: %', v_funcs using errcode = 'P0001';
  end if;

  -- Belt and braces on the property the old note was leaning on: every table in
  -- `public` still has RLS enabled. If that were ever false, the revoke above is
  -- what stands between an unauthenticated caller and the rows.
  select string_agg(c.relname, ', ') into v_norls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_norls is not null then
    raise exception 'RLS is not enabled on: %', v_norls using errcode = 'P0001';
  end if;
end $chk$;
