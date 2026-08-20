# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

## Latest: month end made pressable — pricing, bulk price, last-month default, bulk issue
2026-08-20, branch `claude/job-invoice-workflow-review-i66do9`. CLAUDE.md §6, §17, §21, §23 and the
2026-08-20 entry have it. **No migration.**

Started as a review of "job completed → invoice pool → one button at month end". The spine was
already right (completion sets `awaiting_review` in the DB and never bills; the dated run sweeps
`approved` jobs from frozen snapshots). Four things blocked it, all fixed:

1. **`priceJobCharges` refused every customer without a rate card** and discarded the list-priced
   lines it had already computed. 508/508 live customers hold none, so the Price button was inert
   for the whole business. Now `priceAndSaveJob` (`lib/orders/job-billing.ts`), shared with the new
   bulk action; refuses on "nothing came back priced", not on "no card".
2. **Price Selected** on `/invoices/awaiting`. Review mode now has two verbs over one selection, so
   unpriced rows became selectable (approving one is still refused by name).
3. **Month-end run defaults to the previous month** (`previousMonth` in `domain/dates.ts`). It used
   to default to 1st-of-this-month → today: on 1 Sept that billed Sept 1–1 and said "nothing to
   invoice", which reads as *everything is billed*.
4. **Issue Selected** — the missing rung; without it the bulk send was unreachable (it refuses
   drafts). `lib/invoices/issue.ts` is the shared implementation. `SendSelected` → `InvoiceSelection`,
   one component with the verb passed in.

Also: four §23 tenant filters added (queue, issue list, send list, and the price-list read — that
one takes `tenantId` as a required argument). 525 unit tests (was 515), `verify` green, gallery
asserted light/dark at 320/360/390/768/1024/1440.

**Merged to `Prod` and deployed 2026-08-20** (`b5184a2`), CI green on all three jobs. The feature
branch and `Prod` are the same commit; `Dev` is still stale and wants a catch-up merge before it
is trusted as staging again.

**Not verified against a live project** — no Supabase credentials here. Before trusting it, on
`ats.coreit.com.au`: take a job in, complete it, **Price this job**, approve, run last month, then
Issue drafts → Send. The pricing fix is the one to watch: it is the first time the price-list tier
has been reachable from a screen.

## Still open (unchanged)
- **§23 sweep:** ~345 of 451 `.from(...)` reads still rely on RLS alone. Correct for the other ten
  roles; a platform admin's session spans two laundries. Cheapest fix remains dropping the platform
  row from the two holders, who are `super_admin` in both laundries anyway.
- **Live wreckage from the 2026-08-18 bug, still there, nothing deleted:** RUN00003/JOB00012 and
  RUN00004/JOB00013 in Harbour (RUN00004 crewed by Mario Forte, an *Adelaide* driver);
  RUN00001/JOB00001 in Adelaide crewed by Sam Okoye, a *Harbour* driver; and **LJ00001, an Adelaide
  job whose customer belongs to Harbour**. Ask the owner before repairing any of it.
- **`Adelaide Towel Service` has no pickable staff** — both its members are platform admins, who are
  filtered out of every picker by design. Invite one real person before trusting its screens.
- **Nothing has talked to Xero yet.** `XERO_CLIENT_ID`/`SECRET` unset by the owner's decision.
- Database: 0001–0030 all applied to `laundrymart-syd`. Nothing pending.
