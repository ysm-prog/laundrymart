-- 0061_invoice_sms — a text is recorded on the invoice, as an email is.
--
-- Jaimin's list of 2 November 2026: invoices go by email, by text, or both, as an
-- option. `invoices.emailed_at`/`emailed_to` (0008) stamp where an email actually
-- went rather than inferring it later from a customer record that can move. A text
-- needs the same two facts, or "did they get it?" has no answer once the mobile on
-- the record changes.
--
-- Adds two nullable columns and nothing else: no table, policy, function or trigger,
-- and it changes no row. `invoices` keeps every policy it has; a column added here is
-- covered by them the moment it exists. Safe to apply before the code that reads it.

alter table public.invoices
  add column if not exists sms_sent_at timestamptz,
  add column if not exists sms_sent_to text;

comment on column public.invoices.sms_sent_at is
  'When a text carrying this invoice''s link last went (0061).';
comment on column public.invoices.sms_sent_to is
  'The mobile that text went to, as +614XXXXXXXX (0061).';

do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'invoices'
         and column_name in ('sms_sent_at', 'sms_sent_to')
         and is_nullable = 'YES') <> 2 then
    raise exception '0061: both sms columns must exist and be nullable';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.invoices'::regclass) then
    raise exception '0061: invoices must keep row level security';
  end if;
  if has_table_privilege('anon', 'public.invoices', 'select') then
    raise exception '0061: anon must hold no grant on invoices';
  end if;
end $$;
