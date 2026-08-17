-- ============================================================================
-- 0027_xero_payments — a payment taken here shows up against the same invoice
-- in Xero.
--
-- 0026 sent the invoice. Without this the books show every invoice as
-- outstanding for ever, and somebody reconciles by hand — which is the work
-- pushing invoices was supposed to remove.
--
-- ## A payment needs a bank account, and only the laundry knows which
--
-- Xero will not accept a payment without saying which account it landed in, and
-- that is a real choice per laundry: the business account the customer paid
-- into. It is stored on the connection rather than guessed, because guessing
-- puts money against the wrong account in somebody's books and the app has no
-- way to know it got it wrong. `payment_account_code` is null until it is
-- chosen, and a payment is *skipped* rather than failed while it is — the same
-- treatment as a laundry that has not connected Xero at all (0026).
--
-- ## Idempotency
--
-- `payments.xero_payment_id` records that it landed, and the payment's own id
-- is sent as Xero's `Idempotency-Key` — so a retry after a timeout, where the
-- first attempt may actually have succeeded, cannot post the money twice. This
-- matters more than it does for invoices: a duplicated invoice is visible and
-- embarrassing, a duplicated payment quietly makes a customer look paid up.
--
-- Adds no table. Four columns, no policy change, no row touched.
-- ============================================================================

alter table public.payments
  add column if not exists xero_payment_id text,
  add column if not exists xero_pushed_at timestamptz,
  add column if not exists xero_push_error text;

comment on column public.payments.xero_payment_id is
  'The Xero PaymentID once posted. Its presence is what stops a retry posting '
  'the money a second time.';

alter table public.xero_connections
  add column if not exists payment_account_code text,
  add column if not exists payment_account_name text;

comment on column public.xero_connections.payment_account_code is
  'The Xero bank account payments are posted against. Null until chosen, and '
  'payments are skipped rather than failed while it is.';

-- The register asks "which payments have not reached Xero?" the same way it
-- asks it of invoices.
create index if not exists idx_payments_xero_pending
  on public.payments(tenant_id, paid_on)
  where xero_payment_id is null;

-- `xero_connection_status()` gains the account, so the settings screen can show
-- what was chosen without being handed a token. Replacing it drops the pinned
-- search_path and the grant posture (0011/0012), so both are restated after.
drop function if exists public.xero_connection_status(uuid);

create or replace function public.xero_connection_status(t uuid)
returns table (
  xero_tenant_name text,
  connected_at timestamptz,
  expires_at timestamptz,
  payment_account_code text,
  payment_account_name text,
  connected boolean
)
language sql stable security definer set search_path = public as $$
  select c.xero_tenant_name, c.connected_at, c.expires_at,
         c.payment_account_code, c.payment_account_name, true
    from public.xero_connections c
   where c.tenant_id = t
     and public.has_role(t, array['super_admin','operations_manager']);
$$;

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

  -- 0026's posture must survive this migration too.
  if has_table_privilege('authenticated', 'public.xero_connections', 'SELECT') then
    raise exception 'authenticated can read xero_connections' using errcode = 'P0001';
  end if;
end $chk$;
