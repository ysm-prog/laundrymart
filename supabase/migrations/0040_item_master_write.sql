-- ============================================================================
-- 0040_item_master_write — the item master is the Owner's and the Office
-- manager's, and the database says so.
--
-- `items` has carried `apply_tenant_policy` since 0002, which is a single
-- permissive `for all … using is_member(tenant_id)` policy. `roles.ts` gates the
-- *screens* on `items.write`; nothing gated the table. So every member of a
-- laundry could rewrite the item master straight off `/rest/v1/items` — a
-- driver, the counter, the plant floor, and since 0031 a delivery round.
--
-- **Proved as one of Adelaide's own `board` logins on 2026-08-26**, in a
-- transaction that was then aborted: it read all **254** items, **renamed**
-- `TW` — the code that laundry bills at $0.22 — to a string of its own choosing,
-- **inserted** an item nobody had approved, and **deleted** one. `laundry_prices`
-- correctly returned 0 to the same session throughout, which is 0033's gate
-- holding, so this is `items` specifically and not a session that was over-privileged.
--
-- It matters more now than it did last week. Until 2026-08-26 this table held
-- **six** demo rows and Adelaide held none, so there was nothing to steal and
-- nothing to break; it now holds that laundry's whole 254-line master list, and
-- every job, price tier, charge, invoice line and report resolves through it.
-- **An empty table is not a proof** — the third time this file has had to write
-- that sentence.
--
-- **This is the same shape, for the fourth time**: 0006 on `invoices` (replaced
-- by 0017), 0018 on `laundry_prices` (replaced by 0033), 0021 on the six payable
-- tables (replaced by 0036). The `for all` is **dropped rather than
-- supplemented**, because its USING half grants SELECT as well — a narrower
-- write policy beside it would leave the old one as a second door onto the same
-- rows, which is exactly the trap 0033 records.
--
-- **SELECT stays open to every member, deliberately.** A board reads item names
-- off its run sheet, the plant runs batches keyed on them, the counter picks
-- them into a job, and the pricer resolves a rate through them. Narrowing the
-- read would empty My Runs and the warehouse for the roles that live there —
-- and an item name is not a price. What moved is who may *change* it, which is
-- the same line 0025 drew on the job tables and for the same reason.
--
-- Adds no table, no column and no trigger; drops nothing but the policy it
-- replaces, and changes no row.
-- ============================================================================

-- ------------------------------------------------------------- the gate -----
-- The database's copy of `roles.ts`, the way `can_write_run_sequence()` is
-- 0036's copy of `routes.sequence`. Two roles, named rather than derived: the
-- client's rule is that the master list is maintained by the Owner and the
-- Office manager, and a capability that is merely *not mentioned* is a
-- capability the `TENANT_ALL`-derived roles quietly hold.
--
-- Deliberately **not** built on `can_write_purchases()` or `can_read_billing()`.
-- The item master is neither the payable side nor the ledger; overloading one of
-- those would tie three unrelated decisions to one role list, and the next
-- change to either would move this without anybody deciding to.
create or replace function public.can_write_items(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array['super_admin','operations_manager']);
$$;

comment on function public.can_write_items(uuid) is
  'Who may change the item master. The Owner and the Office manager, matching '
  '`items.write` in roles.ts — read stays open to every member, because a board, '
  'the plant and the counter all have to name an item to do their work.';

-- **Postgres grants EXECUTE on a new function to PUBLIC, and that is not
-- something 0011 or 0029 can pre-empt for a function written later.** Both of
-- those alter *default privileges*, which are applied on top of the built-in
-- PUBLIC grant rather than instead of it — so a helper created here arrives
-- callable by `anon` at `/rest/v1/rpc/can_write_items` unless it is revoked by
-- name. Caught by this migration's own sixth assertion, which is why that
-- assertion exists: 0036 revokes its two helpers exactly this way, and the
-- pattern is copied rather than re-derived. `authenticated` keeps EXECUTE
-- deliberately — every policy above calls this as the signed-in caller, and the
-- function is internally scoped to `auth.uid()` through `has_role`, so it can
-- only ever answer a question about the person asking.
revoke all on function public.can_write_items(uuid) from public, anon;
grant execute on function public.can_write_items(uuid) to authenticated, service_role;

-- ------------------------------------------------------------ the policies --
drop policy if exists items_member on public.items;

create policy items_read on public.items
  for select to authenticated
  using ((select public.is_member(tenant_id)));

-- Split from one `for all`, so no USING half is a second door onto SELECT.
create policy items_insert on public.items
  for insert to authenticated
  with check ((select public.can_write_items(tenant_id)));

create policy items_update on public.items
  for update to authenticated
  using ((select public.can_write_items(tenant_id)))
  with check ((select public.can_write_items(tenant_id)));

create policy items_delete on public.items
  for delete to authenticated
  using ((select public.can_write_items(tenant_id)));

-- ====================================================== assert the outcome ==
do $$
declare n int;
begin
  -- 1. The permissive `for all` is gone, not merely supplemented. This is the
  --    whole point: leaving it would keep the write open through its USING half.
  if exists (select 1 from pg_policy
             where polrelid = 'public.items'::regclass and polname = 'items_member') then
    raise exception '0040: items_member survived — the for-all write door is still open';
  end if;

  select count(*) into n from pg_policy
   where polrelid = 'public.items'::regclass and polcmd = '*';
  if n <> 0 then
    raise exception '0040: % permissive for-all policy/policies remain on items', n;
  end if;

  -- 2. All four replacements are attached, one verb each.
  select count(*) into n from pg_policy
   where polrelid = 'public.items'::regclass
     and polname in ('items_read','items_insert','items_update','items_delete');
  if n <> 4 then
    raise exception '0040: % of the 4 replacement policies on items', n;
  end if;

  -- 3. RLS is still on. A table with policies and RLS off is a table with no
  --    policies, and it fails silently in exactly the direction that hurts.
  if not (select relrowsecurity from pg_class where oid = 'public.items'::regclass) then
    raise exception '0040: row level security is not enabled on items';
  end if;

  -- 4. The gate names two roles and **not** the ones that would make this
  --    cosmetic. Checked against the function body rather than trusted, because
  --    the failure this prevents is a policy that reads correctly and admits
  --    everybody.
  if pg_get_functiondef('public.can_write_items(uuid)'::regprocedure) not like '%super_admin%'
     or pg_get_functiondef('public.can_write_items(uuid)'::regprocedure) not like '%operations_manager%' then
    raise exception '0040: can_write_items does not name the Owner and the Office manager';
  end if;
  if pg_get_functiondef('public.can_write_items(uuid)'::regprocedure) like '%dispatcher%'
     or pg_get_functiondef('public.can_write_items(uuid)'::regprocedure) like '%warehouse_operator%'
     or pg_get_functiondef('public.can_write_items(uuid)'::regprocedure) like '%board%' then
    raise exception '0040: can_write_items names a role the client did not';
  end if;

  -- 5. The read is still every member's. Narrowing it here would be a silent
  --    outage on My Runs and the plant, so it is asserted rather than assumed.
  if (select pg_get_expr(polqual, polrelid) from pg_policy
       where polrelid = 'public.items'::regclass and polname = 'items_read')
     not like '%is_member%' then
    raise exception '0040: the items read policy is no longer open to every member';
  end if;

  -- 6. 0029's posture, which every migration since has had to keep.
  if has_function_privilege('anon', 'public.can_write_items(uuid)', 'execute') then
    raise exception '0040: anon can execute can_write_items';
  end if;
end $$;
