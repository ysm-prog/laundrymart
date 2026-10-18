-- ============================================================================
-- 0053_tax_invoice_issue_guard — a draft becomes a tax invoice only when the
-- laundry's invoice details are complete
--
-- From Darshan's BA review of 18 October 2026 (brief 1.1, gap G1). INV00008 was
-- issued and its PDF printed "TAX INVOICE" with no ABN, no business address and
-- no bank details: Settings › Invoicing was empty and nothing stopped Issue. A
-- tax invoice without the supplier's ABN is not a valid tax invoice, and one
-- without bank details is an invoice the customer cannot pay.
--
-- `issueOneInvoice` now refuses first, with the remedy named, and every Issue
-- button is drawn disabled with the same sentence. This trigger is the boundary
-- underneath both: `invoices` is on `/rest/v1/invoices`, so a direct
-- `update invoices set status = 'issued'` would otherwise skip the check
-- entirely.
--
-- **What it guards: the move out of `draft` into a document** — `draft` to
-- anything but `draft` or `void`. Not `issued` alone, because `paid`,
-- `part_paid` and `overdue` are documents too and a direct write could reach
-- them from a draft just as easily. Voiding a draft stays open: a draft that
-- should never have existed has to be cancellable whatever the settings say.
--
-- **What it does not guard, deliberately: an INSERT.** The MYOB import writes
-- its 646 historical invoices straight in as `issued`/`paid`/`overdue` (they
-- were issued years ago, by MYOB), and refusing those would make the import
-- depend on settings that have nothing to do with history. Every invoice this
-- app raises is opened as a draft (`open-draft.ts`, `createManualInvoice`), so
-- the transition is the one place a new tax invoice is born.
--
-- **The four questions, the same ones `issueGaps` asks in
-- `lib/domain/invoice-profile.ts`:**
--   1. an ABN that is eleven digits **and passes the ATO weighted checksum** —
--      a transposed ABN is the mistake that looks right;
--   2. at least one non-blank line of business address;
--   3–4. the bank details: account name, BSB and account number, all three,
--      because the PDF prints all three or none (`paymentInstructions`).
--
-- Reads `tenants.settings -> 'invoiceProfile'`, where Settings › Invoicing saves
-- through `save_tenant_settings` (0052). Malformed JSON there reads as missing,
-- never as an error — a hand-edited blob blocks issuing, it does not 500 it.
--
-- SECURITY DEFINER, so the tenant row is read whatever the caller's RLS shows
-- (0052's reasoning for `guard_invoice_void`), and revoked from `public, anon`
-- **and `authenticated`** — the trap 0019 recorded and 0036 shipped.
--
-- Adds one function and one trigger. No table, no column, no policy, no
-- capability; changes no row. **Written, NOT applied to `laundrymart-syd`.**
-- ============================================================================

create or replace function public.guard_invoice_issue()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_abn text;
  v_profile jsonb;
  v_missing text[] := '{}';
  v_checksum integer;
begin
  -- Only the birth of a document. Everything else — payments settling an issued
  -- invoice, a void, a draft staying a draft — passes untouched.
  if old.status is distinct from 'draft' or new.status in ('draft', 'void') then
    return new;
  end if;

  select t.abn, coalesce(t.settings -> 'invoiceProfile', '{}'::jsonb)
    into v_abn, v_profile
    from public.tenants t
   where t.id = new.tenant_id;

  -- 1. The ABN. Nested rather than `or`-ed: SQL does not promise to short-circuit,
  --    and the checksum casts each character to an integer.
  if v_abn is null or btrim(v_abn) = '' then
    v_missing := v_missing || 'your ABN'::text;
  elsif v_abn !~ '^[0-9]{11}$' then
    v_missing := v_missing || 'a valid ABN'::text;
  else
    select sum(((substr(v_abn, i, 1))::integer - case when i = 1 then 1 else 0 end)
               * (array[10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19])[i])
      into v_checksum
      from generate_series(1, 11) as i;
    if v_checksum % 89 <> 0 then
      v_missing := v_missing || 'a valid ABN'::text;
    end if;
  end if;

  -- 2. The address: any non-blank line. `jsonb_array_elements_text` raises on a
  --    non-array, so the type is checked inside the CASE that guards it.
  if not coalesce(
       case when jsonb_typeof(v_profile -> 'addressLines') = 'array'
            then exists (select 1
                           from jsonb_array_elements_text(v_profile -> 'addressLines') as line
                          where btrim(line) <> '')
       end, false) then
    v_missing := v_missing || 'your business address'::text;
  end if;

  -- 3–4. The bank details, all three or the invoice cannot say how to pay it.
  if coalesce(btrim(v_profile ->> 'bankAccountName'), '') = ''
     or coalesce(btrim(v_profile ->> 'bsb'), '') = ''
     or coalesce(btrim(v_profile ->> 'accountNumber'), '') = '' then
    v_missing := v_missing || 'your bank details'::text;
  end if;

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception '% cannot be issued until the laundry''s invoice details are complete: add % in Settings › Invoicing',
      old.invoice_number, array_to_string(v_missing, ', ')
      using errcode = 'P0001';
  end if;

  return new;
end $$;

drop trigger if exists guard_invoice_issue on public.invoices;
create trigger guard_invoice_issue
  before update of status on public.invoices
  for each row execute procedure public.guard_invoice_issue();

revoke all on function public.guard_invoice_issue() from public, anon, authenticated;

-- ------------------------------------------------------- self-assertions ----
do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_customer uuid := gen_random_uuid();
  v_invoice uuid := gen_random_uuid();
  v_refused boolean;
begin
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.invoices'::regclass
                    and tgname = 'guard_invoice_issue' and not tgisinternal) then
    raise exception '0053: guard_invoice_issue is not attached to invoices';
  end if;

  if not (select prosecdef from pg_proc where oid = 'public.guard_invoice_issue()'::regprocedure) then
    raise exception '0053: guard_invoice_issue is not SECURITY DEFINER';
  end if;

  if has_function_privilege('authenticated', 'public.guard_invoice_issue()', 'execute')
     or has_function_privilege('anon', 'public.guard_invoice_issue()', 'execute') then
    raise exception '0053: guard_invoice_issue is on the RPC surface';
  end if;

  -- 0052's void guard is still attached beside it — a rebuild elsewhere must not
  -- have dropped it, because both fire on `update of status`.
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.invoices'::regclass
                    and tgname = 'guard_invoice_void' and not tgisinternal) then
    raise exception '0053: guard_invoice_void (0052) is missing';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.invoices'::regclass) then
    raise exception '0053: RLS is off on invoices';
  end if;

  -- Behaviourally, against a real row, when this database can be given one: a
  -- tenant with no invoice details is refused, then allowed once they are set.
  -- 0041 refuses a second laundry where the single-laundry switch is on, which
  -- is the live project; there the structural assertions above stand alone and
  -- `invoice_issue_guard.test.sql` is the behavioural proof.
  if public.single_laundry_mode() and exists (select 1 from public.tenants) then
    raise notice '0053: single-laundry mode — behavioural check left to the pgTAP proof';
    return;
  end if;

  insert into public.tenants (id, name) values (v_tenant, '0053 probe laundry');
  insert into public.customers (id, tenant_id, customer_number, business_name)
    values (v_customer, v_tenant, 'CUST-0053', '0053 probe customer');
  insert into public.invoices (id, tenant_id, customer_id, invoice_number, status)
    values (v_invoice, v_tenant, v_customer, 'INV-0053', 'draft');

  begin
    update public.invoices set status = 'issued' where id = v_invoice;
    v_refused := false;
  exception when others then
    v_refused := sqlerrm like '%cannot be issued until%';
  end;
  if not v_refused then
    raise exception '0053: a draft was issued by a laundry with no ABN, address or bank details';
  end if;

  update public.tenants
     set abn = '51824753556',
         settings = jsonb_build_object('invoiceProfile', jsonb_build_object(
           'addressLines', jsonb_build_array('1 Probe Street'),
           'bankAccountName', 'Probe', 'bsb', '062-000', 'accountNumber', '12345678'))
   where id = v_tenant;
  update public.invoices set status = 'issued' where id = v_invoice;
  if (select status from public.invoices where id = v_invoice) <> 'issued' then
    raise exception '0053: a complete laundry could not issue';
  end if;

  delete from public.invoices where id = v_invoice;
  delete from public.customers where id = v_customer;
  delete from public.tenants where id = v_tenant;
end $$;
