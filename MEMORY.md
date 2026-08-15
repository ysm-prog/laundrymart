# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**Customer pricing and job billing are built on `claude/customer-pricing-invoicing-sad9af`.**
CLAUDE.md §19 (the design), §20 (capabilities and RLS) and the 2026-08-15 changelog entry have
the full account. Short version:

```
operational  new → in_progress → ready_for_delivery → assigned → out_for_delivery → completed
financial    pending → awaiting_review → approved → invoice_generated → invoice_sent → paid
```

**`0017_customer_pricing_billing` is the only migration, and it is NOT yet applied to
`laundrymart-syd`.** This container has no Supabase credentials. It was applied to a fresh
Postgres 16 in-container, with the whole pgTAP suite and the seed run against it.

**Statement order in 0017 is load-bearing**, same as 0016: the billing columns are added and
backfilled (cancelled → `not_billable`, completed → `awaiting_review`) *before* the guard that
polices them, because those are not transitions — they are what was already true. Re-running
against an empty database is a no-op on the backfill.

**The one sentence the whole feature exists for:** changing a customer's rate tomorrow must never
change an invoice from yesterday. That is true because approval copies the rate card into
`job_charge_snapshots` and stamps `frozen_at`, and `guard_job_charge_snapshot` then refuses every
update and delete — **including from `super_admin`**. `job_billing.test.sql` raises a rate line to
$99 after approval and asserts the approved job still reads $3. If you touch that guard, that is
the test to re-read.

**Completion never bills.** The stamp to `awaiting_review` is made by
`guard_laundry_order_transition`, not by a screen, so no client can bill by completing. The pgTAP
proof completes a job and counts zero invoices.

**Watch this one — it is the bug I introduced and fixed mid-build.** The billing guard as first
written forbade `invoice_generated → approved`, which would have made voiding an invoice strand its
jobs forever. The rule now is explicit: a job returns to `approved` exactly when **no
`invoice_source_jobs` row references it**. So `releaseVoidedInvoiceJobs` must delete the link rows
*before* updating the jobs, and it bails if the delete fails. Any new path out of an invoiced state
has to go through that same door.

**`uq_invoice_source_jobs_once` is partial on purpose** — unique on `(tenant_id, order_id)` where
`invoice_id is not null`. Partial because voiding has to release the work; a plain unique
constraint would have made a wrongly-invoiced job permanently unbillable.

**Two records of one fact again** (the 0016 arrangement): `invoices.source_job_id` is set only for
a single-job invoice, `invoice_source_jobs` carries every job, and `guard_invoice_source_job`
refuses any way they could disagree.

**Dispatcher lost `invoices.read`/`invoices.write`.** That is the only capability any role lost.
Driver, warehouse operator, customer service and dispatcher now hold no financial capability and
keep every operational one; `nav.test.ts` asserts both directions. Sales hold `pricing.*` and not
the ledger — that split is the entire reason pricing and billing are separate capabilities.

**RLS is the boundary, not React.** 0017 replaced the read policies on `invoices`,
`invoice_lines`, `payments`, `credit_notes`, `credit_note_lines` and `service_agreement_lines`.
Two traps that cost real thought:
- **a `for all` policy's USING half grants SELECT too**, so narrowing only `<t>_read` would have
  left the hole open through `<t>_write` — both were replaced;
- 0006's read policy was `is_member` and nothing more, so since My Runs a driver's session could
  read every invoice amount off PostgREST. The proof reads *as a driver and as a dispatcher* and
  counts zero rows, rather than inspecting policy text.

Knock-on: the money **reports** are filtered out of `/reports` for a role without `billing.read`,
because a revenue report rendering "$0" is a wrong answer that looks like a right one.

**Rate cards are service agreement versions** — no `rate_cards` table was invented. The bridge to
counter laundry is one nullable column, `service_agreement_lines.laundry_item_type`; a rate line
without it prices linen rental and is invisible to the job pricer, which is correct.

**The contract minimum is deliberately never applied per job** (fifteen jobs would mean fifteen
minimums). The fuel levy is, because a levy is genuinely per delivery.

**Xero is recorded by hand and nothing else.** Columns exist on customers and invoices and the
screens say plainly that this app does not talk to Xero. Authentication and invoice-state mapping
were unresolved at the previous checkpoint and still are — do not invent an API contract.

**Still true from before:** `laundry_orders` has two FKs to `drivers`, so every `drivers(...)` embed
on it must be disambiguated by constraint name or PostgREST returns PGRST201 at request time.
`@typescript-eslint/no-unused-vars` is an error. Compose-locally-commit-once payload schemas stay
outside `"use server"` files with tests against what the producer really emits — that rule caught
two things again here: `orders/job-charges.ts` (the charge editor's payload) and
`lib/domain/invoice-grouping.ts`, which had to move out of `lib/invoices/from-jobs.ts` because that
module reaches `recordAudit` → `lib/env` and throws in a test environment.

**Verification state.** 358 unit tests, 164 pgTAP assertions, typecheck/lint/build green, all
seventeen migrations + the pgTAP suite + the seed applied to a fresh Postgres 16 in-container.
**Not opened against a live Supabase project, and no screen was rendered with real rows in it.**
The billing screens have not been screenshotted at the ten widths the design system asks for.

## Environment readiness
- node v22.22.2
- deps installed (`npm install` done)
- `.env` written with build-only placeholders (gitignored) so `next build` runs; **not** real
  credentials, so nothing can be opened against Supabase from here.
- Postgres 16 + pgTAP installed in-container; `scripts/run-db-tests.sh` expects `psql` to reach a
  database as the current user, so it was driven manually as the `postgres` role.

Reminders: RLS on every tenant table (tenant_id); admin client must filter tenant_id; getClaims not
getUser; region syd1.
