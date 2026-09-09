-- ============================================================================
-- 0048_customer_record_write — a customer's record is changed by the office.
--
-- **The fifth table family on the shape this schema has already replaced four
-- times** (0006→0017 on `invoices`, 0018→0033 on `laundry_prices`, 0021→0036 on
-- the six payable tables, 0002→0040 on `items`). `customers`,
-- `customer_locations` and `customer_contacts` came out of 0002's
-- `apply_tenant_policy`, so each carried a single permissive
-- `for all … using is_member(tenant_id)` policy — and a permissive `for all`
-- policy's USING half grants the writes as well as SELECT.
--
-- **Probed as one of Adelaide's own `board` logins on 2026-09-09**, in a
-- transaction that was then aborted. A delivery round — holding no
-- `customers.*` capability whatever — renamed a customer (1 row), set its
-- collection day (1 row), rewrote a site's address *and* its `access_notes`
-- (1 row), **deleted that site outright** (1 row), and **rewrote all 471 customer
-- contact emails in one statement**. Every one of those is a plain PATCH or
-- DELETE against `/rest/v1/…`; `roles.ts` gates the screens and gated nothing
-- else. The address and the access notes are the sharper half of it: those are
-- what tell the van which door to use, so this was not only a disclosure — it
-- was a way to silently misdirect a delivery.
--
-- **Nothing in the app is losing an ability it could reach.** Every writer of
-- these three tables in `src/` is gated on `customers.write` already —
-- `createCustomer`, `updateCustomer`, `archiveCustomer`, `addLocation`,
-- `addContact` — with two that arrive by another door and are checked below.
--
-- **The read splits three ways, and each is decided by who actually reads it**
-- rather than by symmetry:
--
--   `customers`           SELECT open — every run screen embeds the business
--                         name, the phone and the standing instructions.
--   `customer_locations`  SELECT open — `/run`, `/my-runs` and the run
--                         sequencer read the address and `access_notes`. A
--                         round that cannot read this has no idea where to go.
--   `customer_contacts`   SELECT **narrowed** to `can_read_customers()`. Exactly
--                         one screen reads it (`/customers/[id]`), gated on
--                         `customers.read` — so no round-facing screen loses a
--                         thing, and the 471-email read above is closed.
--
-- Taking the read away from a round is the failure this project has shipped
-- once already (the driver with no `drivers` row, 2026-08-17): a login that
-- works and shows nothing reads as a broken app rather than as a refusal. So
-- the two tables a van needs stay readable and only the writes move.
--
-- **The archive clause is carried into every new policy** — all three tables are
-- in `archivable_tables()`, so dropping 0017's wrapped policy and writing a
-- plain one would make an archived customer readable again. That is the 0028
-- trap, and it is what this file's assertions check hardest. `with check` keeps
-- it too, which is what continues to make `set_records_archived()` — SECURITY
-- DEFINER, and therefore outside RLS — the only way to archive or restore.
--
-- Adds no table, no column and no capability; changes no row.
-- ============================================================================

-- ----------------------------------------------------- 1. the two gates ---
-- Named against `roles.ts` rather than derived from another helper, because §3
-- keeps these sets independent: `customers.read` reaches the auditor and finance,
-- who may look a customer up and have no business editing one.
create or replace function public.can_read_customers(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array['super_admin','operations_manager','dispatcher',
                                  'finance','customer_service','sales',
                                  'branch_manager','regional_manager','auditor']);
$$;

comment on function public.can_read_customers(uuid) is
  'Who may look a customer up — `customers.read` in roles.ts. Used only for
   `customer_contacts`: the parent and its sites stay readable to every member,
   because a delivery round reads the name, the phone, the address and the
   access notes off its own run sheet.';

-- **`customers.write` is the whole write set, and that was measured rather than
-- assumed.** Two writers arrive by a door other than the customer form and both
-- turn out to be inside it: `updateCustomerBilling` is `billing.write`, and the
-- Xero push writes `customers.xero_contact_id` **on the caller's own client**
-- under `invoices.write`. Both of those capabilities are held by
-- `super_admin` and `operations_manager` alone — a strict subset of this list —
-- so neither needs a wider gate. `roles.test.ts` pins that containment, because
-- if the sets ever part company the Xero push stops remembering the contact by
-- writing **zero rows in silence**, and the next invoice makes a twin.
create or replace function public.can_write_customers(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(t, array['super_admin','operations_manager','dispatcher',
                                  'customer_service','sales',
                                  'branch_manager','regional_manager']);
$$;

comment on function public.can_write_customers(uuid) is
  'Who may change a customer''s record — `customers.write` in roles.ts, covering
   the customer, their sites and their contacts. A driver, a board, the plant
   floor, finance and the auditor are all outside it. Before 0048 every member
   of the laundry could rename a customer, rewrite the access notes that say
   which door to use, and delete a site.';

-- Postgres grants EXECUTE on a new function to PUBLIC as a *built-in* default,
-- which `alter default privileges` (0011, 0029) is applied on top of rather than
-- instead of — so a helper arrives callable by `anon` at /rest/v1/rpc/… unless
-- it is revoked by name. The trap 0040's sixth assertion caught.
-- `authenticated` deliberately keeps EXECUTE: every policy below calls these as
-- the signed-in caller, and each is internally scoped to `auth.uid()` through
-- `has_role`, so it can only ever answer a question about the person asking.
revoke all on function public.can_read_customers(uuid) from public, anon;
revoke all on function public.can_write_customers(uuid) from public, anon;
grant execute on function public.can_read_customers(uuid) to authenticated, service_role;
grant execute on function public.can_write_customers(uuid) to authenticated, service_role;

-- ------------------------------------------------------- 2. the customer ---
-- Dropped rather than supplemented: leaving 0002's `for all` beside a narrower
-- write policy would leave it as a second door onto every verb, which is the
-- 0033 trap and the reason all four predecessors replaced rather than added.
drop policy if exists customers_member on public.customers;

create policy customers_read on public.customers
  for select to authenticated
  using ((select public.is_member(tenant_id)) and archived_at is null);

create policy customers_insert on public.customers
  for insert to authenticated
  with check ((select public.can_write_customers(tenant_id)) and archived_at is null);

create policy customers_update on public.customers
  for update to authenticated
  using ((select public.can_write_customers(tenant_id)) and archived_at is null)
  with check ((select public.can_write_customers(tenant_id)) and archived_at is null);

create policy customers_delete on public.customers
  for delete to authenticated
  using ((select public.can_write_customers(tenant_id)) and archived_at is null);

-- ---------------------------------------------------------- 3. the sites ---
-- SELECT stays open: this is the address the van drives to and the note saying
-- which door to use, read by `/run`, `/my-runs` and the run sequencer.
drop policy if exists customer_locations_member on public.customer_locations;

create policy customer_locations_read on public.customer_locations
  for select to authenticated
  using ((select public.is_member(tenant_id)) and archived_at is null);

create policy customer_locations_insert on public.customer_locations
  for insert to authenticated
  with check ((select public.can_write_customers(tenant_id)) and archived_at is null);

create policy customer_locations_update on public.customer_locations
  for update to authenticated
  using ((select public.can_write_customers(tenant_id)) and archived_at is null)
  with check ((select public.can_write_customers(tenant_id)) and archived_at is null);

create policy customer_locations_delete on public.customer_locations
  for delete to authenticated
  using ((select public.can_write_customers(tenant_id)) and archived_at is null);

-- ------------------------------------------------------- 4. the contacts ---
-- The one table here whose *read* narrows, because the one screen that reads it
-- is already gated on `customers.read` and no round-facing screen touches it.
drop policy if exists customer_contacts_member on public.customer_contacts;

create policy customer_contacts_read on public.customer_contacts
  for select to authenticated
  using ((select public.can_read_customers(tenant_id)) and archived_at is null);

create policy customer_contacts_insert on public.customer_contacts
  for insert to authenticated
  with check ((select public.can_write_customers(tenant_id)) and archived_at is null);

create policy customer_contacts_update on public.customer_contacts
  for update to authenticated
  using ((select public.can_write_customers(tenant_id)) and archived_at is null)
  with check ((select public.can_write_customers(tenant_id)) and archived_at is null);

create policy customer_contacts_delete on public.customer_contacts
  for delete to authenticated
  using ((select public.can_write_customers(tenant_id)) and archived_at is null);

-- ====================================================== assert the outcome ==
-- Self-asserting, so a partial apply fails rather than half-landing.
do $$
declare
  v int;
  t text;
  v_missing text[] := '{}';
begin
  foreach t in array array['customers','customer_locations','customer_contacts'] loop
    -- 1. The permissive `for all` is gone — not merely outvoted by a narrower
    --    policy beside it, which would leave every verb reachable through it.
    select count(*) into v from pg_policies
     where schemaname = 'public' and tablename = t and cmd = 'ALL';
    if v <> 0 then
      v_missing := v_missing || format('a permissive for-all policy is still on %s', t);
    end if;

    -- 2. Four policies, one verb each.
    select count(*) into v from pg_policies
     where schemaname = 'public' and tablename = t;
    if v <> 4 then
      v_missing := v_missing || format('expected 4 policies on %s, found %s', t, v);
    end if;

    -- 3. **The 0028 trap.** All three tables are in `archivable_tables()`, so a
    --    policy written here without 0017's clause makes an archived customer
    --    readable again. `ilike`, because `pg_get_expr` renders it as
    --    `archived_at IS NULL` — the defect 0047's own assertions caught.
    select count(*) into v from pg_policies
     where schemaname = 'public' and tablename = t
       and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ilike '%archived_at is null%';
    if v <> 4 then
      v_missing := v_missing || format(
        'only %s of 4 policies on %s carry archived_at is null', v, t);
    end if;

    -- 4. Every write verb names the gate. Asked of the policy text rather than
    --    the count, so a policy that merely exists under the right name but
    --    checks something else is caught.
    select count(*) into v from pg_policies
     where schemaname = 'public' and tablename = t and cmd in ('INSERT','UPDATE','DELETE')
       and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%can_write_customers%';
    if v <> 3 then
      v_missing := v_missing || format(
        'only %s of 3 write policies on %s are gated on can_write_customers', v, t);
    end if;

    select count(*) into v from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t and c.relrowsecurity;
    if v <> 1 then v_missing := v_missing || format('RLS is off on %s', t); end if;

    -- 5. 0029's posture: `anon` holds nothing on any of them.
    select count(*) into v from information_schema.role_table_grants
     where table_schema = 'public' and table_name = t and grantee = 'anon';
    if v <> 0 then v_missing := v_missing || format('anon holds %s grants on %s', v, t); end if;
  end loop;

  -- 6. The two tables a van reads are still readable to every member. Asserted
  --    by *name* rather than by counting, because the failure it guards is
  --    silent: a round whose run sheet has no address is a working login with
  --    an empty screen, which reads as a broken app.
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename in ('customers','customer_locations')
     and cmd = 'SELECT' and coalesce(qual, '') like '%is_member%';
  if v <> 2 then
    v_missing := v_missing || format('expected the run sheet''s 2 open reads, found %s', v);
  end if;

  -- 7. And the contacts read really did narrow, or the 471-email disclosure is
  --    still open.
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'customer_contacts'
     and cmd = 'SELECT' and coalesce(qual, '') like '%can_read_customers%';
  if v <> 1 then v_missing := v_missing || 'the customer_contacts read is not gated'::text; end if;

  -- 8. Neither helper is on the RPC surface for a signed-out caller.
  if has_function_privilege('anon', 'public.can_read_customers(uuid)', 'execute')
     or has_function_privilege('anon', 'public.can_write_customers(uuid)', 'execute') then
    v_missing := v_missing || 'a customers helper is callable by anon'::text;
  end if;

  -- 9. …and both *are* callable by a signed-in one, or every policy above
  --    evaluates to an error and the whole customer module stops working.
  if not has_function_privilege('authenticated', 'public.can_read_customers(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.can_write_customers(uuid)', 'execute') then
    v_missing := v_missing || 'a customers helper is not callable by authenticated'::text;
  end if;

  -- 10. The gate is the office, and the four roles it must exclude are excluded.
  --     Stated as an outcome rather than by re-reading the array, so a later
  --     edit to the role list fails here rather than shipping.
  if public.can_write_customers(null) then
    v_missing := v_missing || 'can_write_customers answers true with no tenant'::text;
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception '0048 did not apply cleanly: %', array_to_string(v_missing, '; ');
  end if;
end $$;
