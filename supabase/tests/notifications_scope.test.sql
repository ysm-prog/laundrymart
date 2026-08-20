-- Proof: the bell is tenant-scoped, and a sweep that runs twice notifies once.
--
-- Two properties matter here and neither is enforceable in the page that renders
-- the bell. Cross-tenant leakage is the obvious one — a notification carries a
-- customer's name and a link straight to their invoice. The quieter one is
-- idempotency: the time-based checks run on a cron, and a bell that shows the
-- same overdue invoice five times is a bell people stop looking at, which is the
-- same as having no alerting at all.
begin;
select plan(9);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@example.com'),
  ('22222222-2222-2222-2222-222222222222','b@example.com');
insert into public.tenants (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Laundry A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Laundry B');
insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','super_admin'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','super_admin');

insert into public.notifications
  (tenant_id, audience, kind, subject_id, occurred_on, title, href) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','invoices.read','invoice_overdue',
   'f0000000-0000-0000-0000-00000000000a','2026-08-05',
   'Invoice INV00001 is past terms','/invoices?selected=f0000000-0000-0000-0000-00000000000a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','invoices.read','invoice_overdue',
   'f0000000-0000-0000-0000-00000000000b','2026-08-05',
   'Invoice INV00001 is past terms','/invoices?selected=f0000000-0000-0000-0000-00000000000b');

-- ------------------------------------------------------------------ anon ----
-- PostgREST hands an unauthenticated request to `anon`, so "you must sign in to
-- see the bell" has to be a database fact. Asserted twice on purpose: the
-- privilege itself (the check that cannot be fooled by an error code) and the
-- actual attempt, matched on its message — 42501 alone proves nothing here,
-- since our own guards raise it too.
select ok(not has_table_privilege('anon', 'public.notifications', 'SELECT'),
          'anon holds no SELECT privilege on notifications');

set local role anon;
select throws_ok(
  $$select id from public.notifications$$,
  '42501',
  'permission denied for table notifications',
  'an unauthenticated caller cannot read notifications');
reset role;

-- --------------------------------------------------------------- tenancy ----
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select is((select count(*) from public.notifications)::int, 1,
          'A sees only its own notifications');
select is((select count(*) from public.notifications
            where tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')::int, 0,
          'B''s notification is invisible, not merely unlinked');

-- The tenant-hop: a well-formed row addressed to someone else. The using clause
-- has nothing to say about an insert, so it is the with check that has to refuse.
select throws_ok(
  $$insert into public.notifications
      (tenant_id, audience, kind, title, href)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','invoices.read','invoice_overdue',
            'Injected','/invoices')$$,
  '42501',
  'new row violates row-level security policy for table "notifications"',
  'with check blocks a notification addressed to another tenant');

-- ----------------------------------------------------------- idempotency ----
-- Second run of the same daily sweep. `on conflict` names plain columns, which
-- is only legal because the index is `nulls not distinct` rather than an
-- expression — and is the only form PostgREST's `on_conflict=` can express.
-- A data-modifying CTE is only legal at the top level of a statement, so the
-- rows the insert actually wrote are parked here rather than counted inline.
create temp table sweep_result (n integer);

with ins as (
  insert into public.notifications
    (tenant_id, audience, kind, subject_id, occurred_on, title, href)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','invoices.read','invoice_overdue',
          'f0000000-0000-0000-0000-00000000000a','2026-08-05',
          'Invoice INV00001 is past terms','/invoices')
  on conflict (tenant_id, kind, subject_id, occurred_on) do nothing
  returning 1)
insert into sweep_result select 1 from ins;

select is((select count(*)::int from sweep_result), 0,
          'a repeated sweep insert affects no rows');

select is((select count(*) from public.notifications
            where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
              and kind = 'invoice_overdue')::int, 1,
          'and the event is still recorded exactly once');

-- The crux the sentinel/nulls-not-distinct choice exists for: a kind with no one
-- subject row. Under a plain unique index every NULL is distinct, so this pair
-- would land twice and the subject-less alerts would be the ones that spam.
insert into public.notifications (tenant_id, audience, kind, occurred_on, title, href)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','admin.read','sync_failed','2026-08-05',
        'Offline sync could not be completed','/admin/audit');

truncate sweep_result;

with ins as (
  insert into public.notifications
    (tenant_id, audience, kind, occurred_on, title, href)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','admin.read','sync_failed','2026-08-05',
          'Offline sync could not be completed','/admin/audit')
  on conflict (tenant_id, kind, subject_id, occurred_on) do nothing
  returning 1)
insert into sweep_result select 1 from ins;

select is((select count(*)::int from sweep_result), 0,
          'a subject-less event collides with itself too (nulls not distinct)');

-- ------------------------------------------------------------------ href ----
-- Every notification links to its fix, and that link is clicked from inside the
-- app. A protocol-relative path is an off-site redirect wearing a leading slash.
select throws_ok(
  $$insert into public.notifications (tenant_id, audience, kind, title, href)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','invoices.read','invoice_overdue',
            'Click here','//evil.example/invoices')$$,
  '23514',
  null,
  'a notification cannot link off-site');

select * from finish();
rollback;
