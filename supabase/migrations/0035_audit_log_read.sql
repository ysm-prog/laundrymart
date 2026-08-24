-- ============================================================================
-- 0035 — the activity log is for the people who answer for it
--
-- `audit_logs` has been readable by **every member of a laundry** since 0001:
-- one permissive `for all` policy whose USING half is `is_member(tenant_id)`
-- and nothing more. A driver, a board, a counter hand and the plant floor can
-- all read the whole tenant's activity trail straight off PostgREST — who did
-- what, to which record, when, with the summary attached.
--
-- It exposes no price and no amount, which is why this sat below the billing
-- work rather than beside it. But it is the one table whose entire job is to
-- say who did what, and "everybody" is the wrong audience for that.
--
-- ## The three halves, and why it is not a one-line narrowing
--
-- **SELECT** moves to the roles that hold `admin.read` in `roles.ts` — owner,
-- office manager, regional manager and auditor. The auditor matters here: a
-- read-only role whose whole purpose is to look at what happened would be
-- absurd to shut out, and it is the reason this is a role list rather than
-- `admin.write`.
--
-- **INSERT stays open to every member, and that is not an oversight.**
-- `recordAudit()` runs on the *caller's* RLS-bound client at the moment they
-- cause an event — a driver completing a delivery writes their own audit row.
-- Narrowing INSERT would not "tighten" anything; it would silently stop the
-- log recording the very people it exists to record. The `/api/notifications/
-- sweep` writer is unaffected either way: it holds no session and uses the
-- service-role client, which RLS does not apply to.
--
-- **UPDATE and DELETE go to nobody.** The old `for all` policy handed both to
-- any member, so an audit trail could be edited or erased by the person it
-- incriminates. Nothing in `src/` updates or deletes an audit row — the only
-- verbs used anywhere are `insert` and `select` — so append-only costs the
-- application nothing and is what an audit log has to be to mean anything.
--
-- ## The trap this migration exists inside
--
-- **A permissive `for all` policy's USING half grants SELECT too.** Replacing
-- only the read and leaving `audit_logs_member` in place would have left the
-- whole log readable through it, which is exactly what 0033 found one table
-- earlier on `laundry_prices` and §22 records for 0017 before that. The old
-- policy is dropped, not supplemented.
--
-- Adds no table, no column and no function. Changes no row.
-- ============================================================================

-- The single `for all` policy goes; three explicit ones replace it, so no
-- USING half is a second door onto SELECT.
drop policy if exists audit_logs_member on public.audit_logs;

-- Who may look. `has_role()` admits `platform_admin` since 0019, so the
-- deployment administrator keeps working without being named.
create policy audit_logs_read on public.audit_logs
  for select to authenticated
  using (
    (select public.is_member(tenant_id))
    and (select public.has_role(tenant_id, array[
      'super_admin', 'operations_manager', 'regional_manager', 'auditor'
    ]))
  );

-- Who may record. Everyone, about themselves, in their own laundry — that is
-- what makes the trail complete. `actor_id` is pinned to the caller so a member
-- cannot write an entry in somebody else's name.
create policy audit_logs_write on public.audit_logs
  for insert to authenticated
  with check (
    (select public.is_member(tenant_id))
    and (actor_id is null or actor_id = (select auth.uid()))
  );

-- No UPDATE and no DELETE policy at all: with RLS on, the absence of a policy
-- is the refusal. Stated here rather than left implicit because the thing being
-- relied on is a silence.

-- ------------------------------------------------- assert the outcome --------
-- Fail rather than half-apply. Two of these have been wrong in this project
-- before: a `for all` policy left in place beside a narrowed read (0033), and a
-- narrowing that took away a write the app depended on (0025 for the driver,
-- 0031 for the board).
do $$
declare
  v_count int;
begin
  -- 1. The old catch-all is gone, not merely joined.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'audit_logs'
       and policyname = 'audit_logs_member'
  ) then
    raise exception '0035: the for-all policy is still there, so SELECT is still open'
      using errcode = 'P0001';
  end if;

  -- 2. Exactly two policies, and neither is `ALL`.
  select count(*) into v_count
    from pg_policies where schemaname = 'public' and tablename = 'audit_logs';
  if v_count <> 2 then
    raise exception '0035: expected 2 policies on audit_logs, found %', v_count
      using errcode = 'P0001';
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'audit_logs' and cmd = 'ALL'
  ) then
    raise exception '0035: a for-all policy would reopen SELECT' using errcode = 'P0001';
  end if;

  -- 3. Every member can still write their own trail. This is the half that
  --    would break the application silently if it were lost.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'audit_logs'
       and cmd = 'INSERT' and with_check like '%is_member%'
  ) then
    raise exception '0035: members can no longer record their own actions'
      using errcode = 'P0001';
  end if;

  -- 4. Append-only.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'audit_logs'
       and cmd in ('UPDATE', 'DELETE')
  ) then
    raise exception '0035: the audit trail is editable' using errcode = 'P0001';
  end if;

  -- 5. RLS is what makes the missing policies a refusal.
  if not exists (
    select 1 from pg_class
     where oid = 'public.audit_logs'::regclass and relrowsecurity
  ) then
    raise exception '0035: RLS is off on audit_logs' using errcode = 'P0001';
  end if;
end $$;
