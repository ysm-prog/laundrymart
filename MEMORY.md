# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

## Latest: the client's 19 change requests — reviewed, then built
2026-08-20, branch `claude/electro-services-implementation-8l4f4c`. CLAUDE.md §6, §7, §24, §25
and the new 2026-08-20 entry have it. **Two migrations (`0031`, `0032`), neither applied live.**

Reviewed first (`docs/CHANGE-REVIEW-2026-08-20.md`, also published as an artifact), then built
in the order that review recommended. Four of the five priorities were smaller than they read.

**P1 · Periodic billing — no migration.** `consolidateChargeLines` (pure, in `lib/domain/`,
19 tests) rolls a consolidated invoice up per item instead of one line per job charge. Unit price
and GST are in the grouping key (a mid-period rate change stays two lines); only item-identified
charges merge (three fuel levies stay three lines); amounts are summed not recomputed. New
`/billing` screen: period → customer → one invoice, defaulting to **last month**. The breakdown
is read back through `invoice_source_jobs → job_charge_snapshots` and rendered under the lines on
screen and in the PDF — no second stored copy.
**`invoice_lines.laundry_order_id` is null on a rolled-up line**; safe only because the
billed-once constraint is `uq_invoice_source_jobs_once`.

**P2 · Boards (`0031`).** `boards` = a standing round with its own login; the assignment target.
**Drivers kept** — `daily_routes.operated_by_driver_id` records who drove.
`current_board_id()` / `is_board_only()` + three rewritten permissive policies + 0025's three
*restrictive* `laundry_orders` policies widened. `board` is the twelfth membership role, a
driver's exact capabilities and no `routes.write`.

**P3 · Runs (`/runs`), no migration.** Day + board, drag or arrows, Save order. **Ordering is by
stop.** A worked stop cannot move. My Runs sorts by it and prints the position.

**P4 · Item master (`0032`).** `items` gains `item_code`, is_sell/is_buy, sell/cost price,
tax_code, `laundry_category`, MYOB ref fields. `laundry_order_items.item_id` +
`sync_laundry_item_type()` so item and category can never disagree. Pricing gained one tier of
specificity (item beats category, card still beats list). **MYOB importer deliberately not
built** — needs the real export file, per §14 of the brief.

**Three defects found by the tools, not by review:**
1. rebuilding `guard_laundry_order_transition` from 0016 dropped 0017's billing hook →
   completing a job stopped setting `awaiting_review`. Revenue bug behind a green build; caught
   by `job_billing.test.sql`. **Rebuild a `create or replace` from the LATEST ancestor.**
2. 0025's restrictive layer carved out the driver only → a board could never complete its own
   delivery. Zero rows, no error. Proved by removing the fix: `lives_ok` still passed, the
   assertion that the write *landed* failed.
3. reorder arrows 34px wide (36px floor) and an 18px job link. Found by **measuring** the
   gallery. Now 36×36 and 60×36; every checkbox in a 44px label.

621 unit tests (was 535), **342 pgTAP assertions** (was 306). `verify` green. Gallery asserted
light/dark at 320/360/390/768/1024/1440 — no console errors, no overflow in either new section.

## Do these before trusting any of it
- **Apply `0031` and `0032`** to `laundrymart-syd`, rehearsed in a rolled-back transaction the
  way CLAUDE.md §11 requires. Neither has been applied anywhere.
- **Create one board, link a login, assign a job, sign in as it.** The failure to watch for is a
  login that works and shows nothing — the unlinked-driver bug one level up.
- **Check `items.item_code` backfilled from `sku`** on all live rows (0032 asserts it, but see it).
- **Take one job in, complete it, price it, approve it, then bill a period** — the roll-up has
  never run against real rows.

## Open question above the item work
The app posts to **Xero**; MYOB is a one-off migration source. §18 of the brief asks for ongoing
MYOB sync. **Staying on MYOB / moving to Xero / both** are three different builds of the sync
half. None of them changes the item master, the codes on job items or the search — which is why
those were built and the importer was not.

## Still open (unchanged)
- **§23 sweep:** ~345 of 451 `.from(...)` reads still rely on RLS alone. Correct for the other
  eleven roles; a platform admin's session spans two laundries. Cheapest fix remains dropping the
  platform row from the two holders, who are `super_admin` in both laundries anyway.
- **Live wreckage from the 2026-08-18 bug, still there, nothing deleted:** RUN00003/JOB00012 and
  RUN00004/JOB00013 in Harbour (RUN00004 crewed by Mario Forte, an *Adelaide* driver);
  RUN00001/JOB00001 in Adelaide crewed by Sam Okoye, a *Harbour* driver; and **LJ00001, an
  Adelaide job whose customer belongs to Harbour**. Ask the owner before repairing any of it.
- **`Adelaide Towel Service` has no pickable staff** — both members are platform admins, filtered
  out of every picker by design. Invite one real person before trusting its screens.
- **Nothing has talked to Xero yet.** `XERO_CLIENT_ID`/`SECRET` unset by the owner's decision.
- **This deployment cannot send any auth email.** Custom SMTP still needs configuring.
- Database: 0001–0030 applied to `laundrymart-syd`. **0031 and 0032 pending.**

## Environment readiness
- node v22.22.2, deps installed
- Postgres 16 + pgTAP installed locally; `PGDATABASE=lm_test bash scripts/run-db-tests.sh`
  against a fresh `createdb lm_test` runs every migration, the whole proof suite and the seed
- env missing (copy .env.example) — no live Supabase credentials in this container

Reminders: RLS on every tenant table (tenant_id); admin client must filter tenant_id;
getClaims not getUser; region syd1.
