# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

## There is one tenancy: Adelaide Towel Service
`ats.coreit.com.au` **is** Adelaide Towel Service — its customers, its 648 invoices, its 254 items,
its 268 chart-of-accounts rows. **Every question about live data is a question about that tenant.**
`Harbour Commercial Laundry` is the demo seed in `supabase/seed.sql`, not a laundry; name it only
where that is genuinely what it is. The multi-tenancy architecture stays: one operating tenancy is a
fact about today's data, not a reason to drop `tenant_id`, RLS, or §23's rule that a read feeding a
write names its tenant.

## Latest: the laundry price list is keyed on the item code
2026-08-27, branch `claude/laundry-price-item-codes-0dh46d`. Owner: *"under Laundry price add all
the Item Codes and remove existing data so when owner or manager update it should reflect live in
draft invoice, invoice everywhere itemcode are linked, also provide option to add new itemcodes."*
**No migration; `git diff` over `supabase/` is empty.** CLAUDE.md §31 holds the design, §31a the
propagation rules.

- **The tier already existed with no entry point.** `laundry_prices.item_id` since `0032`, read by
  `priceJob` through `itemPriceListFor` — and both price screens rendered the nine `ITEM_TYPES` and
  never wrote an item row. Live table: **0 rows on the whole project**.
- **The cost is in the data**: `T22`/`T38`/`T40` are three items all named "Towels - Black",
  differing only in price, because with no usable list the rate went into the code.
- **"Remove existing data" removed nothing** — the nine categories were a property of the screen and
  the table was already empty. Say so; do not let a later reader think a deletion failed.
- `liveItemRate` puts the list in front of `items.sell_price` in both places an item becomes money
  (job Charges card, invoice line composer). A **list** rate is taken verbatim, never grossed up.
- **A frozen charge does not move, draft invoice or not** — `guard_job_charge_snapshot` as `0044`
  left it. The screen says so; the remedies are re-price before approving, or take the job off the
  draft.
- 1080 unit tests (was 1050), 504 pgTAP assertions unchanged. `verify` green.

### Verified
- **Browser**: 78 assertions at 390/1440 and 320/390/768/1440 in both themes — 0 failures, 0 console
  errors, 0 overflow inside the section, nothing under 36px. Harness proved non-vacuous.
- **Live probe, rolled back**: board reads 0 prices and is refused both inserts (42501); Owner
  prices T22 (**1 row**), adds an item code, duplicate-for-one-item refused, two items in one
  category both accepted; Office manager reads 3 and re-rates 1 row; board still reads 0 prices and
  **1** of the new item (0040's open SELECT holding). Nothing survived.
- **Measuring found three defects reading did not**: a priced row saying "No price set"; duplicate
  DOM ids across two tables on one page; an 18px-wide GST hit area from `sm` up.

### Not done — needs a browser and the owner
1. **Open Money › Laundry prices on `ats.coreit.com.au`, price `T22`, take a job in for it and press
   Price this job.** The charge should carry the rate just set. Nothing here proves that end to end.
2. `T22`/`T38`/`T40` can now collapse to one code with three customer prices. Touches frozen
   charges — a decision, not a repair.

## Two live findings that belong to the owner, not the code
- **The eleven `@roles.example.com` test profiles and `board1@ats.example.com` hold no membership at
  all.** So §3a's "sign in as each role" no longer works on this deployment. A sensible answer to
  the live-credential problem §3a warns about; recorded because nothing else records it.
- **`marsy.forte69@gmail.com` is a new `board` login**, and `angelo@` (super_admin) plus
  `cmignone219@` (operations_manager) are the two real staff — the only non-platform-admin
  memberships. They are what the live probes now use, which is better than a test profile.
