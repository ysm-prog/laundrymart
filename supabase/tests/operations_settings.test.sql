-- Proof: 0057 — Settings › How you work (Darshan's BA review, Phase 3).
--
--   * The Owner can save the `operations` key, and it lands beside the others
--     rather than replacing them.
--   * Every key an earlier migration admitted still saves.
--   * A key the screens do not know is still refused (22023), and a non-owner
--     is still refused (42501).
begin;
select plan(7);

insert into auth.users (id, email) values
  ('0f570000-0000-4000-8000-000000000001','owner@example.com'),
  ('0f570000-0000-4000-8000-000000000002','office@example.com');

insert into public.tenants (id, name, settings) values
  ('0f570000-0000-4000-8000-0000000000aa','Laundry A',
   '{"automation": {"autoAssignOnReady": true}}'::jsonb);
insert into public.memberships (user_id, tenant_id, role) values
  ('0f570000-0000-4000-8000-000000000001','0f570000-0000-4000-8000-0000000000aa','super_admin'),
  ('0f570000-0000-4000-8000-000000000002','0f570000-0000-4000-8000-0000000000aa','operations_manager');

set local role authenticated;
set local "request.jwt.claim.sub" = '0f570000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.save_tenant_settings('0f570000-0000-4000-8000-0000000000aa', 'operations',
                                       '{"plantStages": true, "defaultTurnaroundDays": 3}'::jsonb)$$,
  'the Owner can save the operations settings');
select lives_ok(
  $$select public.save_tenant_settings('0f570000-0000-4000-8000-0000000000aa', 'receivables',
                                       '{"trustedFrom": "2026-10-01"}'::jsonb)$$,
  'an earlier key still saves');
select throws_ok(
  $$select public.save_tenant_settings('0f570000-0000-4000-8000-0000000000aa', 'ui_mode', '{}'::jsonb)$$,
  '22023', null, 'a key no screen knows is still refused');

set local "request.jwt.claim.sub" = '0f570000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.save_tenant_settings('0f570000-0000-4000-8000-0000000000aa', 'operations',
                                       '{"plantStages": false}'::jsonb)$$,
  '42501', null, 'the Office manager cannot change it');
reset role;

select is((select settings -> 'operations' ->> 'defaultTurnaroundDays' from public.tenants
            where id = '0f570000-0000-4000-8000-0000000000aa'),
          '3', 'the turnaround landed');
select is((select (settings -> 'operations' ->> 'plantStages')::boolean from public.tenants
            where id = '0f570000-0000-4000-8000-0000000000aa'),
          true, 'the Office manager''s refused write changed nothing');
select is((select settings -> 'automation' ->> 'autoAssignOnReady' from public.tenants
            where id = '0f570000-0000-4000-8000-0000000000aa'),
          'true', 'the other settings survived the merge');

select * from finish();
rollback;
