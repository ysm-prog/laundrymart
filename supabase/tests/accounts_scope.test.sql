-- Proof: the chart of accounts is the bookkeepers', and only theirs.
--
-- `0021` attached `apply_tenant_policy` to `gl_accounts`, which is one
-- permissive `for all` policy carrying nothing but `is_member(tenant_id)`. So
-- until 0037 **every member of the laundry could read and rewrite the chart of
-- accounts** straight off `/rest/v1/gl_accounts` — a driver, the counter, the
-- plant floor. That is not a cosmetic list: `current_balance` is on this table,
-- so an open read is every account balance in the business.
--
-- Two shapes of assertion, deliberately, because the two verbs fail in
-- different ways and only one of them is loud:
--
--   * a refused **INSERT/UPDATE with check** raises 42501, so `throws_ok` is
--     the right assertion;
--   * a refused **SELECT or UPDATE ... where** is simply zero rows, which is
--     the silence this project has shipped twice — so those are asserted by
--     *outcome*, counted afterwards from a session that can see the rows.
--
-- And the half that a policy passing every "cannot" test still gets wrong: the
-- people who are supposed to keep the chart really can add to it.
begin;
select plan(19);

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-0000000000a1','owner@example.com'),
  ('a0000000-0000-4000-8000-0000000000f1','finance@example.com'),
  ('a0000000-0000-4000-8000-0000000000a2','auditor@example.com'),
  ('a0000000-0000-4000-8000-0000000000d1','driver@example.com'),
  ('a0000000-0000-4000-8000-0000000000c1','counter@example.com'),
  ('a0000000-0000-4000-8000-0000000000e1','other@example.com');

insert into public.tenants (id, name) values
  ('aa000000-0000-4000-8000-000000000001','Ours'),
  ('ab000000-0000-4000-8000-000000000002','Theirs');

insert into public.memberships (user_id, tenant_id, role) values
  ('a0000000-0000-4000-8000-0000000000a1','aa000000-0000-4000-8000-000000000001','super_admin'),
  ('a0000000-0000-4000-8000-0000000000f1','aa000000-0000-4000-8000-000000000001','finance'),
  ('a0000000-0000-4000-8000-0000000000a2','aa000000-0000-4000-8000-000000000001','auditor'),
  ('a0000000-0000-4000-8000-0000000000d1','aa000000-0000-4000-8000-000000000001','driver'),
  ('a0000000-0000-4000-8000-0000000000c1','aa000000-0000-4000-8000-000000000001','customer_service'),
  ('a0000000-0000-4000-8000-0000000000e1','ab000000-0000-4000-8000-000000000002','super_admin');

insert into public.gl_accounts (id, tenant_id, code, name, account_type, current_balance) values
  ('ac000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000001',
   '200','Laundry income','Income', 48250.00),
  ('ac000000-0000-4000-8000-0000000000f2','ab000000-0000-4000-8000-000000000002',
   '200','Their income','Income', 999.00);

-- ------------------------------------------------------- the policy shape ---
select is((select count(*)::int from pg_policy
            where polrelid = 'public.gl_accounts'::regclass), 4,
          'gl_accounts carries four explicit policies');
select is((select count(*)::int from pg_policy
            where polrelid = 'public.gl_accounts'::regclass and polcmd = '*'), 0,
          'and no `for all` policy, whose USING half would be a second door onto SELECT');

set local role authenticated;

-- ================================================= the bookkeepers can work ==
set local "request.jwt.claim.sub" = 'a0000000-0000-4000-8000-0000000000a1';
select ok(public.can_read_accounts('aa000000-0000-4000-8000-000000000001'),
          'the owner may read the chart');
select ok(public.can_write_accounts('aa000000-0000-4000-8000-000000000001'),
          'the owner may change the chart');
select lives_ok(
  $$insert into public.gl_accounts (tenant_id, code, name, account_type, xero_account_code)
    values ('aa000000-0000-4000-8000-000000000001','260','Linen hire','Income','260')$$,
  'the owner can add an account');
-- Counted rather than trusted to `lives_ok`: a write that succeeds and touches
-- nothing is the exact failure 0025 and 0031 shipped.
select is((select count(*)::int from public.gl_accounts where code = '260'), 1,
          'and the account is really there');
select lives_ok(
  $$update public.gl_accounts set xero_account_code = '201' where code = '200'$$,
  'the owner can code an account to Xero');
select is((select xero_account_code from public.gl_accounts where code = '200'), '201',
          'and the Xero code is really stored');

set local "request.jwt.claim.sub" = 'a0000000-0000-4000-8000-0000000000f1';
select lives_ok(
  $$insert into public.gl_accounts (tenant_id, code, name, account_type)
    values ('aa000000-0000-4000-8000-000000000001','300','Delivery income','Income')$$,
  'finance can add an account, which is the role''s whole job');
select is((select count(*)::int from public.gl_accounts where code = '300'), 1,
          'and that one landed too');

-- ===================================================== read, but not write ==
set local "request.jwt.claim.sub" = 'a0000000-0000-4000-8000-0000000000a2';
-- Three: the seeded 200, plus the 260 and 300 the two writers above added. The
-- other laundry's is invisible, which is the tenancy boundary still holding
-- underneath the new role gate.
select is((select count(*)::int from public.gl_accounts), 3,
          'an auditor reads the whole of their own chart');
select throws_ok(
  $$insert into public.gl_accounts (tenant_id, code, name, account_type)
    values ('aa000000-0000-4000-8000-000000000001','999','Sneaky','Income')$$,
  '42501', null,
  'an auditor cannot add one — read and never touch is the whole of that role');

-- ============================================== and the rest see nothing ====
-- The balances are the point. Each of these could read *and rewrite* the chart
-- before 0037.
set local "request.jwt.claim.sub" = 'a0000000-0000-4000-8000-0000000000d1';
select is((select count(*)::int from public.gl_accounts), 0,
          'a driver cannot read the chart of accounts');
select throws_ok(
  $$insert into public.gl_accounts (tenant_id, code, name, account_type)
    values ('aa000000-0000-4000-8000-000000000001','998','Driver','Income')$$,
  '42501', null,
  'nor add to it');

set local "request.jwt.claim.sub" = 'a0000000-0000-4000-8000-0000000000c1';
select is((select count(*)::int from public.gl_accounts), 0,
          'the counter cannot read the chart of accounts');
select lives_ok(
  $$update public.gl_accounts set name = 'Rewritten' where code = '200'$$,
  'the counter''s update is filtered to nothing rather than raising');

-- ============================================================== tenancy =====
set local "request.jwt.claim.sub" = 'a0000000-0000-4000-8000-0000000000e1';
select is((select count(*)::int from public.gl_accounts), 1,
          'another laundry''s owner sees only their own chart');
select lives_ok(
  $$update public.gl_accounts set name = 'Theirs now' where code = '260'$$,
  'and their update of ours matches nothing');

-- Read back as somebody who can see the rows: the two silent refusals above
-- have to be proved by what did *not* change.
set local "request.jwt.claim.sub" = 'a0000000-0000-4000-8000-0000000000a1';
select is((select name from public.gl_accounts where code = '200'), 'Laundry income',
          'neither the counter nor another laundry changed a thing');

select * from finish();
rollback;
