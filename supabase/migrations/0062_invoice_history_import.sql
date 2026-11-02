-- 0062_invoice_history_import — the MYOB history, read back out of Xero.
--
-- The app holds the 646 MYOB invoices that were unpaid in August, as headers with
-- no lines. Xero holds the history the September migration put there: drafts with
-- their lines, plus an approved `-OB` invoice for whatever was still owed. These
-- three functions are how that comes in. `lib/domain/xero-history.ts` is the rule;
-- this is only the write.
--
-- Three functions and no other object: no table, column, policy or trigger, and
-- applying this changes no row.
--
-- **SECURITY DEFINER, and that is the point of them.** `guard_invoice_line_draft_only`
-- (0040) refuses a line on anything but a draft, and history is by definition not a
-- draft. Rather than loosen that guard for everybody, a row is taken through
-- `draft` inside one transaction here, so the guard still stands for every other
-- writer. The role is checked inside, against the same two roles as 0025's write
-- layer, because a definer function is past RLS.
--
-- **`source = 'import'` is what keeps these out of the money paths.** It stops a
-- push to Xero (0055), and `isHeaderOnly` keeps `recalculate_invoice` off them, which
-- would otherwise replace the paid figure with a sum of `payments` rows they do not
-- have.
--
-- **Never touches `source = 'app'`.** An invoice this app raised is left alone even
-- if a number somehow matches, and that is counted rather than silent.
--
-- Safe to run twice: lines are only added to an invoice with none, and a new
-- invoice is matched on `(tenant_id, invoice_number)`.

create or replace function public.import_invoice_history(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_id uuid;
  v_status text;
  v_source text;
  v_lines integer;
  v_added integer := 0;
  v_lined integer := 0;
  v_skipped integer := 0;
begin
  if not public.has_role(p_tenant, array['super_admin', 'operations_manager']) then
    raise exception 'Only an owner or office manager can import invoice history'
      using errcode = '42501';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    select id, status, source into v_id, v_status, v_source
      from public.invoices
     where tenant_id = p_tenant and invoice_number = v_row->>'number';

    if found and v_source = 'app' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if not found then
      if v_row->>'customer_id' is null then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      -- Everything with no opening balance was settled in MYOB. `apply_invoice_openings`
      -- runs after this and corrects the ones that were not.
      v_status := 'paid';
      insert into public.invoices (
        tenant_id, customer_id, invoice_number, invoice_type, status, source, issue_date, due_date,
        payment_terms_days, subtotal, tax_amount, total, amount_paid, notes, xero_invoice_id
      ) values (
        p_tenant, (v_row->>'customer_id')::uuid, v_row->>'number', 'manual', 'draft', 'import',
        (v_row->>'issue_date')::date, (v_row->>'due_date')::date,
        coalesce((v_row->>'due_date')::date - (v_row->>'issue_date')::date, 0),
        (v_row->>'total')::numeric, (v_row->>'tax')::numeric, (v_row->>'total')::numeric,
        (v_row->>'total')::numeric, 'Imported from Xero (MYOB history).', v_row->>'xero_invoice_id'
      ) returning id into v_id;
      v_added := v_added + 1;
    else
      select count(*) into v_lines from public.invoice_lines where invoice_id = v_id;
      if v_lines > 0 then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      update public.invoices
         set status = 'draft', tax_amount = (v_row->>'tax')::numeric,
             xero_invoice_id = coalesce(xero_invoice_id, v_row->>'xero_invoice_id')
       where id = v_id;
      v_lined := v_lined + 1;
    end if;

    insert into public.invoice_lines (
      tenant_id, invoice_id, sequence, description, charge_type, quantity, unit_price, amount,
      tax_code, item_id, gl_account_id, origin
    )
    select p_tenant, v_id, l.sequence, l.description, 'other', l.quantity, l.unit_price, l.amount,
           l.tax_code, l.item_id, l.gl_account_id, 'manual'
      from jsonb_to_recordset(coalesce(v_row->'lines', '[]'::jsonb)) as l(
        sequence integer, description text, quantity numeric, unit_price numeric, amount numeric,
        tax_code text, item_id uuid, gl_account_id uuid
      );

    update public.invoices set status = v_status where id = v_id;
  end loop;

  return jsonb_build_object('invoices_added', v_added, 'lines_added_to', v_lined, 'invoices_skipped', v_skipped);
end;
$$;

create or replace function public.apply_invoice_openings(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_inv public.invoices%rowtype;
  v_due numeric;
  v_paid numeric;
  v_today date := (now() at time zone 'Australia/Adelaide')::date;
  v_applied integer := 0;
  v_created integer := 0;
  v_mismatched integer := 0;
  v_skipped integer := 0;
begin
  if not public.has_role(p_tenant, array['super_admin', 'operations_manager']) then
    raise exception 'Only an owner or office manager can import invoice history'
      using errcode = '42501';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_due := (v_row->>'due')::numeric;
    select * into v_inv from public.invoices
     where tenant_id = p_tenant and invoice_number = v_row->>'number';

    if not found then
      -- Open at cut-over, but newer than the history the migration captured. An
      -- opening balance is all Xero knows of it, so that is the invoice.
      if v_row->>'customer_id' is null then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_paid := (v_row->>'total')::numeric - v_due;
      insert into public.invoices (
        tenant_id, customer_id, invoice_number, invoice_type, status, source, issue_date, due_date,
        payment_terms_days, subtotal, total, amount_paid, notes, xero_invoice_id
      ) values (
        p_tenant, (v_row->>'customer_id')::uuid, v_row->>'number', 'manual',
        case when v_due <= 0 then 'paid'
             when v_paid > 0 then 'part_paid'
             when (v_row->>'due_date')::date < v_today then 'overdue'
             else 'issued' end,
        'import', (v_row->>'issue_date')::date, (v_row->>'due_date')::date,
        coalesce((v_row->>'due_date')::date - (v_row->>'issue_date')::date, 0),
        (v_row->>'total')::numeric, (v_row->>'total')::numeric, v_paid,
        'Imported from a Xero opening balance (MYOB).', v_row->>'xero_invoice_id'
      );
      v_created := v_created + 1;
      continue;
    end if;

    -- Credits stay as MYOB left them: Xero holds those as credit notes, not here.
    if v_inv.source = 'app' or v_inv.invoice_type = 'credit' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_paid := v_inv.total - v_inv.amount_credited - v_due;
    if v_paid < 0 then
      -- Xero says more is owed than the invoice was for. Owed in full, and counted.
      v_mismatched := v_mismatched + 1;
      v_paid := 0;
    end if;

    update public.invoices
       set amount_paid = v_paid,
           status = case when v_due <= 0 then 'paid'
                         when v_paid > 0 then 'part_paid'
                         when due_date < v_today then 'overdue'
                         else 'issued' end,
           -- The opening balance is what gets paid in Xero, so it is the id a
           -- payment webhook will arrive under.
           xero_invoice_id = v_row->>'xero_invoice_id'
     where id = v_inv.id;
    v_applied := v_applied + 1;
  end loop;

  return jsonb_build_object('openings_applied', v_applied, 'openings_created', v_created,
                            'openings_over_total', v_mismatched, 'openings_skipped', v_skipped);
end;
$$;

create or replace function public.settle_invoice_history(p_tenant uuid, p_numbers text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_amount numeric;
begin
  if not public.has_role(p_tenant, array['super_admin', 'operations_manager']) then
    raise exception 'Only an owner or office manager can import invoice history'
      using errcode = '42501';
  end if;

  with settled as (
    select id, balance from public.invoices
     where tenant_id = p_tenant and source = 'import' and invoice_type <> 'credit'
       and status in ('issued', 'part_paid', 'overdue')
       and invoice_number = any(p_numbers)
  ), moved as (
    update public.invoices i
       set amount_paid = i.total - i.amount_credited, status = 'paid'
      from settled s where i.id = s.id
    returning s.balance
  )
  select count(*), coalesce(sum(balance), 0) into v_count, v_amount from moved;

  return jsonb_build_object('invoices', v_count, 'amount', v_amount);
end;
$$;

revoke all on function public.import_invoice_history(uuid, jsonb) from public, anon;
revoke all on function public.apply_invoice_openings(uuid, jsonb) from public, anon;
revoke all on function public.settle_invoice_history(uuid, text[]) from public, anon;
grant execute on function public.import_invoice_history(uuid, jsonb) to authenticated, service_role;
grant execute on function public.apply_invoice_openings(uuid, jsonb) to authenticated, service_role;
grant execute on function public.settle_invoice_history(uuid, text[]) to authenticated, service_role;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'import_invoice_history(uuid,jsonb)', 'apply_invoice_openings(uuid,jsonb)', 'settle_invoice_history(uuid,text[])'
  ] loop
    if not (select prosecdef from pg_proc where oid = ('public.' || v_fn)::regprocedure) then
      raise exception '0062: % must be SECURITY DEFINER', v_fn;
    end if;
    if has_function_privilege('anon', ('public.' || v_fn)::regprocedure, 'EXECUTE') then
      raise exception '0062: anon must not execute %', v_fn;
    end if;
    if not has_function_privilege('authenticated', ('public.' || v_fn)::regprocedure, 'EXECUTE') then
      raise exception '0062: authenticated must be able to execute %', v_fn;
    end if;
  end loop;
end $$;
