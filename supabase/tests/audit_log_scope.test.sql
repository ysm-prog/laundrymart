-- The activity log is for the people who answer for it (0035).
--
-- Readable by every member of a laundry since 0001 — a driver, a board, the
-- counter and the plant floor could all read the whole tenant's trail off
-- PostgREST. It carries no money, which is why it outlived the billing
-- narrowing, but it is the one table whose whole job is to say who did what.
--
-- Every assertion here is by **outcome**. A refused SELECT is not an error, it
-- is an empty result, and a refused INSERT under a `with check` does raise —
-- so the two halves are proved differently and deliberately.
begin;
select plan(11);

create extension if not exists pgtap;

insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111','owner@example.com'),
  ('a2222222-2222-2222-2222-222222222222','auditor@example.com'),
  ('a3333333-3333-3333-3333-333333333333','driver@example.com'),
  ('a4444444-4444-4444-4444-444444444444','counter@example.com'),
  ('a5555555-5555-5555-5555-555555555555','other-laundry@example.com');

insert into public.tenants (id, name) values
  ('b1111111-1111-1111-1111-111111111111','Laundry A'),
  ('b2222222-2222-2222-2222-222222222222','Laundry B');

insert into public.memberships (user_id, tenant_id, role) values
  ('a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111','super_admin'),
  ('a2222222-2222-2222-2222-222222222222','b1111111-1111-1111-1111-111111111111','auditor'),
  ('a3333333-3333-3333-3333-333333333333','b1111111-1111-1111-1111-111111111111','driver'),
  ('a4444444-4444-4444-4444-444444444444','b1111111-1111-1111-1111-111111111111','customer_service'),
  ('a5555555-5555-5555-5555-555555555555','b2222222-2222-2222-2222-222222222222','super_admin');

insert into public.audit_logs (tenant_id, actor_id, entity, entity_id, action, summary) values
  ('b1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111',
   'invoice', null, 'send', 'Invoice INV00042 emailed'),
  ('b1111111-1111-1111-1111-111111111111','a3333333-3333-3333-3333-333333333333',
   'laundry_order', null, 'status_change', 'LJ00007 delivered'),
  ('b2222222-2222-2222-2222-222222222222','a5555555-5555-5555-5555-555555555555',
   'customer', null, 'create', 'another laundry entirely');

set local role authenticated;

-- ------------------------------------------------------------- who reads ----
set local "request.jwt.claim.sub" = 'a1111111-1111-1111-1111-111111111111';
select is((select count(*) from public.audit_logs)::int, 2,
          'the owner reads their laundry''s trail');

-- The role whose entire purpose is to look at what happened. Shutting them out
-- would be the obvious way to get this wrong, which is why the policy names a
-- role list rather than `admin.write`.
set local "request.jwt.claim.sub" = 'a2222222-2222-2222-2222-222222222222';
select is((select count(*) from public.audit_logs)::int, 2,
          'so does the auditor, whose whole job it is');

set local "request.jwt.claim.sub" = 'a3333333-3333-3333-3333-333333333333';
select is((select count(*) from public.audit_logs)::int, 0,
          'a driver reads none of it — this is the change');

set local "request.jwt.claim.sub" = 'a4444444-4444-4444-4444-444444444444';
select is((select count(*) from public.audit_logs)::int, 0,
          'and neither does the counter');

-- Tenancy still comes first: the narrowing is on top of it, not instead of it.
set local "request.jwt.claim.sub" = 'a5555555-5555-5555-5555-555555555555';
select is((select count(*) from public.audit_logs)::int, 1,
          'the other laundry''s owner sees only their own');

-- ------------------------------------------------------------ who writes ----
-- The half that would break the application in silence. `recordAudit()` runs on
-- the caller's own client at the moment they cause an event, so a driver
-- completing a delivery writes their own row. If this were narrowed with the
-- read, the log would quietly stop recording the people it exists to record.
set local "request.jwt.claim.sub" = 'a3333333-3333-3333-3333-333333333333';
select lives_ok(
  $$ insert into public.audit_logs (tenant_id, actor_id, entity, action, summary)
     values ('b1111111-1111-1111-1111-111111111111',
             'a3333333-3333-3333-3333-333333333333',
             'laundry_order','status_change','LJ00008 delivered') $$,
  'a driver can still record what they did');

-- Asserted by outcome from a role that can read, because the writer cannot see
-- their own row and `lives_ok` alone would pass against a write that vanished.
set local "request.jwt.claim.sub" = 'a1111111-1111-1111-1111-111111111111';
select is((select count(*) from public.audit_logs)::int, 3,
          'and the entry is really there');

-- Nobody writes an entry in somebody else's name.
set local "request.jwt.claim.sub" = 'a3333333-3333-3333-3333-333333333333';
select throws_ok(
  $$ insert into public.audit_logs (tenant_id, actor_id, entity, action)
     values ('b1111111-1111-1111-1111-111111111111',
             'a1111111-1111-1111-1111-111111111111','invoice','send') $$,
  '42501', null, 'a driver cannot sign an entry as the owner');

select throws_ok(
  $$ insert into public.audit_logs (tenant_id, actor_id, entity, action)
     values ('b2222222-2222-2222-2222-222222222222',
             'a3333333-3333-3333-3333-333333333333','invoice','send') $$,
  '42501', null, 'nor write into another laundry');

-- --------------------------------------------------------- append-only ------
-- The old `for all` policy handed UPDATE and DELETE to any member, so the trail
-- could be edited or erased by the person it incriminates. With RLS on and no
-- policy for either verb, the refusal is a silence — so both are asserted by
-- counting afterwards, from a session that can see the rows.
set local "request.jwt.claim.sub" = 'a1111111-1111-1111-1111-111111111111';
update public.audit_logs set summary = 'nothing to see here'
 where summary = 'Invoice INV00042 emailed';
select is((select count(*) from public.audit_logs
            where summary = 'Invoice INV00042 emailed')::int, 1,
          'not even the owner can rewrite an entry');

delete from public.audit_logs where summary = 'Invoice INV00042 emailed';
select is((select count(*) from public.audit_logs
            where summary = 'Invoice INV00042 emailed')::int, 1,
          'or erase one');

select * from finish();
rollback;
