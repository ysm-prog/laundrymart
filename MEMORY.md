# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

## Latest: Adelaide Towel Service is the only laundry
2026-08-26, branch `claude/adelaide-towel-single-tenant-tbyy06`. Mostly a **live data change**;
one migration (`0041`) keeps it that way. No new table, column, policy or capability; nothing
dropped and no row's meaning changed. CLAUDE.md §11 has the read-backs, §7 the migration, §3a the
consequence for the test logins.

**`Harbour Commercial Laundry` is deleted** — 186 rows across 27 tables, one `delete from tenants`
with all 51 cascading FKs still enforced. Snapshotted first to
`docs/archive/harbour-demo-tenant-2026-08-26.json`, so it is reversible by data and not only by
`supabase/seed.sql`. Two guard triggers (`guard_production_batch_lines_change`,
`guard_laundry_order_items_change`) had to be disabled to let the cascade through and were
re-enabled in the same transaction — the Jay CT lesson, five days on.

**Twelve Adelaide rows went with it, and that is the part beyond the ask.** Every Adelaide row
that *pointed into* Harbour blocked the cascade, and every one was an artefact of the 2026-08-18
cross-tenant bug or the 2026-08-16 delivery session: `LJ00001` + its item + 6 activity rows, stop
`JOB00001`, `RUN00001`, and the project's only `deliveries`/`delivery_lines` pair. All against
Harbour's customer `Test`. **Adelaide now has 0 laundry jobs and 0 runs** — honest, since its whole
job history was test activity. Found by sweeping *every* FK between two tenant-scoped tables for
disagreeing `tenant_id`s: nine such references existed, in both directions.

**The twelve `@roles.example.com` profiles are members of the real laundry now** (owner's call), so
each role can still be signed in as. **This reverses a property §11 used to prove** — they were
Harbour-only, so the 508 real customers were outside all of them. Re-proved as six real sessions
instead: counter/driver/board read **0** invoices, **0** accounts, **0** audit rows; owner/auditor
read 646/268/41; finance reads the money and 0 audit. `driver@` and `board@` got a `Test Driver`
and `TESTBOARD` row in Adelaide, or `current_driver_id()`/`current_board_id()` would be null and
both logins would work with empty screens. **The shared password is a live credential now** —
replace it via People › Email sign-in link.

**The 1,154 archived records are restored** through `set_records_archived(…, false)` as a real
owner session: 508 customers, 646 invoices readable again.

**`0041` exists because the screen is not the boundary.** `tenants` carries 0019's
`tenants_platform` policy, so a platform admin could POST a second laundry straight to
`/rest/v1/tenants`. `guard_single_laundry` refuses with 42501; the action's check is the readable
sentence in front. A **switch** (`platform_settings.settings.single_laundry`), not a removal,
because the ask was "for now" — one press on Platform › Settings turns it off, no deploy.
**Absent means off**, which is load-bearing: the seed creates a laundry and the proofs create two.
**INSERT only, and only the second** — renaming, suspending and deleting stay writable, and the
first laundry is always allowed.

**934 unit tests (was 928), 478 pgTAP assertions across 26 files (was 469/25), `verify` green**,
43 migrations against a fresh Postgres 16 with the suite and seed. **940/478 with `Prod` merged
in**, which brought the coding-control fix. The seed applying on top is the real check here: it
creates a laundry, so passing is "absent means off" proved rather than asserted. New assertions proved to fail
without the fix: the proof dies outright without 0041, and `z.coerce.boolean()` in place of the
checkbox preprocessor fails the stray-value test.

**Applied live before the merge.** Rehearsed in a transaction that ended by raising; the rollback
read back clean, the real run matched it exactly, ten assertions passed. After: **1 tenant**, 18
logins, 508 customers, 646 invoices, 254 items, 268 accounts, 1,515 bills, 5 boards, 2 drivers,
0 jobs, 0 runs. Advisors **23**, unchanged — both new functions are revoked from `authenticated`
so neither is on the list. 0 anon table grants, 0 tables without RLS. Refusal proved as a real
platform admin: 42501 with the sentence, while a rename still touched its row.

**Two things left for the owner, not the code.** Adelaide's only depot (`ADL`) is **inactive** —
set that way deliberately by `darshan@` at 01:57 on 2026-08-26 — and all eight site pickers filter
`status = 'active'`, so adding a customer/driver/board/vehicle/contract currently offers no site.
One press on Settings › Sites. And Adelaide still holds **0 laundry prices**. One `run-media`
object under the old tenant's prefix survives: Supabase refuses a direct delete on
`storage.objects`.

**Not verified behind the auth gate** — no Supabase credentials here. Before trusting it: sign in
as `owner@roles.example.com` on `ats.coreit.com.au`, check Platform shows "This laundry" with no
Add form, and that Customers lists the 508 that came back.

**Merged to `Prod` (`bf92cbc`, PR #38) and `Dev` (`1b799f9`, PR #39)** — identical trees, CI green
on all three jobs, Vercel production deploy completed. `Prod` had moved (PR #36, the coding
control) and was merged in first; only the two doc files conflicted. Direct pushes to `Prod` are
refused in this environment, so the merge went through pull requests.


## Previously: the coding control stopped promising codes that are not there

> **Superseded in its data, not its fix.** `Harbour Commercial Laundry` and `LJ00006` were deleted
> later the same day (see the entry above). The rule and its tests stand.
2026-08-26, branch `claude/code-review-requirements-ns6bav`. Reported from the deployed app —
*"I still can't get the codes here"* on `LJ00006`'s charges. **No migration.**

**The diagnosis is data, not code.** `LJ00006` is a **Harbour Commercial Laundry** job (the demo
tenant), and Harbour holds **0 `gl_accounts`**. The **261** postable accounts and the **254**
items belong to **Adelaide Towel Service**. Both owner logins are platform admins and
`super_admin` of both, so the answer is the tenant switcher in the account menu.

**What was genuinely broken:** the charges editor said "Add item or code" regardless, and pressing
it produced an item picker and an apology — the dead end §27 already records being fixed on the
invoice composer one screen over. `codingOffer` in `lib/domain/coding.ts` is that rule now, pure
and tested; the absence sentence names the *missing list* rather than the consequence. 934 unit
tests (was 928), gallery gained the third state, 48 browser assertions at 390/1440 with 0 console
errors, and both new assertions confirmed to fail without the fix.

**Two things left, both the owner's and neither a code change:**
- Adelaide holds **0 of 254 items with an income account**, so item→code produces nothing there.
  The MYOB inventory export carries no such column, so nothing was dropped or guessed (§25's
  discipline). Set it on `/items/:id` — only the few items a customer is charged for need it.
- **0 of 261 accounts carry a `xero_account_code`**, so even a coded line sends nothing to Xero.


## Previously: one invoice per customer per month, and it fills up as it goes
2026-08-26, branch `claude/invoice-draft-consolidation-eqr3o7`. **One migration (`0040`)**, no new
table, no new role, no new capability, nothing dropped. `docs/REQUIREMENTS-RUNNING-DRAFT-INVOICE.md`
is the BA statement; CLAUDE.md §30 the rationale, §4 the database rules, §7 the migration.

**The defect: consolidation belonged to a button press, not to the customer.**
`generateInvoicesForJobs` always **inserted** and `groupJobsForInvoicing` grouped only the jobs it
was handed — so a `monthly_consolidated` customer got one invoice per *press*. Approve on the 3rd
and Generate, approve on the 11th and Generate: two August invoices. Nothing double-billed
(`uq_invoice_source_jobs_once`); the month was split.

- **Approving a job places its charges on that customer's open draft for the period.** Next job
  joins the same one; same item at the same rate merges into one line. `manual` is the opt-out —
  no new setting, because that billing method already means "a person decides each time".
- **New board: Money › Open drafts** (`/invoices/drafts`), one card per running invoice with
  **Issue now** on every row and a bulk Issue selected. Issuing at any time is the point.
- **Take a job back off a draft** — voiding releases *all* of them, which is wrong for a draft
  carrying eleven good jobs and one bad one.
- **The month-end run writes onto the same draft**, so §4's "one invoice per customer per period,
  contracts *and* jobs" is true for the first time; it used to raise two.
- **An invoice is dated the day it is issued** (`issueOneInvoice` re-stamps `issue_date`/`due_date`).
  A behaviour change, and necessary: a draft opened on the 3rd would otherwise arrive on the 31st
  a fortnight overdue.

**Two holes found on the way, neither about the feature:**
- **A line could be added to an issued, sent, paid or voided invoice** — `addInvoiceLine` checks the
  capability and never the status, and `invoice_lines` is on `/rest/v1/…`.
  `guard_invoice_line_draft_only` refuses with 42501 (trigger, not restrictive policy: the rule is
  about the *parent's* state, and a restrictive policy writes zero rows in silence).
- **Nothing said where a line came from**, so "rebuild the generator's lines, leave typed ones
  alone" was inexpressible. `invoice_lines.origin` = job / contract / manual, default manual.

**Decisions:** job lines are **rebuilt, never patched** (consolidated lines are sums of frozen
amounts; recomputing loses the cent), `jobInvoiceLines` is the single line writer shared by create
and append, and the draft is found via a **partial unique index** rather than remembered. The
residual two-writer race is documented and narrowed by one retry inside `rebuildJobLines`; closing
it fully needs a database function.

**913 unit tests (was 894), 460 pgTAP assertions (was 439), `verify` green**, 41 migrations against
a fresh Postgres 16 with the suite and seed. Every new assertion proved to fail without its fix.
Gallery measured: 24 combinations, 0 console errors, 0 section overflow, 0 sub-36px targets,
document overflow byte-identical to the baseline.

**Applied to `laundrymart-syd` before the merge** (`20260826040754`), so the schema led the code.
Rehearsed against the real 647 invoices and rolled back first — and the rollback mechanism itself
was proved before being trusted. After the apply: index unique, `origin` defaulting to `manual`,
guard attached and **not** callable by `authenticated`/`anon`, 0 probe leftovers, every count
unchanged. Advisors 22 → 23, the addition being `can_write_items` from the *other* 0040 — mine adds
none.

**There are two 0040s on the project and both are ours** — `0040_item_master_write` (03:08) and
`0040_open_draft_invoices` (04:07). Disjoint objects, so unlike the 0036/0037 collision there was
nothing to reconcile; **proved** by applying both to a fresh Postgres 16 in filename order with the
whole suite on top. Merged tree: **928 unit tests, 469 pgTAP assertions**, `verify` green.

**Merged: `Dev` and `Prod` are both `816c52c`, identical trees, CI green on all three jobs for
both.** `Dev` had moved six commits while this was in flight (the item master gate, its capability
block, the "Items" rename, `laundry_category`, and the Adelaide-time correction); only the two
documentation files conflicted.

**Still not opened behind the auth gate** (no credentials here). Next: take a job in on
`ats.coreit.com.au`, approve it, check Money › Open drafts; take a second job in for the same
customer, approve it, confirm the *same* invoice number picks it up with quantities added rather
than a second line; press Issue now and check it is dated today. All 647 invoices still carry 0
lines, so the first running draft has yet to collect anything.


## Previously: what kind of laundry each item is

## Latest: the business runs on Adelaide time
2026-08-26, branch `claude/invoice-item-code-selection-vlwwb4`. **No migration, no schema
change, and no live row altered.** CLAUDE.md §2 and the newest changelog entry have it.

The client's correction: this project is based on Adelaide date and time. `BUSINESS_TIMEZONE`
was `Australia/Sydney` — from the skeleton this build started from, not from anything about
the client — and it decides the instant composed from "received today", the day an invoice
period ends and the day a notification is filed under. For half an hour either side of
midnight it filed this laundry's work under another state's date.

- **The database always said Adelaide.** `tenants.timezone` and `depots.timezone` have read
  `Australia/Adelaide` since the cutover; nothing in `src/` consulted them because the zone was
  hard-coded. The correction changed **no live row**.
- **Re-dated nothing, checked before moving:** 1 app-composed `received_at` (not near
  midnight), 646 invoices whose `issue_date` is a `DATE`, 0 charges, 0 notifications. The two
  zones differ by 30 minutes, so only an instant within 30 minutes of midnight could move day.
- **Seven tests failed and all seven were rewritten to the decision**, not made to pass — they
  encoded the old offsets (AEST +10 → ACST +9:30, AEDT +11 → ACDT +10:30, delivery email 2:30pm
  → 2:00pm). Expected instants computed against the tz database, not by hand.
- `OPERATIONS_TIMEZONE` and `BUSINESS_TIMEZONE` are both Adelaide now but stay separate names:
  different questions, and Harbour (the demo tenant) is still a Sydney laundry in its own rows.
- Cron unchanged (UTC; now 06:30–14:30 Adelaide). `syd1` region unchanged — that is a region,
  not a timezone.
- 885 unit tests, 448 pgTAP assertions, verify green.

### Next
1. Not merged to `Dev`/`Prod` yet.
2. **Adelaide's price list is still not in hand.** The client says it was provided; the only
   uploads present are the two MYOB workbooks, and neither carries rates — `MYOB_Inventory`
   has a selling price on **2 of 257** rows and its second sheet is aggregate stats only.
   `laundry_prices` for Adelaide is still **0**.
3. Still never run end to end: take a job in → code a charge → approve → generate → confirm the
   line arrives already coded.

---

## Previous: what kind of laundry each item is
2026-08-26, branch `claude/invoice-item-code-selection-vlwwb4`. **No migration** — one pure
rule (`src/lib/domain/laundry-category.ts`), its tests, and a live data write. CLAUDE.md §25
and the newest changelog entry have it.

**125 of Adelaide's 254 items now carry a `laundry_category`; the other 129 are deliberately
null** — chemicals, gloves, cups, machine parts, washroom paper and fees, all things the
laundry buys.

- **A rule, not a one-off UPDATE**, because `laundry_category` is what
  `sync_laundry_item_type` derives `item_type` from, and `item_type` is what all three pricing
  tiers and every report match on. This answer decides what a customer is charged.
- **It refuses to guess.** A wrong category prices work at another kind's rate with nothing on
  screen to explain it; a missing one leaves the item exactly as it was.
- Towel family is one bucket (`towels`) — face washers, tea towels, glass cloths, salon and gym
  towels — matching how Harbour's tea towel was already filed.

**Five traps, all pinned by tests confirmed to fail without their guard:** a bath sheet is a
bath towel not bedding; their `4-` "hand towels" are washroom paper; `Toilet Paper 2Ply 400
Sheet` matches the generic sheet rule; *Lost Towels* / *New Towels — dozen* name linen while
being a charge and a sale; and a container bag is not laundry while **`Towels Per Bag` and
`Sleeping Bags` are** — the last found by dry-running the 254 rows, because a blanket `bag`
exclusion had silently swallowed four real items. **A false exclusion is the quiet way this
goes wrong**: the row just stays uncategorised.

**Three left for a person, named not skipped:** `29927` and `50761`, truncated by MYOB at 30
characters before the word that would place them (their siblings are tea towels), and `18662
Terry Nappies`, which is laundry and fits none of the nine kinds.

- 885 unit tests (was 872), 448 pgTAP assertions, verify green.
- **Applied live**, rehearsed first, behind six assertions. Read back as `board1@ats.example.com`:
  254 items, 125 categorised, every spot-check code correct. **No job was re-categorised** —
  `sync_laundry_item_type` fires on `laundry_order_items`, not `items`, so the 5 existing job item
  rows still read `towels`.

### Next
1. Not merged to `Dev`/`Prod` yet.
2. Adelaide still holds **0** `laundry_prices` — the categories are in place, the rates are not.
3. Still never run end to end: take a job in → code a charge → approve → generate → confirm the
   line arrives already coded.

---

## Previously: the item master is one list, named one way, changed by two people
2026-08-26, branch `claude/invoice-item-code-selection-vlwwb4`. One migration
(`0040_item_master_write`) — no new table, no new column, no new trigger, nothing dropped
but the policy it replaces, no row changed. CLAUDE.md §3, §7, §25 and the newest changelog
entry have it.

The client's instruction: the list they sent is the master, it is the only item reference
anywhere for ATS, and the Owner and the Office manager maintain it.

- **The option they asked for already existed; the boundary under it did not.** `roles.ts`
  has gated `/items` on `items.write` all along. `items` carried 0002's permissive
  `for all … using is_member(tenant_id)`, so **nothing gated the table**.
- **Probed as one of Adelaide's own `board` logins**, rolled back: it read all 254,
  **renamed `TW`**, **inserted** an item and **deleted** one. Control: `laundry_prices`
  returned 0 to the same session, so 0033's gate held and this was `items` specifically.
- **Fourth table to need this exact replacement** (0006→0017, 0018→0033, 0021→0036). It hid
  the same way: six demo rows until the import. **An empty table is not a proof.**
- **SELECT stays open to every member** — a board's run sheet, the plant's batches, the
  counter's picker all name items. Only the write moved.
- **`items.write` → Owner + Office manager**, an `ITEM_MASTER` block subtracted from the
  `TENANT_ALL`-derived roles. `branch_manager`/`regional_manager` held it by not being
  mentioned.

**A proof was defending the hole, for the third time here.** `main_flow_scope.test.sql`
asserted `lives_ok` on the *plant floor inserting an item* under "the floor still runs its
own screens". `warehouse_operator` has never held `items.write`. Rewritten to the decision,
the same move `laundry_pricing.test.sql` needed in 0033.

**One reference, one way of naming it.** A job's laundry rows used a plain `<select>` while
the invoice and charges used the type-ahead — unusable at 254 rows. `ItemPicker` is generic
now, so the job form passes its own catalogue type; `purpose` is the only difference, and a
laundry row shows **no price** (the rate is `laundry_prices`; 252 of 254 have no sell price,
so "no price set" would read as "this will not be billed"). Tab renamed "Item types" →
"Items".

**The migration's own assertion caught a defect in the migration**: `can_write_items` was
created PUBLIC-executable. Postgres grants EXECUTE to PUBLIC as a *built-in* default and
`alter default privileges` (0011, 0029) is applied on top of it, not instead. Revoked by
name, the way 0036 does. Fifth instance of that trap here.

- 872 unit tests, **448 pgTAP assertions**, verify green, 40 migrations + suite + seed on a
  fresh Postgres 16. Both new proof blocks confirmed to fail without 0040.
- Gallery: the picker in both purposes, driven in a real browser — 10 assertions clean,
  including no duplicate ids across two pickers and a guard that the section is in the page
  *being served*.

**Applied live** as `20260826030846`, the ledger's last entry. Read back as five real
sessions, writes rolled back: the board, the warehouse operator and the counter all still
**read** the list and their rename touches **0 rows** with the name unchanged, insert
refused 42501; `owner@roles` (a real super_admin, **not** a platform admin) and the office
manager both rename 1 row and insert successfully. 4 policies on `items`, one verb each,
**0 permissive for-all**. Advisors 22 → 23, the addition being `can_write_items`.

**The rehearsal needed a second attempt and the reason is worth keeping**: the first pass
renamed by `item_code in ('TW','TOW001')` and the Owner's rename came back 0 rows — which
reads as a refusal and was actually *no such code in Harbour*. Every probe now renames a row
the session has just read back, so 0 rows can only mean refused.

### Next
Still never run end to end: take a job in → code a charge → approve → generate → confirm the
line arrives already coded.

---

## Previously: the Jay CT test data is deleted
2026-08-26, at the owner's instruction. **Live data deletion only — no migration, no schema, no code
change.** 58 rows across 11 tables, all in Adelaide, all belonging to the two duplicate `Jay CT`
customer records: 2 customers, 2 locations, LJ00002–LJ00006, 7 items, 31 activity rows, 4 stops,
1 frozen charge, RUN00002/3/4, and `INV00001` with its line and source-job link.

- **Rehearsed in a block that could not commit first**, and the real run matched it exactly. The
  runs were **checked** for stops belonging to another customer (the block aborts if any) rather
  than assumed empty.
- **Two DELETE guards bypassed deliberately and re-enabled in the same transaction** —
  `guard_job_charge_snapshots_change` (refuses a frozen charge even for `super_admin`) and
  `guard_laundry_order_items_change`. Both back at `tgenabled = 'O'`. `session_replication_role`
  was **not** used: it would have turned FK enforcement off too. 0 orphans afterwards.
- **The `Test` customer (`CUST00003`, `LJ00001`) was left alone** — not asked for.

**Adelaide now:** 0 active customers, 508 archived, 1 laundry job, 1 run, 646 invoices. Harbour
untouched. **No invoice on the project carries a line any more**, so the live end-to-end evidence
for job → price → approve → generate is gone with `INV00001`; unit tests and pgTAP still cover it.
The next run-through will be the first against a real customer.

**Two claims merged an hour earlier are now corrected in §11** — they asserted INV00001 exists and
that Jay CT was being left in place.


## Previously: the item list arrives, and 254 items are live in Adelaide
2026-08-26, branch `claude/invoice-item-code-selection-vlwwb4`. **No migration** — the
reader, the pickers and a live data import. CLAUDE.md §11, §25, §27 and the newest
changelog entry have it.

The client's updated requirement: pick the **ItemCode and price**, not the account code.
Half is built; the other half cannot come from this file, which is the finding.

- **The item leads, the account follows** — MYOB's own shape. The coding strip asks for
  the item and shows the account beneath it, with "Use a different account" as the escape.
- **The price is not in this export**: 2 of 257 rows carry one, and every sellable service
  code (`TW`, `GTW`, `HTW`, `BT`, `Del`) is blank. Most of these are things the laundry
  *buys*. So the rate keeps coming from `laundry_prices` — where the client's own rates
  already are (their invoice bills `TW` at $0.22, a customer rate, not a list price).
- **`Item Number` is the code staff type, not `Item ID`** — the latter is MYOB's internal
  row number. Reading it would have imported 257 items nobody could find.
- **A defect proved against a real database:** `items` is unique on
  `(tenant_id, lower(item_code))` and partial, so PostgREST's `on_conflict=` cannot name it
  (`42P10`). `PlannedTable.matchBy` reads, updates by id and inserts the rest.
- `MAX_ITEM_CODE` 20 → 30: their real codes reach 23.

**Imported live.** 254 items into `Adelaide Towel Service`, rehearsed in a rolled-back
transaction first, then applied behind eight assertions (including that the table still
started empty). Read back **as `board1@ats.example.com`**, a real Adelaide-only session:
254 items, Harbour's 6 not among them, and still 0 accounts / 0 invoices / 0 prices — so
0036's gate and the billing narrowing both held. 268 accounts, 647 invoices, 6 jobs
unchanged.

**Two things stated rather than glossed**, because both differ from what was offered:
- **All 254 are `is_sell` *and* `is_buy`** — the export carries neither flag, so neither is
  inferred. The two coding pickers now filter `is_sell`, which they never did before, so
  the flag is a lever an owner can pull (untick "I sell this" on the detergent) rather than
  decoration. Inert on this data.
- **All 254 have no `laundry_category` and no `income_account_id`.** The export says
  neither. So the item picker works today and the *account* is still chosen per line until
  somebody codes the items. Owner's next step, not something the import could answer.

**`0039` is applied** (`20260826022128`, the ledger's last entry). Eleven verifications,
six of them behavioural against real rows in an aborted transaction; **no new security
advisor**, so the `public, anon, authenticated` revoke on the definer trigger function
held — the check 0036 failed.

**Another session deleted Adelaide's test data at 02:12:59**, between the import and the
0039 apply: 2 customers, 5 jobs, 1 invoice, the 1 frozen charge and the paperwork under
them. Deliberate and rehearsed, not an accident, and **the 254 items were untouched**.
Adelaide is down to LJ00001. So §27's motivating count (1 frozen charge, 0 with an item)
is now 0 charges — the argument stands on the reasoning, not on a live row.

### Next
End to end, still never run: take a job in → code one charge → approve → generate the
invoice → confirm the line arrives already coded; then push one invoice and watch
`AccountCode` populate for the first time.

---

## Previous: code the charge where the charge is made
2026-08-26, branch `claude/invoice-item-code-selection-vlwwb4`. One migration
(`0039_job_charge_codes`) — no new table, no new role, no new capability, nothing
dropped, no row changed. CLAUDE.md §7, §27 and the newest changelog entry have it.

The client's comparison: MYOB puts **Item ID** and **Category** (the account code) on
the line as it is written. This app asked twice — a charge added by hand on a job
carried no item and *could* carry no account, so the invoice line came out uncoded and
somebody re-keyed it. Counted first: Adelaide holds **1** frozen charge, **0** with an
item, and has no rate card and no price list — so every charge it raises is hand-added
and the coding feature was inert for the one real business using it.

- Each charge row names an item and an account, same code-first type-ahead as the
  invoice composer. Pickers are now **shared** (`components/coding-pickers.tsx`).
- **`saveJobCharges` is the one place a charge gets its code** — both writers pass
  through it. An account already on the charge wins (a hand override is deliberate).
- **The account is part of the consolidation key**, like unit price and `taxable`:
  two charges for one item coded differently must not merge into one line.
- Generation prefers the charge's account, item as fallback — same precedence as
  `lib/xero/push.ts`.

**Found by driving it:** every row rendered the same DOM ids, so each row's label
pointed at the first row's box. Pickers take an `idPrefix` now. Invisible to
typecheck, unit tests and screenshots alike.

- 802 unit tests, **439 pgTAP assertions**, verify green, whole suite + seed on a
  fresh Postgres 16. New assertions confirmed to fail without 0039.
- Gallery: 24 combinations, 0 console errors, 0 overflow, 0 targets under 36px,
  document overflow byte-identical to baseline. 12 interaction assertions.

---

## Previous: merged to Prod and Dev — the filter language is live
2026-08-26. **PR [#30](https://github.com/ysm-prog/laundrymart/pull/30) → `Prod` (`8510154`), PR
[#32](https://github.com/ysm-prog/laundrymart/pull/32) → `Dev` (`2bcd4fe`)**, identical trees, CI
green on all three jobs for both (verify, gitleaks, and the DB job: 40 migrations, 431 pgTAP
assertions and the seed against a fresh Postgres 16). 843 unit tests.

- **Nothing to apply to Supabase** for that work: `git diff` over `supabase/` was empty and the
  ledger's last entry was `0038_invoice_line_account`. `0039_job_charge_codes` went on later the
  same day, from this branch.
- **What landed:** the YSM Hub filter language on every list — `components/filters.tsx`
  (`FilterChips`, `ToggleChips`, `PeriodFilter`, `FilterSummary`) with the rules pure and tested in
  `lib/filters.ts`, ten canonical period presets in `lib/domain/dates.ts` behind `resolvePeriod`,
  and `ListControls` composing chips → fields → summary. CLAUDE.md **§29** is the design.
- **Eleven screens had no filter at all** before this, the billing queue among them. Four defects
  the gallery caught are in CLAUDE.md's entry — the biggest being that **`cx(CONTROL, "w-auto")`
  has never worked** (ten call sites rendering full width; `CONTROL_AUTO` now).

**Two process faults on the way out, neither in the code.** The first merge commit recorded **only
one parent** — a `git checkout` mid-merge cleared `MERGE_HEAD`, so the commit had the right tree
and no link to `Prod`; GitHub marked the PR conflicted, and **a conflicted PR has no merge ref, so
CI never ran on it**. Redone from the pre-merge commit, tree proved byte-identical. Second:
GitHub's **check-runs API served a stale `in_progress`** for a job that had finished four minutes
earlier — read the run's jobs endpoint, not the check, before calling a job stuck.

**Still open and needing a login, not a commit:** open Money › Awaiting invoice on
`ats.coreit.com.au`, press **"Not priced yet"**, and confirm the chip's count matches the rows
under it. Also still open from before: take a real run through Adjust Run → Save & Lock Run as
`owner@roles.example.com`, and the Xero coding ladder has never met real data.

## Previously: Adjust Run merged, and verified against the live database
2026-08-26. **`Prod` = `f8eb138` (PR #26), `Dev` = `6c1dd4c` (PR #27)**, identical trees, CI green on
all three jobs for both.

- **Nothing to deploy to Supabase.** The branch adds no migration. Checked by **object, not by ledger
  name** — six migrations sit live under their pre-renumbering names, so a name diff reports six
  false gaps. Everything Adjust Run calls at request time is live and correctly shaped
  (`apply_run_sequence` INVOKER, `compact_run_sequence` DEFINER, `daily_routes.sequence_*`, both
  guard triggers — which are named `guard_jobs_sequence` / `guard_daily_routes_sequence_control`,
  **not** after their functions).
- **The boundary is proved against real rows for the first time**: Adelaide Board 1 / 28 Aug, in a
  block ending with a raise so nothing commits — board refused 42501, dispatcher refused 42501,
  `operations_manager` saved v1→2 with the stops really swapping, stale replay refused. Rollback read
  back clean (version 1, still locked, 0 audit rows).
- Advisors **22** = 21 documented definer helpers + auth toggle; `sync_invoice_line_account` still
  absent, so the 2026-08-25 revoke holds. 0 anon table grants, 0 tables without RLS.
- Counts moved because the laundry is using it: **648** invoices (was 647), **10** laundry jobs
  (was 8).

**`Jay CT` is a test customer — the owner confirmed it on 2026-08-26 — and it exists twice**
(`CUST00509` = 4 jobs + `INV00001` + 3 stops, `CUST00510` = 1 job + 1 stop, created 0.65s apart with
a location row each at the same address). That is why Board 1's 28 Aug run has two stops at one
address and the Run order card shows "Jay CT" twice; `findOrCreateStop` keys on (tenant, run,
customer) and is right. Nothing to fix in code, and not deleted — it is the only end-to-end evidence
the billing path has.

**The correction that came out of it, and it is the important one.** CLAUDE.md §11 claimed `LJ00002`
was *"the first time the billing lifecycle has run against real work"*. It was not:
**all six of Adelaide's laundry jobs are against test customers** (LJ00002–06 = Jay CT, LJ00001 =
a customer named `Test`); jobs against a non-test customer = **0**. What *is* true and is new:
`INV00001` (draft, $55, one line, from LJ00002, 2026-08-26) is the **only one of 648 invoices that
carries a line at all**, so job → price → approve → generate is now proved end to end — against test
data. Both corrected in §11.

**Still needs a login, not a commit:** open My Runs as `owner@roles.example.com` on
`ats.coreit.com.au` and drive Adjust Run in the browser; confirm `board1@ats.example.com` sees no
card.


## Earlier: Adjust Run reaches My Runs
2026-08-26, branch `claude/adjust-run-button-roles-ushdk9`. The owner asked for the button on the
screen they are actually looking at, restricted to the Owner and the Office manager. **No
migration, no schema, no RLS, no capability, no new role.**

- `/my-runs` now draws a **"Run order"** card between the day's workflow and its job groups: the
  *same* `SequenceBoard` and the *same* `reorderRunStops` the Runs screen uses. Gated on
  `routes.sequence`, so a board, a driver and a dispatcher get **no card at all** — and no extra
  query, because the read is skipped with it.
- `lib/runs/sequence-stops.ts` is new and shared by both screens. Not tidiness: the version a page
  renders with is the token its save is compared against, so a second read would be a stale-version
  refusal nobody could explain.
- `SequenceBoard` gained `returnTo`; `reorderRunStops` reads it through `returnTo(formData, …)`.
  Without it a manager adjusting a run from the round's day would be moved to `/runs`.
- `SequenceStop` moved into `sequence.ts` as `OrderableStop & { … }`, so `progressStatus` and its
  `asOrderable` adapter are gone. Design-preview fixtures updated with it.
- 812 unit tests (was 806), `verify` green. Both new assertions **proved to fail** without their
  fix. 42 browser interaction assertions at 390/1440, and 12 measured combinations with 0 overflow
  inside the card, 0 sub-36px targets, 0 console errors.
- **The measurement harness caught itself twice** and both are recorded in CLAUDE.md §18: a stale
  `next start` (failed loudly — the 2026-08-25 vacuous-pass trap), and a text-size sweep that was
  vacuous because `"biggest"` is the label and `"xlarge"` is the value. It now asserts the root
  font size actually moved.

**Not opened behind the auth gate** — no Supabase credentials here. Before trusting it: as
`owner@roles.example.com` on `ats.coreit.com.au`, open My Runs for Board 1 on a two-stop day,
Adjust Run, swap 1 and 2, Save & Lock Run; then check `board1@ats.example.com` sees no card. That
is also the one item the 2026-08-25 entry left open.


## Earlier still: merged to Prod and Dev
2026-08-26. **PR #23 → `Prod` (`00c6613`), PR #24 → `Dev`**, CI green on all three jobs for both
(verify, gitleaks, and the DB job: 40 migrations, 431 pgTAP assertions and the seed against a
fresh Postgres 16). `ats.coreit.com.au` carries the whole branch.

## Older: merged with Prod — the coding ladder and the audit rule
2026-08-25. **Most of this branch is already live on `ats.coreit.com.au`**; another session
merged the run-sequencing work and the account-codes work to `Prod` while this branch was still
open. `origin/Prod` was merged **into** this branch and the four conflicts resolved before
anything else — the branch was seven commits behind.

**What is genuinely new here, and not yet on Prod:**
- **`resolveAccountCode`** — the Xero coding ladder as one pure, tested rule: **line's own
  account → its item's → the laundry's default sales account**. Prod had independently fixed the
  same defect inline in `push.ts` with `??`, in the same direction. Mine is kept for two reasons
  and Prod's reasoning is kept with it: it is tested (9 assertions, 5 fail without the item
  tier), and a `??` chain **stops on an empty string** — sending `AccountCode: ""`, which Xero
  rejects — where the rule falls through a blank tier to the next real one.
- **`buildSequenceAudit`** — the run-order audit record as a pure rule, so §15/§23's list
  (previous order, new order, board, date, actor, role) is asserted field by field rather than
  read. Confirmed by dropping the actor's role and by aliasing the arrays: two tests fail.
- **`0038_invoice_line_account`** — `invoice_lines.gl_account_id`, `if not exists`, so a database
  built from this repo carries what `push.ts` reads. A no-op after `0036_invoice_account_codes`.

**What was resolved in Prod's favour, and why it is better than what I had:**
- **`0037`'s policy half is gone entirely.** I had made it *conditional* (gate the chart if
  nobody has). Prod **deleted** the `can_read_accounts()`/`can_write_accounts()` pair and the four
  policies outright, because `0036_invoice_account_codes` already gates `gl_accounts` with
  identical role lists across all six payable tables. Two names for one rule is the duplication
  this repo argues against, and a conditional block would have left both helpers in the schema.
- **`push.ts` keeps Prod's shape and comments** — the unaliased embeds matching its select, and
  the two-charts explanation (`invoice_lines.account_code` is the *MYOB* code a bookkeeper reads;
  only `gl_accounts.xero_account_code` travels). It also carries an insight mine lacked: a line
  coded to a bare account has **no item row to travel through**, which is why the line tier
  cannot be skipped.


## Previously: two branches reconciled, both merged
2026-08-25. `claude/invoice-item-code-selection-vlwwb4` (account codes on an invoice) and
`claude/code-review-requirements-ns6bav` (run sequencing + Xero codes) were built the same
afternoon, both applied migrations to `laundrymart-syd`, and **both gated `gl_accounts`**.
CLAUDE.md's newest changelog entry, §3, §7, §27 and §28 have the whole of it.

**They could not both merge as they stood** — every migration on a fresh Postgres 16, in filename
order, failed with `42710: policy "gl_accounts_read" already exists`. CI's DB job does exactly
that. Resolved by keeping **0036's** gate (`can_read_purchases`/`can_write_purchases`, six payable
tables) and dropping 0037's (`can_read_accounts`/`can_write_accounts`, `gl_accounts` alone,
**identical role lists**). 0037 now asserts against 0036's gate rather than creating its own.

**The Xero push takes theirs and generalises it.** Two charts, not one:
`invoice_lines.account_code` is the MYOB code the bookkeeper reads; `gl_accounts.xero_account_code`
is what Xero calls that account. Only the second travels — Xero refuses a code its chart lacks.
Their path was `line → item → account`, which misses a line coded straight to an account; 0036's
`invoice_lines.gl_account_id` is set either way, so it is read first with the item as fallback.

**A live regression was found on the way**: `0036_run_sequence_control` was applied to the hosted
project with its code unmerged, so the database refused a **dispatcher** reordering a stop while
the deployed screen still offered it. Merging the branch is the fix.

**Live ledger carries three of today's migrations**, two of them numbered 0036
(`0036_invoice_account_codes`, `0036_run_sequence_control`, `0037_account_and_item_codes`) — the
same situation §7 records for the two 0017s. Filename order matches apply order, so nothing needs
renumbering.

- 431 pgTAP assertions across 24 proofs; `verify` green; whole suite + seed on a fresh Postgres 16.
- `run-db-tests.sh` now fails on `not ok` and on a plan mismatch — it used to trust psql's exit
  code, which is 0 for a file full of failed assertions.

---

## Previous: account codes on an invoice line
2026-08-25, branch `claude/invoice-item-code-selection-vlwwb4`. CLAUDE.md §3, §7, **§27** and the
newest changelog entry have it. One migration (`0036_invoice_account_codes`) — **no new table, no
new role, no new capability, nothing dropped, no row changed**.

The client sent their MYOB chart of accounts (268 accounts, 24 income) and asked for an invoice
line added **by item or by code**, with anything in neither list written as free text.

**Three ways to fill one line, not three kinds of line.** Whichever route is taken the row is the
same shape, so there is no `line_kind` column and a month-end line is indistinguishable from a
typed one. `items.income_account_id` is the bridge (MYOB's "Income Account for Tracking Sales");
`invoice_lines.gl_account_id` + `account_code` carry it — the link for joins, the text for history,
kept coherent by `sync_invoice_line_account()`, which **derives the code and never accepts one**.
An uncoded line is legal and **counted on the invoice**, never refused: the free-text line is what
the client explicitly asked for.

**Xero has been ready since 0026 and was never fed.** `buildInvoicePayload` has mapped
`account_code` → `AccountCode` from the day it was written and nothing selected the column, so
**every line this app has pushed landed in Xero's default sales account**. One word in one select.

**The migration's first part is a security fix, and it is why it shipped with the feature.** All
six payable tables (`gl_accounts`, `suppliers`, `supplier_bills`, `purchase_orders`,
`supplier_payments`, `import_activation_state`) carried one permissive `for all … using
is_member(tenant_id)` policy from `apply_tenant_policy`. Probed live as one of Adelaide's own
**board** logins: **268 accounts** (owner's equity, drawings, every vehicle loan), **192 suppliers**,
**1,515 bills** worth $65,724 — and an UPDATE renaming `4-1600 Laundry` **succeeded**. A delivery
round could rewrite the chart of accounts. Same shape as 0006/`invoices`, 0018/`laundry_prices`:
**the third time**, hidden because the demo tenant has none of this data so the 2026-08-20 board
sweep read 0. **An empty table is not a proof.** Now `can_read_purchases()`/`can_write_purchases()`,
`for all` **replaced** (its USING half grants SELECT — the 0033 trap).

### Where it stands
- 765 unit tests (was 739), **382 pgTAP assertions** (was 368), `verify` green, all 36 migrations
  applied to a fresh Postgres 16 with the suite and the seed. All 14 new assertions **confirmed to
  fail without 0036**, the write hole included.
- Gallery: composer in three states, 24 combinations measured — 0 console errors, 0 overflow inside
  it, 0 targets under 36px. Document overflow byte-identical to the recorded baseline. 26
  interaction assertions drive every route.

### Applied live on 2026-08-25, and merged
**`0036` is the ledger's last entry** (`20260825114025`). Rehearsed in three aborted transactions,
then read back as real sessions: `board1@ats.example.com` went **268 / 192 / 1,515 / 1 / 62 / 636 →
0 of each**, its rename touched 0 rows, its own run and jobs untouched. Counter 0, driver 0. `jay@`
still reads 268 and 1,515 and its importer-style insert **landed**. Every count unchanged.

**The apply found a defect in the migration and the advisors caught it.** 18 → **21**: two expected
helpers plus `sync_invoice_line_account` on `/rest/v1/rpc/`. The revoke said `from public, anon` —
**enough locally, not on Supabase**, which hands each new function a *direct* `authenticated` grant
that revoking PUBLIC does not touch. Only matters for a SECURITY DEFINER trigger function, which is
what 0019 recorded for `guard_last_platform_admin`. Fixed live within the hour; advisors → **20**.

Three follow-ups, and the middle one is the durable win:
- `0036` now revokes from `public, anon, **authenticated**` with a fifth self-assertion naming it.
- **`pg-bootstrap.sql` mirrors Supabase's *function* default privileges**, so that assertion is
  real rather than vacuous — proved by reverting the word and watching it fail. 0029's lesson one
  object class over: *the local harness was reproducing a friendlier database than the real one.*
- **CLAUDE.md's claim that `sync_laundry_item_type`'s EXECUTE is revoked was false** and is
  corrected. It is not revoked; it is SECURITY INVOKER, which is what keeps it off the advisor
  list. Right observation, wrong reason — and the wrong reason is what made 0036's revoke look fine.

### Next, and it needs a browser
1. Set an income account on a few items, add a line each way on a draft, read the PDF.
2. Push one invoice to Xero and check `AccountCode` arrives — **first time that field is populated**.
3. **Adelaide holds 268 accounts and zero items**, so the composer opens on the account code there.
   The item master still waits on the MYOB import (§25).

### Traps this session re-learned
- A gallery measurement reported a **clean sweep vacuously**: `next start` failed with
  `EADDRINUSE`, the old build kept serving, `getElementById` returned null and the loop
  `continue`d. Check the element exists before trusting a zero. **The pgTAP assertion above failed
  the same way for a different reason** — twice in one session, so treat a passing new assertion as
  unproven until it has been seen to fail.
- `searchAccounts` first ranked revenue *within* a tier, so `5-1000 Towel Purchases` (name starts
  with "towel") beat `4-1000 Sales of Towels` (merely contains it) — the wrong side of the books
  answering a sales question. Revenue is a whole tier ahead now; an exact code still wins outright.

---

## Previous: usable by somebody who has been shown it once

---

## Latest: 0036 and 0037 are live on `laundrymart-syd`
2026-08-25. Both applied and verified by read-back. CLAUDE.md §11 has the full record.

**The pre-flight turned up a collision, and it changed what 0037 could be.** A third `0036` —
`0036_invoice_account_codes`, from a branch not in this repo — was applied to the project the
same day and had already done most of our 0037's policy work: `can_read_purchases()` /
`can_write_purchases()` with **the same two role lists** as our `can_*_accounts()`, the identical
four-policy rewrite of `gl_accounts` (same policy names), and `items.income_account_id`. It also
added `invoice_lines.gl_account_id` + `account_code` with a `sync_invoice_line_account` trigger.
- So our 0037 went on **reconciled**: only the four Xero-code columns
  (`gl_accounts.xero_account_code`, `items.xero_item_code`, `xero_connections.sales_account_code`
  /`_name`) and the re-created `xero_connection_status()`. Re-running the policy half would have
  failed 42710, and forcing it would have left `gl_accounts` gated differently from the five
  sibling tables that branch gates the same way. **The repo file is unchanged and still right for
  a fresh database**; the ledger entry records the difference. Same shape as the 0018 convergence.

**⚠️ Open, and the owner's call: two answers to "what account is this invoice line coded to".**
That branch snapshots `invoice_lines.account_code` at write time via a trigger. Our `push.ts`
ignores that column and resolves the code at push time from
`invoice_lines.item_id → items.income_account_id → gl_accounts.xero_account_code`. Both are now
live. If a bookkeeper codes a line explicitly, our push would send the *item's* code instead —
so this wants deciding before the first real Xero push, and it is a small fix either way
(prefer `invoice_lines.account_code` when present, fall back to the item).

**Verified live, as real sessions in rolled-back transactions:**
- **0036** — board and dispatcher, both of which can *see* the run, refused 42501 with the
  sentence; both refused the unlock. A driver was **lent a stop** inside the rolled-back
  transaction (no ordinary driver login on this deployment can see one, so probing without that
  proves RLS filtering, not the guard) and, seeing the row, was refused identically. Office
  manager saved a real order, version 1 → 2. Moving a worked stop refused. Stale session got the
  concurrency sentence. After: 11 runs locked at v1, both guards attached, **0 duplicate
  positions**, all counts unchanged (16 stops / 8 jobs / 647 invoices / 20 memberships / 5 boards
  / 508 archived customers).
- **0037** — **0** accounts and **0** items carry a Xero code, so every invoice pushes exactly
  the payload it pushed before. `xero_connection_status()` returns 8 columns now; `authenticated`
  still cannot read `xero_connections`. Owner and office manager can **add an account**; driver,
  board and counter refused 42501.
- **Advisors 18 → 22** (+2 ours, +2 that branch's). Our two trigger functions are correctly
  **absent** — EXECUTE revoked, the 0019 trap avoided. 0 anon table grants, 0 anon functions,
  0 tables without RLS.

**Two data facts worth knowing before trying it:** the chart of accounts (268 rows) is
**Adelaide's**, which has **no items**; the six items are **Harbour's**, which has **no
accounts**. And all **647 invoices carry 0 invoice_lines** (import headers), so there is nothing
yet for the line coding to act on.

## Previously: the Owner keeps the codes, and the codes reach Xero
2026-08-25, same branch. One migration (`0037`), **no new table, no dropped column, no row
changed, no new capability**. CLAUDE.md §20 and §25 hold the design; §3, §7, §11 and the newest
changelog entry the rest.

Three asks, and each had a defect behind it.

**1. The three plan-count mismatches are fixed — and the reason they hid is the real finding.**
`boards_scope` 20→23, `item_master` 16→17, `main_flow_scope` 29→27. None was failing;
`main_flow_scope` genuinely contains 27 and claimed 29, so nothing was skipped.
- **`run-db-tests.sh` trusted `psql`'s exit code, and `psql` exits 0 for a pgTAP file that runs
  to completion.** A failed assertion is a *result row* (`not ok 7 - …`), not an error — so **CI
  would have gone green over a security proof that had started failing.** The runner now fails
  on `not ok`, on "Looks like you failed" and on a plan mismatch. All three were proved to fail
  the run by deliberately breaking a proof, not assumed.

**2. Chart of accounts: the Owner can add to it, and before this everybody could rewrite it.**
`/accounts` had been read-only since the MYOB import ("appears here once it is imported…"), with
no create action anywhere in `src/`. Underneath, 0021's `apply_tenant_policy` left one permissive
`for all` policy, so **every member could read and rewrite the chart off PostgREST** — proved on a
0001–0036 database: a driver read the balances, renamed an account, zeroed it and inserted one.
`current_balance` is on that table.
- `for all` **dropped and replaced** by four explicit policies (its USING half grants SELECT —
  the 0033 trap, third table).
- **No new capability**: `purchases.read`/`purchases.write`, which `/accounts` was already gated
  on. Auditor reads and does not write, hence two helper functions.
- New: `/accounts` create form, `/accounts/[id]` edit page, `accounts_scope.test.sql` (19).

**3. Xero: nothing this app knew had ever reached it as a code.**
`buildInvoicePayload` mapped `line.account_code` → `AccountCode` since 0026 and **nothing ever
populated it** — `push.ts` selected four columns and stopped. Every pushed line landed uncoded;
no `ItemCode` either.
- Codes now travel `invoice_lines.item_id → items.income_account_id → gl_accounts.xero_account_code`
  (+ `items.xero_item_code`), with `xero_connections.sales_account_code` as the fallback for the
  many lines carrying **no item** (fuel levy, contract minimum, consolidated laundry charge).
- **The Xero codes are separate fields from ours, deliberately.** Xero refuses an invoice naming
  a code its chart/inventory lacks, so defaulting to `items.item_code` would turn one mismatch
  into *every* invoice failing. Blank omits the key → a laundry that fills none of this in
  pushes exactly yesterday's payload. That is the first assertion in the payload tests.
- Resolved at **push time**, not snapshotted: a code is a classification, not money, so a
  corrected code should be sent on Retry. The amount is what `job_charge_snapshots` freezes.

**Verified:** 766 unit tests (was 755), **417 pgTAP assertions (was 398)**, `verify` green, all
37 migrations against a fresh Postgres 16 with the seed on top, every pre-existing proof
unchanged. Both new PostgREST embeds checked for ambiguity — exactly one FK per hop.

**NOT applied to `laundrymart-syd`** — no credentials here. **0037 first**: until it lands, the
new Accounts screen offers an Owner a create form whose refusals are not enforced underneath, and
the chart stays readable and writable by every member.

## Previously: the run is locked, and only the office may change its order
2026-08-25, branch `claude/code-review-requirements-ns6bav`. The client's controlled-sequencing
requirement. CLAUDE.md **§27** holds the design; §3, §4, §7, §11 and the newest changelog entry
have the rest. **One migration (`0036`), no new table, nothing dropped, no existing row
invalidated** — every column's default describes what was already true.

**The headline: the security boundary did not exist.** The reorder was gated on `routes.write`,
while `jobs` sits on `/rest/v1/jobs` under a single permissive `for all` policy — so **a driver
could PATCH `jobs.sequence` on the run they were standing in**. Reproduced against a 0001–0035
database rather than reasoned about: `UPDATE 1`, a real row changed.

**What changed, in five pieces:**
- `routes.sequence` — a new capability, `super_admin` + `operations_manager` only. `routes.write`
  was the wrong authority (dispatcher, branch_manager, regional_manager hold it). Named in a
  `RUN_SEQUENCE` block and **subtracted** from the `TENANT_ALL`-derived roles — the leak trap
  this repo has now recorded three times.
- `guard_job_sequence` — a trigger, not a restrictive policy. The rule is about *one column*
  (a driver must still write `progress_status`), and a restrictive policy writes **zero rows in
  silence** where a trigger raises 42501. UPDATE-only, so assignment (an INSERT appended at the
  end) still works for the roles that assign but do not order.
- `guard_run_sequence_control` — found by probing: a board/driver may update their **own** run
  row, so without this they could set `sequence_locked = false` and walk past the first guard.
- `apply_run_sequence()` — Save & Lock in one transaction. Re-resolves the run from
  (tenant, board, date) rather than trusting a posted id, compare-and-swaps `sequence_version`,
  writes 1..n in one statement. SECURITY **INVOKER**, so RLS + both guards still apply.
- `compact_run_sequence()` — closes the gap `retireStopIfEmpty` used to leave (a run that lost
  its second call read 1, 3, 4). SECURITY DEFINER, safe **by construction**: it takes no order
  from its caller, so it can only close a gap, never undo a management decision.

**Two design calls worth not re-litigating:**
- **Editing is never persisted.** §6 of the requirement says Cancel writes nothing, which settles
  it — entering edit mode cannot write either, or Cancel would have to write it back.
  `sequence_locked` is the standing statement that the order is management's, read by the guard;
  it is not a mutex and nothing flips it.
- **Concurrency is `sequence_version`, not `updated_at`** — that column moves for status changes
  and load confirmation, which would refuse saves over edits that never touched the order. The
  day's token is the **highest** version across the board+date's runs, swapped on `<= expected`,
  so a run opened after the last save joins the token instead of deadlocking.

`applyDispatchPlan` moved to the same capability: the unlinked planner writes `jobs.sequence` too
and would have been a live bypass of the screen next door.

**Verified:** 755 unit tests (was 739), **398 pgTAP assertions (was 368)**, `verify` green, all
36 migrations against a fresh Postgres 16 with the seed on top, and **every pre-existing proof
passes unchanged** — the check that mattered, since the new trigger sits on a table five of them
own. The lock→edit→cancel cycle was driven in a real browser: 26 interaction assertions at
390/768/1440, light and dark, 0 console errors, 0 overflow.

**Recorded, not fixed (pre-existing, identical without 0036):** three proofs declare a `plan(N)`
that disagrees with what they run — `boards_scope` 20/23, `item_master` 16/17, **`main_flow_scope`
29/27**. Nothing fails, but that last one means two assertions in a security proof are not what
somebody thought. `run-db-tests.sh` does not fail on a plan mismatch, which is why it hid.

**NOT applied to `laundrymart-syd`.** No credentials here. 0036 is the one migration in §7 the
hosted project does not carry, and until it is applied the *screens* are narrowed while the
database still lets a driver rewrite `jobs.sequence`. Apply it, then sign in as
`driver@roles.example.com` (cannot reorder) and `owner@roles.example.com` (can).

## Previously: usable by somebody who has been shown it once
2026-08-24, branch `claude/app-accessibility-all-ages-e7sh41`. CLAUDE.md §6, §10b, §26 and the
newest changelog entry have it. **No migration. No schema, RLS, capability, policy or workflow
change** — every screen still exists, every route still resolves, no role gained or lost anything.

The owner's brief: a ten-year-old and a seventy-year-old who only knows how to turn on a laptop
must both be able to use this. Four specialist reviews first (UX, accessibility, business
analysis, frontend architecture) against `.claude/skills/`, then the work the evidence pointed at.

**The lever: one CSS rule makes the whole app bigger.** Every size here is `rem` — Tailwind 4's
`--spacing` is `0.25rem`, its type scale is rem, `body` is rem — so moving the *root* font size
scales text, padding, gaps, control heights and the rail's width together. `html[data-text-size]`
in `globals.css` is three lines and is a genuine zoom. Measured: root 16 → 18.4 → 20.8px, body
15 → 17.3 → 19.5px, smallest control 44 → 51 → 57px.
- `normal` deliberately sets **nothing**, so a browser-level preference is respected not overruled.
- It must be on `<html>` — `rem` resolves against the root element only — so it rides
  `localStorage` + the root layout's pre-paint script beside the theme, **not** the cookie pattern
  the rail's collapsed state uses (that applies to a wrapper, which would scale nothing).
- Media-query `rem` resolves against the browser's initial size, so breakpoints do not shift.

**The second lever: "What do you want to do?"** — `lib/quick-actions.ts`, seven jobs as verbs,
capability-filtered, first on the dashboard. **Not the simple mode §19 records as rejected**: no
mode flag, nothing hidden, no rail row moved, and the standing "a second list drifts from
`nav.ts`" objection is answered by a test asserting every href is a real `NAVIGATION` destination.

The control appears in the header, on the home screen, and **on the sign-in page** — the last
because somebody who cannot read the login screen cannot sign in to reach the other two.

**Also done:** `firstIssue` stopped printing the Zod path (112 call sites — the toast said
`expected_delivery_date: Invalid input`); `describeDbError` stopped relaying raw Postgres; both
rules moved to `lib/messages.ts` (testable — `lib/actions.ts` imports `next/headers`). Toasts no
longer self-destruct after 5s. `CONTROL` and five other sites stopped killing the focus ring.
`Field` wires `aria-describedby`/`aria-invalid`. Rail rows renamed **Customer laundry** /
**Driver visits** (both rows kept, per §6). Eleven trade-term eyebrows dropped. "Danger zone" →
"Hide this customer" with a confirm. `counted()` retired `invoice(s)`. Help page rewritten around
the delivery round. Stale "this app does not connect to Xero" copy fixed.

**A code review then caught two things the tests did not.** `validationMessage` was a *denylist*
of Zod's known wordings, so `z.enum()` and a bare `.min()` still reached a counter as
`Invalid option: expected one of "van"|"truck"` and `Too small: expected number to be >=1950`. It
now builds from the issue's structured fields and lets a message through only past a machine-text
guard — safe by construction, like `databaseMessage`. And the rail rename never reached the pages:
`/orders` was still titled "Jobs". Both now have tests; the nav one reads the page sources, since
a `page.tsx` cannot be imported into a unit test.

**Three contrast failures were computed and fixed at the token layer.** `--control-border` is new
(an input's border was 1.42:1 against its own fill, where 1.4.11 asks 3:1) and is used by
`CONTROL` and the checkbox only — `--strong` is untouched because its other 60 call sites are
decorative rules. `--muted-foreground` failed AA in dark on a sunken panel (4.45:1) and now clears
AAA in both themes. The dark danger badge was 4.45:1 on the word "Overdue".

691 unit tests (was 621), `verify` green. Gallery asserted light+dark × 3 text sizes ×
320/390/768/1440 — **zero console errors, zero card overflow, sub-36px targets 79 → 0**, and 69
controls measured at 3.21:1 (light) / 3.01:1 (dark) as rendered.

## Then tidied, same day, on the owner's feedback
The side panel wanted collapsing section by section and the whole app read as oversized.
- **Rail is three collapsible groups** — "Day to day" open, "Customers & money" and "Set-up &
  reports" shut, Help pinned outside. 12 flat rows → 6 visible. Softens §6's "no headings" and
  says so; screens inside an area are still tabs, never rail rows. `navigationFor()` stays flat
  and `groupNavigation()` only *draws* it, so `sectionFor` and every existing test are untouched.
  An unnamed area falls through rather than vanishing; the group you are in always draws open;
  shut groups ride an `es_nav` cookie read in the layout (the `es_rail` pattern).
- **Type scale back down.** Labels 14px, hints 12px, tokens 12/11px, toast 14px. Two exceptions:
  a field error stays 13px medium/danger, and `CONTROL` is `text-base sm:text-sm` — 16px on a
  phone (under 16px iOS zooms on focus), 14px on desktop (16px inputs read larger than the 15px
  body, which was most of the "too big"). The argument for a tidy default is that the
  reading-comfort control now exists.
- Headings are **sentence case**: uppercase tracked labels are what the 2026-08-13 redesign swept
  out of 28 files, and §10b names `Eyebrow`'s 12px sentence case as the supporting-label voice.
- 698 unit tests (was 691), `verify` green, re-measured clean at all sizes; control border still
  3.21:1 / 3.01:1.

## Then four questions the owner answered, same day
Asked rather than assumed — each was theirs, and three could not be done safely in `src/` alone.
CLAUDE.md §3, §7, §11, §22, §24, §26 and the newest changelog entry have it. **Two migrations
(`0034`, `0035`)**, no new table/column/function/capability, no row changed by either.

- **The counter takes laundry in again** (§26, now closed). `customer_service` holds
  `orders.read/write/status` again — the alternative was making a counter hand an **Office
  manager**: 31 screens to do the one job their role is named for. Now ~11.
  **`roles.ts` alone would have been a silent bug**: 0025's *restrictive* write policies are the
  real boundary, so the capability without the policy is Save writing **zero rows with no error**
  — the failure 0025 hit for the driver and 0031 for the board, `lives_ok` passing both times.
  `0034` widens three tables (`laundry_orders` + items + activity) and **only** those three;
  billing and the price list are untouched and the migration asserts that by name. No
  `orders.manage`, and no DELETE on the job — only on its items, which
  `save_laundry_order_items()` (SECURITY INVOKER) needs to replace the child set.
  `main_flow_scope.test.sql` 18 → 29 assertions, each checking the write **landed**.
- **The activity log narrowed** (`0035`). `audit_logs` was 0001's `for all … using is_member`, so
  a driver, a board and the counter read the whole tenant's trail. SELECT → the four `admin.read`
  roles (auditor among them — that is why it is a role list, not `admin.write`). **INSERT stays
  open to every member**: `recordAudit()` runs on the caller's own client, so narrowing it would
  stop the log recording the people it exists to record; `actor_id` is pinned to `auth.uid()`.
  **No UPDATE/DELETE policy at all** → append-only. The `for all` is *dropped*, not supplemented,
  because its USING half grants SELECT (the 0033 trap). New `audit_log_scope.test.sql`, 11
  assertions, all by outcome.
- **§22 said something the database does not do.** It claimed the agreement header is readable
  "to `agreements.read`"; `service_agreements` is `for all … using is_member`, so any member reads
  every header. The decision is sound (a header carries no price) — the **wording** was corrected,
  the policy deliberately not narrowed.
- **Adelaide's four boards have logins.** `board1@`…`board4@ats.example.com`, written by SQL in
  GoTrue's shape (§3a) because this deployment still cannot send an invitation. Boards linked
  **1 of 5 → 5 of 5**, so `LJ00003`/`LJ00004` are no longer on rounds nobody can sign in as.
  Password is a bootstrap, in **no committed file**, and wants replacing once SMTP works.

700 unit tests (was 698), **368 pgTAP assertions (was 348)**, `verify` green, all 35 migrations
against a fresh Postgres 16. Both new proofs were confirmed to **fail without their migration**.

## Then: auth emails moved onto Resend, so no SMTP is needed
The owner's instruction, and it closes the longest-standing open item in the file. CLAUDE.md §10,
§10c, §24 and the newest changelog entry have it. **No migration; no schema, RLS, capability,
policy or workflow change** — one sender replaces another.

**The project had never sent a single auth email and had been saying otherwise.** Invitations used
`inviteUserByEmail`, sign-in links used `signInWithOtp`; both ask **Supabase's built-in mailer**,
which needs custom SMTP nobody configured. Baseline read off the live database first: **0
`auth.one_time_tokens`, 0 `auth.flow_state`, `confirmation_sent_at`/`recovery_sent_at`/`invited_at`
NULL on all 18 logins, 15 of 18 never signed in.** Meanwhile invoices and customer mail have gone
through **Resend** the whole time — a working sender and a broken one, with the auth mail on the
broken one.

- **`generateLink()` is the seam.** It mints a link and **sends nothing**; the app then posts the
  email through `sendEmail()`. That is `ysm-hub`'s arrangement — everything it sends goes through
  `resend.emails.send()` and Supabase delivers none of it.
- **The link points at this app** (`<origin>/auth/invite?token_hash=…`), not at Supabase's
  `/auth/v1/verify`. That removes the §10c deployment step: the project no longer has to list this
  origin under its allowed redirect URLs, so a preview deployment works with zero configuration.
- **A sign-in link is a `recovery` link.** It is the one type that signs a person in *and* lets
  them set a password — what "No password, or forgotten it?" already promised — and it cannot
  create an account, so a typo still cannot mint an orphan login.
- **A refused send deletes the login it just made.** Minting an invite link *creates* the user, and
  leaving a half-made one would make the retry answer "they already have a login" — the one thing
  that stops the admin sending the mail that never went. Provider is checked *before* the mint too.
- **"Email sign-in link" is new on every People row** — the missing rung between changing a role
  and removing access. It is how the four board logins stop sharing one bootstrap password.
- **The anti-enumeration rule is unchanged**, only its vocabulary moved. `classifyLinkError`
  **defaults to "about this address"**, so an unrecognised refusal is hidden rather than becoming
  an oracle; `inviteFailureMessage` is the admin-facing half that is allowed to say more.
- `INVOICE_FROM_EMAIL` is the sender for auth mail too and was deliberately **not** renamed —
  a rename takes a live deployment's mail down on redeploy, for tidiness.

739 unit tests (was 700), `verify` green. Both callers derive the origin from `Host` via one
tested rule — the sign-in form used to read the optional `Origin` header, which would have failed
confusingly the first time somebody asked for a link. `/auth/invite` and `/login` are outside the auth gate so
they could actually be rendered: **72 combinations** (2 themes × 3 text sizes × 4 widths × 3 pages)
with **0 overflow and 0 sub-36px targets**, headings confirmed as "You have been invited" and
"Choose a new password". The 48 console errors are all `ERR_TUNNEL_CONNECTION_FAILED` from the
invite screen calling the *placeholder* Supabase URL the local build uses — `/login` has none.

**Every live login can be sent one today** — checked, not assumed: all 18 are confirmed, unbanned,
not soft-deleted, non-SSO and have a real address, so `generateLink({type:"recovery"})` has a user
to work with for all of them (the four boards included).

**Nothing has been sent yet.** No Resend key and no service key here. **Before trusting it: invite
one real address on `ats.coreit.com.au`, follow the link, then check the counters moved** —
`auth.one_time_tokens` should stop being 0. **Merged to `Dev` and `Prod` (`abbeafa`), CI green on
all three jobs for both.**

## Verified against the live project (2026-08-24)
The accessibility and tidy-up work added **no migration**; the four fixes above added two, both
now applied (§11). Checked at the first pass: advisors **18** (unchanged — no function added), **0** `anon` table grants, **0**
tables without RLS, and 647 invoices / 508 archived customers / 16 memberships / 5 boards / 9
prices exactly as recorded. `FIELD_LABELS`' 79 keys were checked against `information_schema`:
76 are real columns, and the three that are not (`default_gst_rate`, `received_date`,
`return_board`) are real form-only fields. **Merged to `Dev` and `Prod`** — both were clean
fast-forwards, and Dev absorbed the 18-commit backlog the changelog kept recording as stale.

## What the live read-back turned up — the owner's to act on
- **The real laundry has been used since the cutover.** Adelaide now has four jobs; `LJ00002` was
  completed, **priced and approved** (the first frozen charge snapshot on the project). But
  `invoice_source_jobs` is 0 and no invoice exists since 20 August — so it is sitting in the
  billing queue and **the month-end roll-up is still the one money step never run end to end**.
- **The month-end run was rehearsed read-only, and that is the finding.** It works — and pressing
  "last month's invoices" *today* answers **nothing to invoice**, because the default period is the
  previous month (1–31 July) and `LJ00002` completed on **20 August**. That reads as *everything is
  billed*, not as *wrong month*. **Set the period to August, or run it in September.** The default
  is right for the ordinary case; the trap is that the first real run is mid-month against a job
  from the current one.
- **Adelaide's four boards now have logins** (fixed, §24) — but it still has **no member who is not
  a platform admin**, and its price list is still empty, so `LJ00002` was priced by hand.

## Do these next
- **Reconcile the two `0036`s when that branch merges.** Half done: `0037` is now
  order-independent, so neither order breaks and the chart ends gated exactly once. What is left
  is repo hygiene at merge time — two migrations numbered 0036, and a duplicate helper pair
  (`can_*_accounts` vs `can_*_purchases`, identical role lists) to renumber and collapse. The
  same job §7 records for the two 0017s and the two 0015s. **Nothing to do until that branch
  lands** — the duplication does not exist yet in either place.
- **Push one real invoice to Xero.** The coding ladder has never run against real data: this
  deployment has no `XERO_CLIENT_ID`, 0 `xero_connections`, and all 647 invoices carry **0
  lines** (import headers). Needs a connected organisation and one invoice with lines on it.
- **Open the screens with real rows.** Both migrations are verified at the database level; no
  authenticated page has been rendered against them. Sign in as `owner@roles.example.com`:
  Adjust Run → Save & Lock Run on a real board, and add one account at `/accounts`.
- **Open it with real rows in it.** This container has no Supabase credentials, so no
  authenticated screen was rendered. Sign in as `owner@roles.example.com`, press each card on the
  home screen, and set the text to Biggest on a phone.
- **Change the board password.** `board1@`…`board4@ats.example.com` share one bootstrap password
  (in no committed file — it was reported in chat). **You can now do this**: press *Email sign-in
  link* beside each board on `/admin/users` and let each round set its own.
- **Set `RESEND_API_KEY` and `INVOICE_FROM_EMAIL` on the deployment if they are not already.**
  Every auth email now depends on them; without them each action says so by name rather than
  claiming a success that did not happen.
- **Sign in as the counter and take a job in.** `customer_service` got `orders.*` back and 0034
  widened the policy; the write was proved to land against live rows, but no *screen* has been
  opened as that role.
- Still from the previous session: run the month for Adelaide (**period = August**); invite a real
  person into Adelaide; enter Adelaide's own prices.

## Still open (unchanged from the previous session)
- **`LJ00001`** — Adelaide job, Harbour customer, still `ready_for_delivery`. Remedy is
  cancellation, which is terminal; the owner's call.
- **`service_agreements` is `for all … using is_member(tenant_id)`**, so any operational login
  reads every contract header. Decided 2026-08-24: **left as it is** — a header carries no price,
  and only §22's wording was wrong. `audit_logs` was the other half of that finding and **was**
  narrowed (0035).
- **§23 sweep:** ~345 of 451 `.from(...)` reads still rely on RLS alone; correct for eleven of
  twelve roles, but a platform admin's session spans two laundries.
- **Nothing has talked to Xero yet** (`XERO_CLIENT_ID`/`SECRET` unset by the owner's decision).
- **Auth email now goes through Resend, not Supabase** (2026-08-24), so no SMTP is needed — but
  **it has not been exercised against the provider yet**, and it needs `RESEND_API_KEY` +
  `INVOICE_FROM_EMAIL` on the deployment. Until one real invitation has been followed end to end,
  treat this as built rather than proven.
- Database: **0001–0035 applied to `laundrymart-syd`.** Nothing pending.

## Environment readiness
- node v22.22.2, deps installed (`npm install`)
- env missing (copy `.env.example`) — no Supabase credentials here; live work goes through the
  Supabase MCP tools
- `npm run verify` supplies its own build placeholders, so it runs green without env
- Screenshotting the gallery: `npm run build`, then `npx next start -p <port>` **with no other
  server running** (a rebuild under a live server leaves it serving deleted chunks and the CSS
  404s as `text/plain` — check the stylesheet returns 200 before trusting any measurement), then
  Playwright against `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Note `pkill -f
  next-server` matches your own shell's command line; kill by PID from `/proc`.
- Postgres 16 + pgTAP local: `sudo pg_ctlcluster 16 main start`, then
  `sudo -u postgres createdb lm_v && PGDATABASE=lm_v bash scripts/run-db-tests.sh`

Reminders: RLS on every tenant table (tenant_id); admin client must filter tenant_id;
getClaims not getUser; region syd1.
