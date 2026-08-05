-- Proof: no tenant-owned table can ship without RLS and a policy.
-- This is the test that makes "every new table gets RLS" enforceable rather
-- than advisory — adding a tenant_id table without a policy fails CI.
begin;
select plan(3);

select is(
  (select count(*)::int from pg_tables t
    join information_schema.columns c
      on c.table_schema = t.schemaname and c.table_name = t.tablename
   where t.schemaname = 'public' and c.column_name = 'tenant_id' and not t.rowsecurity),
  0, 'every table with tenant_id has row level security enabled');

select is(
  (select count(*)::int from pg_tables t
    join information_schema.columns c
      on c.table_schema = t.schemaname and c.table_name = t.tablename
   where t.schemaname = 'public' and c.column_name = 'tenant_id'
     and not exists (select 1 from pg_policies p
                     where p.schemaname = 'public' and p.tablename = t.tablename)),
  0, 'every table with tenant_id has at least one policy');

-- A policy without `with check` silently allows writing rows you cannot read.
select is(
  (select count(*)::int from pg_policies p
    join information_schema.columns c
      on c.table_schema = p.schemaname and c.table_name = p.tablename
   where p.schemaname = 'public' and c.column_name = 'tenant_id'
     and p.cmd = 'ALL' and p.with_check is null),
  0, 'every ALL policy on a tenant table has a matching with check');

select * from finish();
rollback;
