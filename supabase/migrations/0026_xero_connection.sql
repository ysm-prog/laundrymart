-- ============================================================================
-- 0026_xero_connection — each laundry connects its own Xero, and an issued
-- invoice carries where it landed.
--
-- The owner's decision: billing runs on the pre-agreed rate for each service
-- per client (which `service_agreement_lines` and `laundry_prices` already
-- hold), the Owner raises one invoice a month for the work completed in it
-- (which `generateInvoices` already does), and the invoice is pushed to Xero
-- the way `ysm-prog/ysm-hub` does it.
--
-- ## One Xero organisation per laundry
--
-- `xero_connections` is keyed on `tenant_id`, not global. This deployment
-- already runs two laundries and is built to run more, and every other table in
-- the schema is tenant-scoped — a single deployment-wide connection would work
-- exactly until a second real business arrived, then silently post one
-- laundry's receivables into another's books.
--
-- ## The tokens are credentials, so nobody signed in can read them
--
-- This is the first table in the schema that `authenticated` may not touch at
-- all. RLS is enabled, its only policy denies everything outright, and the
-- table grants are revoked too: a refresh token is a bearer credential for
-- somebody's accounting system, and there is no screen that needs its value.
-- Only the service-role client — used by the OAuth callback and the push, both
-- server-side — can read or write a row.
--
-- That leaves the Settings screen needing to say "connected to Adelaide Towel
-- Service, expires Tuesday" without being handed a token, which is what
-- `xero_connection_status()` is for: SECURITY DEFINER, membership- and
-- role-checked inside, and it returns the organisation name and the timestamps
-- and **never the tokens**. The same shape 0017 used for
-- `archived_record_counts()` — a definer function is the only way to answer a
-- question about rows the caller may not read.
--
-- ## What the invoice carries
--
-- `xero_invoice_id` is the record that a push succeeded and the idempotency
-- key: a second push updates that invoice rather than creating a duplicate.
-- `xero_pushed_at` and `xero_push_error` are what let the register show a
-- failed push and offer to try again, so a Xero outage never blocks issuing an
-- invoice — the money record is this database's, and Xero is a copy of it.
-- ============================================================================

-- ------------------------------------------------------- the connection -----
create table if not exists public.xero_connections (
  -- One per laundry. The primary key IS the tenant, so a second connection for
  -- the same laundry cannot exist to be ambiguous about.
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  -- Xero's own organisation identifier and its name, for the screen.
  xero_tenant_id text not null,
  xero_tenant_name text,
  access_token text not null,
  refresh_token text not null,
  -- When the access token dies. The refresh happens on read, before use.
  expires_at timestamptz not null,
  connected_at timestamptz not null default now(),
  connected_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);

comment on table public.xero_connections is
  'OAuth tokens for one laundry''s Xero organisation. Readable only by the '
  'service role — see 0026. Use xero_connection_status() from a screen.';

alter table public.xero_connections enable row level security;

-- The denial is written down rather than left to the absence of a policy.
--
-- RLS with no policy at all already denies everything, and that is what this
-- table wants — but `rls_coverage` asserts that every table carrying a
-- `tenant_id` has a policy, and it is right to: "no policy" and "somebody
-- forgot the policy" look identical in the catalogue. Saying `false` out loud
-- states the intent, survives a future grant being restored by accident, and
-- keeps the coverage proof meaningful for every other table.
create policy xero_connections_no_access on public.xero_connections
  for all to authenticated
  using (false) with check (false);
create trigger set_xero_connections_updated_at
  before update on public.xero_connections
  for each row execute procedure public.set_updated_at();

-- `authenticated` is granted nothing at all — not even SELECT. Supabase's
-- default privileges would otherwise hand it SELECT on a new public table, and
-- while RLS would still refuse every row, a table of refresh tokens should not
-- be one policy edit away from being readable.
revoke all on public.xero_connections from authenticated, anon;
grant all on public.xero_connections to service_role;

-- ------------------------------------------------- what a screen may see ----
-- The connection minus the secrets. Membership-checked inside, so it answers
-- only about the caller's own laundry however it is called.
create or replace function public.xero_connection_status(t uuid)
returns table (
  xero_tenant_name text,
  connected_at timestamptz,
  expires_at timestamptz,
  connected boolean
)
language sql stable security definer set search_path = public as $$
  select c.xero_tenant_name, c.connected_at, c.expires_at, true
    from public.xero_connections c
   where c.tenant_id = t
     and public.has_role(t, array['super_admin','operations_manager']);
$$;

-- ----------------------------------------------------- on the invoice -------
alter table public.invoices
  add column if not exists xero_invoice_id text,
  add column if not exists xero_pushed_at timestamptz,
  add column if not exists xero_push_error text;

comment on column public.invoices.xero_invoice_id is
  'The Xero InvoiceID once pushed. Also the idempotency key: a re-push updates '
  'that invoice rather than creating a second one.';

-- Finding the invoices that still need to reach Xero is the query the register
-- runs; partial, because the ones that made it are the overwhelming majority.
create index if not exists idx_invoices_xero_pending
  on public.invoices(tenant_id, issued_at)
  where xero_invoice_id is null and issued_at is not null;

-- ---------------------------------------------------- the customer link -----
-- Already present on the hosted project, added by the unmerged
-- `claude/customer-pricing-invoicing-sad9af` branch (§11). Added here `if not
-- exists` so the repo finally describes production, and so a fresh database
-- gets them too. Nothing else from that branch is adopted — see §19.
alter table public.customers
  add column if not exists xero_contact_id text,
  add column if not exists xero_contact_name text;

comment on column public.customers.xero_contact_id is
  'The Xero ContactID this customer maps to. Filled on the first successful '
  'push, so a customer is created in Xero once and matched thereafter.';

-- ------------------------------------------------------------- grants -------
-- 0011: the implicit PUBLIC grant returns with every new function.
revoke execute on function public.xero_connection_status(uuid) from public, anon;
grant execute on function public.xero_connection_status(uuid) to authenticated, service_role;

do $chk$
declare v_leaked text;
begin
  select string_agg(p.proname, ', ') into v_leaked
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_leaked is not null then
    raise exception 'anon can still execute: %', v_leaked using errcode = 'P0001';
  end if;

  if has_table_privilege('authenticated', 'public.xero_connections', 'SELECT') then
    raise exception 'authenticated can read xero_connections' using errcode = 'P0001';
  end if;
end $chk$;
