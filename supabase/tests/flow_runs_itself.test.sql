-- Proof: 0056 — the database halves of Darshan's BA review, Phase 2.
--
--   * A delivered job finishes its stop, in the same transaction, whoever wrote
--     the row; a stop with work still on it stays open; a visit that also
--     expects a collection is only marked delivery-completed; and a run whose
--     stops are all done moves to `returning` (brief 2.1).
--   * Proof of delivery is stored only under the job's own folder (brief 2.4).
--   * `customers.auto_approve` defaults on (brief 2.3).
--   * The Owner can save the `automation` settings key, still nothing unknown.
--   * A round can write its own job's timeline, and not another round's.
--   * The trigger function is not on the RPC surface.
begin;
select plan(16);

insert into auth.users (id, email) values
  ('0f560000-0000-4000-8000-000000000001','owner@example.com'),
  ('0f560000-0000-4000-8000-000000000002','board1@example.com'),
  ('0f560000-0000-4000-8000-000000000003','board2@example.com');

insert into public.tenants (id, name) values
  ('0f560000-0000-4000-8000-0000000000aa','Laundry A');
insert into public.memberships (user_id, tenant_id, role) values
  ('0f560000-0000-4000-8000-000000000001','0f560000-0000-4000-8000-0000000000aa','super_admin'),
  ('0f560000-0000-4000-8000-000000000002','0f560000-0000-4000-8000-0000000000aa','board'),
  ('0f560000-0000-4000-8000-000000000003','0f560000-0000-4000-8000-0000000000aa','board');

insert into public.boards (id, tenant_id, user_id, code, name) values
  ('0f56b000-0000-4000-8000-000000000001','0f560000-0000-4000-8000-0000000000aa',
   '0f560000-0000-4000-8000-000000000002','BOARD1','Board 1'),
  ('0f56b000-0000-4000-8000-000000000002','0f560000-0000-4000-8000-0000000000aa',
   '0f560000-0000-4000-8000-000000000003','BOARD2','Board 2');

insert into public.customers (id, tenant_id, customer_number, business_name) values
  ('0f56c000-0000-4000-8000-000000000001','0f560000-0000-4000-8000-0000000000aa','CUST00001','Cafe A');

select is((select auto_approve from public.customers where id = '0f56c000-0000-4000-8000-000000000001'),
          true, 'a customer is approved automatically unless somebody says otherwise');

-- Two runs out on the road. R1 carries three stops; R2 carries one.
insert into public.daily_routes (id, tenant_id, route_date, code, name, board_id, status,
                                 load_confirmed_at, started_at) values
  ('0f56d000-0000-4000-8000-000000000001','0f560000-0000-4000-8000-0000000000aa',
   '2026-10-19','BOARD1-1','Board 1','0f56b000-0000-4000-8000-000000000001','in_progress', now(), now()),
  ('0f56d000-0000-4000-8000-000000000002','0f560000-0000-4000-8000-0000000000aa',
   '2026-10-19','BOARD2-1','Board 2','0f56b000-0000-4000-8000-000000000002','in_progress', now(), now());

insert into public.jobs (id, tenant_id, route_id, customer_id, job_number, scheduled_date, sequence, service_type) values
  ('0f56e000-0000-4000-8000-000000000001','0f560000-0000-4000-8000-0000000000aa',
   '0f56d000-0000-4000-8000-000000000001','0f56c000-0000-4000-8000-000000000001','JOB00001','2026-10-19',1,'delivery'),
  ('0f56e000-0000-4000-8000-000000000002','0f560000-0000-4000-8000-0000000000aa',
   '0f56d000-0000-4000-8000-000000000001','0f56c000-0000-4000-8000-000000000001','JOB00002','2026-10-19',2,'both'),
  ('0f56e000-0000-4000-8000-000000000003','0f560000-0000-4000-8000-0000000000aa',
   '0f56d000-0000-4000-8000-000000000001','0f56c000-0000-4000-8000-000000000001','JOB00003','2026-10-19',3,'delivery'),
  ('0f56e000-0000-4000-8000-000000000004','0f560000-0000-4000-8000-0000000000aa',
   '0f56d000-0000-4000-8000-000000000002','0f56c000-0000-4000-8000-000000000001','JOB00004','2026-10-19',1,'delivery');

insert into public.laundry_orders
  (id, tenant_id, customer_id, order_number, status, delivery_required,
   expected_delivery_date, assigned_board_id, assigned_delivery_date, stop_id) values
  ('0f56f000-0000-4000-8000-000000000001','0f560000-0000-4000-8000-0000000000aa','0f56c000-0000-4000-8000-000000000001',
   'LJ00001','out_for_delivery',true,'2026-10-19','0f56b000-0000-4000-8000-000000000001','2026-10-19','0f56e000-0000-4000-8000-000000000001'),
  ('0f56f000-0000-4000-8000-000000000002','0f560000-0000-4000-8000-0000000000aa','0f56c000-0000-4000-8000-000000000001',
   'LJ00002','out_for_delivery',true,'2026-10-19','0f56b000-0000-4000-8000-000000000001','2026-10-19','0f56e000-0000-4000-8000-000000000002'),
  ('0f56f000-0000-4000-8000-000000000003','0f560000-0000-4000-8000-0000000000aa','0f56c000-0000-4000-8000-000000000001',
   'LJ00003','out_for_delivery',true,'2026-10-19','0f56b000-0000-4000-8000-000000000001','2026-10-19','0f56e000-0000-4000-8000-000000000003'),
  ('0f56f000-0000-4000-8000-000000000004','0f560000-0000-4000-8000-0000000000aa','0f56c000-0000-4000-8000-000000000001',
   'LJ00004','out_for_delivery',true,'2026-10-19','0f56b000-0000-4000-8000-000000000001','2026-10-19','0f56e000-0000-4000-8000-000000000003'),
  ('0f56f000-0000-4000-8000-000000000005','0f560000-0000-4000-8000-0000000000aa','0f56c000-0000-4000-8000-000000000001',
   'LJ00005','out_for_delivery',true,'2026-10-19','0f56b000-0000-4000-8000-000000000002','2026-10-19','0f56e000-0000-4000-8000-000000000004');

-- --------------------------------------------------------- 2.1 the stop ----
update public.laundry_orders set status = 'completed' where order_number = 'LJ00001';
select is((select status || '/' || progress_status from public.jobs where job_number = 'JOB00001'),
          'completed/completed', 'delivering the only job on a stop completes the stop — JOB00025');
select is((select status from public.daily_routes where code = 'BOARD1-1'),
          'in_progress', 'the run stays out while it still has stops to make');

update public.laundry_orders set status = 'completed' where order_number = 'LJ00002';
select is((select status || '/' || progress_status from public.jobs where job_number = 'JOB00002'),
          'scheduled/delivery_completed',
          'a visit that also expects a collection is only marked delivery-completed');

update public.laundry_orders set status = 'completed' where order_number = 'LJ00003';
select is((select status from public.jobs where job_number = 'JOB00003'),
          'scheduled', 'a stop with a second job still on the van stays open');

update public.laundry_orders set status = 'cancelled' where order_number = 'LJ00004';
select is((select status from public.jobs where job_number = 'JOB00003'),
          'completed', 'once the last job on it is finished or cancelled, the stop is done');

update public.laundry_orders set status = 'completed' where order_number = 'LJ00005';
select is((select status from public.daily_routes where code = 'BOARD2-1'),
          'returning', 'a run with every stop done is on its way back');
select ok((select returned_at is not null from public.daily_routes where code = 'BOARD2-1'),
          'and it says when');

-- -------------------------------------------------------- 2.4 the proof ----
select throws_ok(
  $$update public.laundry_orders
       set delivery_signature_path = 'someone-else/delivery/x/signature-0.png'
     where order_number = 'LJ00001'$$,
  '23514', null, 'a signature stored outside this job''s own folder is refused');
select lives_ok(
  $$update public.laundry_orders
       set delivery_signature_path = '0f560000-0000-4000-8000-0000000000aa/delivery/0f56f000-0000-4000-8000-000000000001/signature-0.png',
           delivery_received_by = 'Sam at reception', delivery_short = false
     where order_number = 'LJ00001'$$,
  'the job''s own signature is stored');

-- ------------------------------------------- settings and the timeline ----
set local role authenticated;
set local "request.jwt.claim.sub" = '0f560000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.save_tenant_settings('0f560000-0000-4000-8000-0000000000aa', 'automation',
                                       '{"autoAssignOnReady": true, "emailOnIssue": false}'::jsonb)$$,
  'the Owner can save the automation settings');
select throws_ok(
  $$select public.save_tenant_settings('0f560000-0000-4000-8000-0000000000aa', 'ui_mode', '{}'::jsonb)$$,
  '22023', null, 'still nothing the screen does not know about');

set local "request.jwt.claim.sub" = '0f560000-0000-4000-8000-000000000002';
select lives_ok(
  $$insert into public.laundry_order_activity (tenant_id, order_id, actor_id, activity_type, note)
    values ('0f560000-0000-4000-8000-0000000000aa','0f56f000-0000-4000-8000-000000000001',
            '0f560000-0000-4000-8000-000000000002','delivered','Left with reception')$$,
  'a round can write its own job''s timeline');

set local "request.jwt.claim.sub" = '0f560000-0000-4000-8000-000000000003';
select throws_ok(
  $$insert into public.laundry_order_activity (tenant_id, order_id, actor_id, activity_type, note)
    values ('0f560000-0000-4000-8000-0000000000aa','0f56f000-0000-4000-8000-000000000001',
            '0f560000-0000-4000-8000-000000000003','delivered','Not mine')$$,
  '42501', null, 'and not another round''s');
reset role;

select is((select count(*)::int from public.laundry_order_activity
            where order_id = '0f56f000-0000-4000-8000-000000000001' and note = 'Left with reception'),
          1, 'the round''s entry really landed');

select ok(not has_function_privilege('authenticated', 'public.sync_stop_on_order_finish()', 'EXECUTE'),
          'the stop trigger is not callable as RPC');

select * from finish();
rollback;
