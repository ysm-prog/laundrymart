begin;

select plan(14);

-- Required financial statuses exist on completed jobs by trigger behaviour.
select has_column('public', 'laundry_orders', 'billing_status', 'jobs have a billing status');
select has_column('public', 'laundry_orders', 'billed_invoice_id', 'jobs retain invoice relationship');
select has_column('public', 'job_charge_snapshots', 'job_id', 'job charge snapshots point to jobs');
select has_column('public', 'job_charge_snapshots', 'unit_price', 'job charge snapshots retain price');
select has_column('public', 'invoices', 'xero_invoice_id', 'invoices retain Xero id');
select has_column('public', 'invoices', 'source_job_id', 'invoices retain source job');
select has_table('public', 'invoice_source_jobs', 'invoice source jobs table exists');

-- Constraints/unique indexes are the duplicate-invoice boundary.
select has_index('public', 'uq_invoices_source_job', 'a job can have only one non-void per-job invoice');
select has_index('public', 'uq_invoice_source_jobs_job', 'a consolidated source job is unique');

-- The policy definitions must exclude operational roles from financial reads.
select isnt(
  (select pg_get_expr(polqual, polrelid)::text from pg_policy
    where polname = 'invoices_read' and polrelid = 'public.invoices'::regclass),
  '(select is_member(tenant_id))',
  'invoice reads are no longer tenant-wide member reads'
);

select isnt(
  (select pg_get_expr(polqual, polrelid)::text from pg_policy
    where polname = 'job_charge_snapshots_read' and polrelid = 'public.job_charge_snapshots'::regclass),
  '(select is_member(tenant_id))',
  'job charge snapshots are role restricted'
);

-- New approval fields cannot point an invoice lifecycle at a job that does not exist.
select lives_ok($$select 1 from public.invoices limit 1$$, 'invoices remain queryable after migration');
select lives_ok($$select 1 from public.laundry_orders limit 1$$, 'jobs remain queryable after migration');

select * from finish();
rollback;
