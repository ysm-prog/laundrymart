-- ============================================================================
-- 0008_invoice_delivery — record where an invoice was actually sent
--
-- `invoices.emailed_at` already existed but only ever said *when*. In a billing
-- dispute the question is "which address did it go to", and a customer's
-- billing_email can change after the fact, so the address has to be stamped on
-- the invoice at send time rather than inferred from the customer record later.
-- ============================================================================

alter table public.invoices
  add column if not exists emailed_to text;

comment on column public.invoices.emailed_to is
  'Address the invoice PDF was last emailed to, captured at send time.';
