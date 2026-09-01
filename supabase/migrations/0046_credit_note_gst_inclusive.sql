-- 0046 — a credit note is GST-inclusive, like the invoice it offsets.
--
-- `0043_myob_invoice_lines` moved an invoice from *GST added on top* to *GST
-- extracted from inside the price*: `recalculate_invoice` stores
-- `subtotal = total` and finds the tax within. It did not touch credit notes,
-- and nothing else did either, because a credit note's totals were never
-- computed by the database at all — `createCreditNote` worked them out in
-- application code as `tax = amount * gst_rate` and wrote all three columns
-- itself.
--
-- So the two documents sat on opposite models. Offsetting a $72.70 invoice line
-- needed $66.09 typed into the credit note form, and a customer crediting the
-- full $72.70 was handed a $79.97 credit note. That is a real money error in
-- the direction that costs the laundry.
--
-- **The fix is the mechanism, not just the arithmetic.** Copying 0043's formula
-- into the action would leave two implementations of one rule, which is exactly
-- how this defect was born: 0043 changed the invoice function and could not
-- change a rule that lived somewhere else. `recalculate_credit_note()` is the
-- credit-note twin of `recalculate_invoice()` — same shape, same rate source,
-- same rounding — so the next change to the GST model has one place to go and
-- cannot silently miss one of the two.
--
-- Adds one function. **No table, no column, no policy, no capability, and it
-- changes no row**: there are **0 credit notes and 0 credit note lines** on the
-- deployment, checked before this was written, so nothing stored is
-- re-interpreted and there is nothing to backfill. A credit note written before
-- this keeps the three values it was written with.
--
-- SECURITY **INVOKER**, deliberately and for `recalculate_invoice`'s reason: the
-- app calls it as the signed-in user immediately after writing the lines, so RLS
-- and 0025's restrictive write layer both still apply and a caller who may not
-- write that credit note cannot move its totals. Revoked from `public, anon`
-- exactly as its twin is — and NOT from `authenticated`, which is the one thing
-- that must keep working, since the action reaches it over `/rest/v1/rpc`.

create or replace function public.recalculate_credit_note(p_note uuid)
returns void language plpgsql security invoker set search_path = public as $fn$
declare
  v_rate numeric(5,4);
begin
  select coalesce(t.gst_rate, 0.10) into v_rate
    from public.credit_notes c join public.tenants t on t.id = c.tenant_id
   where c.id = p_note;

  -- The aggregate has no GROUP BY, so it returns exactly one row even for a
  -- credit note with no lines — which is why the join cannot drop the update and
  -- the coalesces are what make an empty note read 0 rather than null.
  update public.credit_notes c set
    subtotal = coalesce(l.sub, 0),
    tax_amount = case when v_rate > 0
      then round(coalesce(l.taxable_sub, 0) * (v_rate / (1 + v_rate)), 2)
      else 0 end,
    total = coalesce(l.sub, 0),
    updated_at = now()
  from (
    select sum(amount) as sub, sum(case when taxable then amount else 0 end) as taxable_sub
      from public.credit_note_lines where credit_note_id = p_note
  ) l
  where c.id = p_note;
end $fn$;

revoke all on function public.recalculate_credit_note(uuid) from public, anon;

-- Then granted back to `authenticated` **explicitly**, which is the one place
-- this file deliberately diverges from its twin. `recalculate_invoice` relies on
-- the platform's default privileges handing each new function a direct grant to
-- `authenticated` (§7's note records that Supabase does this and a local
-- Postgres does not, which is why `pg-bootstrap.sql` mirrors it). Relying on it
-- here would make the assertion below a statement about the platform rather than
-- about this migration — and `create or replace function` does **not** restore a
-- grant somebody has revoked, so a database where that had happened would apply
-- this file and leave the action silently unable to total a credit note. Saying
-- it outright costs one line and removes the dependency.
grant execute on function public.recalculate_credit_note(uuid) to authenticated;

-- ------------------------------------------------------- self-assertions ----
-- Structural first, then the arithmetic against real rows. The migration fails
-- rather than half-applying, which is what makes it safe to apply directly.
do $$
declare
  n int;
  v_sub numeric; v_tax numeric; v_total numeric;
  v_tenant uuid; v_customer uuid; v_invoice uuid; v_note uuid;
begin
  -- 1. the function is there, and is INVOKER rather than DEFINER
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'recalculate_credit_note' and not p.prosecdef;
  if n <> 1 then
    raise exception '0046: recalculate_credit_note is missing or is SECURITY DEFINER (%)', n;
  end if;

  -- 2. it is not reachable without a login
  if has_function_privilege('anon', 'public.recalculate_credit_note(uuid)', 'execute') then
    raise exception '0046: anon can execute recalculate_credit_note';
  end if;

  -- 3. and it IS reachable by a signed-in caller, which the action depends on.
  --    Asserted because the failure mode is a credit note whose totals never
  --    move, with nothing on screen saying why. It guards the grant above rather
  --    than the platform's defaults — proved by removing that line, which fails
  --    this assertion on a database where the grant had been revoked.
  if not has_function_privilege('authenticated', 'public.recalculate_credit_note(uuid)', 'execute') then
    raise exception '0046: authenticated cannot execute recalculate_credit_note';
  end if;

  -- 4. its twin still exists and still agrees about the model. A rebuild of
  --    recalculate_invoice that went back to the exclusive shape would make this
  --    file a lie, so it is checked rather than assumed.
  if (select prosrc from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname='public' and p.proname='recalculate_invoice')
     not like '%(1 + v_rate)%' then
    raise exception '0046: recalculate_invoice is not on the GST-inclusive model';
  end if;

  -- 5. the arithmetic, run against real rows in this transaction.
  --    Reuses a laundry when one exists, because 0041 refuses a second `tenants`
  --    insert wherever the single-laundry switch is on; a fresh database has
  --    none and skips, since gst_inclusive.test.sql is the standing proof and
  --    runs in the same CI job.
  --    The rate is *read*, never set: writing 0.10 onto the live laundry to make
  --    the arithmetic predictable would be this file touching a row it claims not
  --    to, and `tenants` carries an `updated_at` trigger that would record it. A
  --    laundry on some other rate skips the numeric half rather than being
  --    changed to suit its own migration.
  select id into v_tenant from public.tenants
   where coalesce(gst_rate, 0.10) = 0.10 order by created_at limit 1;
  if v_tenant is null then
    raise notice '0046: no laundry at 10%% to rehearse against — see supabase/tests/gst_inclusive.test.sql';
  else
    insert into public.customers (tenant_id, customer_number, business_name)
    values (v_tenant, 'ZZ-0046-PROBE', '0046 probe') returning id into v_customer;

    insert into public.invoices (tenant_id, customer_id, invoice_number, issue_date, status)
    values (v_tenant, v_customer, 'ZZ-0046-INV', current_date, 'draft') returning id into v_invoice;

    insert into public.credit_notes
      (tenant_id, customer_id, invoice_id, credit_note_number, status, subtotal, tax_amount, total)
    values (v_tenant, v_customer, v_invoice, 'ZZ-0046-CN', 'issued', 0, 0, 0)
    returning id into v_note;

    -- The client's own figure, so this file asserts the same number the invoice
    -- side asserts: $72.70 carrying $6.61 of GST inside it.
    insert into public.credit_note_lines
      (tenant_id, credit_note_id, description, quantity, unit_price, amount, taxable)
    values (v_tenant, v_note, '0046 probe', 1, 72.70, 72.70, true);

    perform public.recalculate_credit_note(v_note);
    select subtotal, tax_amount, total into v_sub, v_tax, v_total
      from public.credit_notes where id = v_note;
    if v_sub <> 72.70 or v_tax <> 6.61 or v_total <> 72.70 then
      raise exception '0046: a $72.70 taxable credit came out %/%/% (want 72.70/6.61/72.70)',
        v_sub, v_tax, v_total;
    end if;

    -- A GST-free credit carries no tax, and the total still equals the amount.
    update public.credit_note_lines set taxable = false where credit_note_id = v_note;
    perform public.recalculate_credit_note(v_note);
    select tax_amount, total into v_tax, v_total from public.credit_notes where id = v_note;
    if v_tax <> 0 or v_total <> 72.70 then
      raise exception '0046: a GST-free credit came out tax=% total=% (want 0/72.70)', v_tax, v_total;
    end if;

    -- The header follows the lines rather than a number the caller passed, which
    -- is the whole point of moving this into the database.
    update public.credit_note_lines set taxable = true where credit_note_id = v_note;
    insert into public.credit_note_lines
      (tenant_id, credit_note_id, description, quantity, unit_price, amount, taxable)
    values (v_tenant, v_note, '0046 probe 2', 1, 27.30, 27.30, true);
    perform public.recalculate_credit_note(v_note);
    select subtotal, tax_amount, total into v_sub, v_tax, v_total
      from public.credit_notes where id = v_note;
    if v_sub <> 100.00 or v_tax <> 9.09 or v_total <> 100.00 then
      raise exception '0046: two lines summed to %/%/% (want 100.00/9.09/100.00)',
        v_sub, v_tax, v_total;
    end if;

    -- Undone before the block ends: this migration changes no row.
    delete from public.credit_note_lines where credit_note_id = v_note;
    delete from public.credit_notes where id = v_note;
    delete from public.invoices where id = v_invoice;
    delete from public.customers where id = v_customer;
    raise notice '0046: arithmetic proved against real rows, and rolled back';
  end if;
end $$;
