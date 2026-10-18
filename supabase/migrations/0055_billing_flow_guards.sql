-- ============================================================================
-- 0055_billing_flow_guards — the four database halves of Darshan's BA review,
-- Phase 1 (18 October 2026)
--
-- Four small, unrelated changes, each the boundary under a screen change in the
-- same commit. One file rather than four because none of them stands alone, and
-- all four must be on the hosted project before the code that reads them merges.
--
--   1. `laundry_orders.billing_hold_reason` (brief 1.3, gap G3). A job finished
--      and priced automatically; where any of its laundry could not be priced it
--      stays `awaiting_review` and says `needs_price`, so the billing queue can
--      list exactly the jobs a person has to finish. One nullable value, cleared
--      when the job is priced in full, approved or excluded. Not a billing
--      status: the lifecycle (0017) is unchanged and the guard is not touched.
--
--   2. `guard_laundry_order_received_at` (brief 1.5, gap G14). `LJ00031` was
--      created on 17 October with a receipt of 19 October 11:35 ACDT, and nothing
--      refused it. A receipt more than fifteen minutes in the future is refused
--      on INSERT and whenever an UPDATE *changes* it — so the existing
--      future-dated rows are not re-judged by an unrelated edit (the brief: flag
--      them, don't change them). Fifteen minutes is the clock-drift allowance
--      between a counter tablet and the server. The comparison is between two
--      instants, so the timezone only matters to whoever composes the instant —
--      the app does that in Adelaide (`receivedInstant`).
--
--   3. `invoices.source` (`app` / `import`) (brief 1.2, gap G11). The MYOB
--      history was imported into Xero separately, so pushing it again would
--      double the customer's ledger there. Until now the only mark of an
--      imported invoice was a sentence in `notes`, which a person can edit. The
--      column defaults to `app`, the importer writes `import`, and the backfill
--      below marks every existing row the importer wrote — by its note, and by a
--      number outside the app's `INV` sequence, either being enough. **This is
--      the one statement in the file that changes rows**, and it only ever
--      narrows what may be pushed.
--
--   4. `save_tenant_settings` gains the `receivables` key (brief 1.9, gap G5),
--      where `ar_trusted_from` lives. Rebuilt from 0052's body — the only
--      definition, checked — with the one key added to the whitelist. Nothing
--      is written: an unset key reads as the default, 1 October 2026.
--
-- RLS: nothing new. Every table keeps its policies; the new trigger function is
-- SECURITY INVOKER (it reads no other row) and is revoked from `public, anon`
-- **and `authenticated`** anyway, so it is never on `/rest/v1/rpc/…` (the trap
-- 0019 recorded and 0036 shipped).
--
-- **Written, NOT applied to `laundrymart-syd`.** It must go on before the code
-- merges: the billing queue selects `billing_hold_reason`, the Xero gate selects
-- `invoices.source`, and Settings › Receivables calls the widened writer.
-- ============================================================================

-- --------------------------------------------- 1. a job that needs a price ----
alter table public.laundry_orders
  add column if not exists billing_hold_reason text;

alter table public.laundry_orders
  drop constraint if exists chk_laundry_orders_billing_hold_reason;
alter table public.laundry_orders
  add constraint chk_laundry_orders_billing_hold_reason
  check (billing_hold_reason is null or billing_hold_reason in ('needs_price'));

comment on column public.laundry_orders.billing_hold_reason is
  'Why a finished job is still waiting in review: needs_price when the automatic '
  'pricing at completion could not price all of its laundry (brief 1.3). Null '
  'otherwise. Advisory: the billing lifecycle is billing_status.';

create index if not exists idx_laundry_orders_billing_hold
  on public.laundry_orders (tenant_id, billing_hold_reason)
  where billing_hold_reason is not null;

-- ------------------------------------------- 2. no receipt from the future ----
create or replace function public.guard_laundry_order_received_at()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.received_at is not distinct from old.received_at then
    return new;
  end if;
  if new.received_at > now() + interval '15 minutes' then
    raise exception 'the laundry cannot have been received in the future — check the received date'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

revoke all on function public.guard_laundry_order_received_at() from public, anon, authenticated;

drop trigger if exists guard_laundry_orders_received_at on public.laundry_orders;
create trigger guard_laundry_orders_received_at
  before insert or update of received_at on public.laundry_orders
  for each row execute function public.guard_laundry_order_received_at();

-- ------------------------------------------------- 3. where an invoice came from
alter table public.invoices
  add column if not exists source text not null default 'app';

alter table public.invoices drop constraint if exists chk_invoices_source;
alter table public.invoices
  add constraint chk_invoices_source check (source in ('app', 'import'));

comment on column public.invoices.source is
  'app: raised in this application (the INV sequence) and pushable to Xero. '
  'import: brought in from MYOB, whose history was imported into Xero separately '
  '- never pushed (brief 1.2).';

-- Either mark is enough. The note is what the importer has always written; the
-- number is the backstop for a note somebody edited — the app only ever numbers
-- an invoice from its own INV sequence.
update public.invoices
   set source = 'import'
 where source <> 'import'
   and (coalesce(notes, '') ilike 'Imported from the MYOB%'
        or invoice_number !~ '^INV[0-9]+$');

-- ----------------------------------------- 4. the receivables setting key ----
create or replace function public.save_tenant_settings(t uuid, p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(t, array['super_admin']) then
    raise exception 'only the owner can change these settings' using errcode = '42501';
  end if;
  if p_key not in ('notifications', 'invoiceProfile', 'receivables') then
    raise exception 'that is not a setting this screen may change' using errcode = '22023';
  end if;
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'settings must be an object' using errcode = '22023';
  end if;
  update public.tenants
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
   where id = t;
end $$;

revoke all on function public.save_tenant_settings(uuid, text, jsonb) from public, anon;
grant execute on function public.save_tenant_settings(uuid, text, jsonb) to authenticated;

-- ------------------------------------------------------- self-assertions ----
do $$
declare n int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'laundry_orders'
                    and column_name = 'billing_hold_reason' and is_nullable = 'YES') then
    raise exception '0055: laundry_orders.billing_hold_reason is missing or not nullable';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgname = 'guard_laundry_orders_received_at'
                    and tgrelid = 'public.laundry_orders'::regclass and not tgisinternal) then
    raise exception '0055: the received-at guard is not attached';
  end if;

  if has_function_privilege('anon', 'public.guard_laundry_order_received_at()', 'execute')
     or has_function_privilege('authenticated', 'public.guard_laundry_order_received_at()', 'execute') then
    raise exception '0055: guard_laundry_order_received_at is on the RPC surface';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'invoices'
                    and column_name = 'source' and is_nullable = 'NO') then
    raise exception '0055: invoices.source is missing or nullable';
  end if;

  -- The backfill held: nothing the importer wrote is still marked as the app's.
  select count(*) into n from public.invoices
   where source = 'app'
     and (coalesce(notes, '') ilike 'Imported from the MYOB%' or invoice_number !~ '^INV[0-9]+$');
  if n <> 0 then raise exception '0055: % imported invoices are still marked app', n; end if;

  if not has_function_privilege('authenticated', 'public.save_tenant_settings(uuid, text, jsonb)', 'execute') then
    raise exception '0055: save_tenant_settings is not callable by authenticated';
  end if;
  if has_function_privilege('anon', 'public.save_tenant_settings(uuid, text, jsonb)', 'execute') then
    raise exception '0055: save_tenant_settings is callable by anon';
  end if;
  if position('receivables' in pg_get_functiondef('public.save_tenant_settings(uuid, text, jsonb)'::regprocedure)) = 0 then
    raise exception '0055: save_tenant_settings does not accept the receivables key';
  end if;
end $$;
