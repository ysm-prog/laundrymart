-- 0033 · A price list is a finance record, and its READ half never said so.
--
-- 0018 gated who may *change* `laundry_prices` — four roles — and left the read
-- policy at `is_member(tenant_id)`, so every member of the laundry could read
-- every price. That is the identical shape 0006 shipped on `invoices` and that
-- 0017 replaced for exactly this reason: since My Runs gave operational logins a
-- session, "any member" includes a driver, and since 0031 it includes a board.
-- CLAUDE.md §3 has claimed since 0018 that this table is "role-gated the same
-- way"; it was true of writes and false of reads.
--
-- It went unnoticed because the table was empty on every deployment until the
-- day a price list was actually entered. Found by probing every table in
-- `public` as a real `board` session, which is the only way it shows up.
--
-- Two policies, not one, and the second is the half that is easy to miss:
--
--   **A `for all` policy's USING half grants SELECT too.** Narrowing only
--   `laundry_prices_read` would have left the whole list readable through
--   `laundry_prices_write` to `dispatcher`, who holds no pricing capability at
--   all. The same trap §22 records for 0017, one table later. So the `for all`
--   policy is replaced by explicit INSERT/UPDATE/DELETE policies, none of which
--   has a USING half that SELECT can travel through.
--
-- The write set is unchanged in substance: 0025's *restrictive* layer already
-- ANDs `super_admin`/`operations_manager` on top of whatever is here, so this
-- narrows nobody's ability to write that they had yesterday. `dispatcher` loses
-- a read they should never have had and a write 0025 already refused.
--
-- Adds no table, no column, no function and no capability, and changes no row.
-- `laundry_prices` is not in `archivable_tables()` (a price list is
-- configuration, not a customer's paperwork), so there is no `archived_at`
-- clause to preserve — the 0028 trap does not apply here.

-- --------------------------------------------------------------- the read ---
drop policy if exists laundry_prices_read on public.laundry_prices;

create policy laundry_prices_read on public.laundry_prices
  for select to authenticated
  using ((select public.can_read_pricing(tenant_id)));

-- -------------------------------------------------------------- the writes --
-- Split from one `for all`, so no USING half is a second door onto SELECT.
drop policy if exists laundry_prices_write on public.laundry_prices;

create policy laundry_prices_insert on public.laundry_prices
  for insert to authenticated
  with check ((select public.has_role(tenant_id,
    array['super_admin','operations_manager','finance','dispatcher'])));

create policy laundry_prices_update on public.laundry_prices
  for update to authenticated
  using ((select public.has_role(tenant_id,
    array['super_admin','operations_manager','finance','dispatcher'])))
  with check ((select public.has_role(tenant_id,
    array['super_admin','operations_manager','finance','dispatcher'])));

create policy laundry_prices_delete on public.laundry_prices
  for delete to authenticated
  using ((select public.has_role(tenant_id,
    array['super_admin','operations_manager','finance','dispatcher'])));

-- ------------------------------------------------------ assert the outcome --
-- Self-asserting, so a partial apply fails rather than half-landing. Both
-- halves are checked: the read is narrowed, and no SELECT-capable policy is
-- left with a wider expression behind it.
do $$
declare
  v_read_expr text;
  v_for_all int;
begin
  select pg_get_expr(polqual, polrelid) into v_read_expr
    from pg_policy where polrelid = 'public.laundry_prices'::regclass
      and polname = 'laundry_prices_read';

  if v_read_expr is null or v_read_expr not like '%can_read_pricing%' then
    raise exception '0033: laundry_prices_read is not gated on can_read_pricing (got %)', v_read_expr;
  end if;

  select count(*) into v_for_all
    from pg_policy where polrelid = 'public.laundry_prices'::regclass
      and polcmd = '*' and polpermissive;

  if v_for_all <> 0 then
    raise exception '0033: a permissive `for all` policy still stands on laundry_prices, '
      'so its USING half grants SELECT past the read gate';
  end if;
end $$;
