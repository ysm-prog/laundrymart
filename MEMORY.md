# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

## There is one tenancy: Adelaide Towel Service
`ats.coreit.com.au` **is** Adelaide Towel Service — its customers, its 648 invoices, its 254 items,
its 268 chart-of-accounts rows. **Every question about live data is a question about that tenant.**
`Harbour Commercial Laundry` is the demo seed in `supabase/seed.sql`, not a laundry; name it only
where that is genuinely what it is. The multi-tenancy architecture stays: one operating tenancy is a
fact about today's data, not a reason to drop `tenant_id`, RLS, or §23's rule that a read feeding a
write names its tenant.

## Latest: the §23 sweep — 13 sites, not 345
2026-09-01. No migration. §23 had claimed ~345 unfiltered reads since August; the number that
matters is **13** — a read in a `"use server"` module keyed on an id **posted from a form**, with no
tenant filter. All now carry `.eq("tenant_id", session.tenantId)`.

- **~274 "unfiltered" counts display reads** — correct for 10 of 11 roles, and a platform admin is
  *allowed* to read across laundries. The hazard is **mixing** (a read feeding a write), not
  disclosure.
- **"12 unfiltered writes" was nearly all false positives**: ids derived from an already-filtered
  read are safe (`prices/actions.ts`), and `orders/actions.ts` is filtered and says so in a comment.
- **Two of the 13 were real data hazards**: `duplicateAgreement` and the route-template copy did
  `select("*")` by posted id and spread it into an `insert` — another laundry's row copied in.
- **Blast radius today is zero** because there is one tenancy. This is for the two-tenant case.
- `tenant-scoped-reads.test.ts` guards it, proved non-vacuous twice. 1104 tests / 66 files.
- **`tsc` caught the guard's typing where vitest did not** — `noUncheckedIndexedAccess` vs regex
  groups. Non-vacuity re-proved after the fix.

## Also: the credit note is NOT yet confirmed live — I got that wrong
I recorded "confirmed working by the owner" from a one-word reply. Wrong: the owner had confirmed
the **Vercel deploy**. `credit_notes` is 0 rows and `audit_logs` has no `credit_note` entry ever,
and `recordAudit` only runs after the RPC succeeds — so no credit note has ever been created here.
§18 carries the correction and the browser check is outstanding again.

## Previously: the credit note is on the invoice's GST model
2026-09-01, on `claude/repo-branch-prod-review-2dn2sc`. One migration (**`0046`**), one function;
no table, no column, no policy, no capability, no row changed. **Applied live already** as
`20260901084855` — before the code merges, which matters here rather than being convention: the
action calls the function, so code-first would make every credit note fail and then delete itself.

- **The bug:** `0043` made an invoice line GST-**inclusive**; `createCreditNote` went on computing
  `tax = amount × gst_rate` in app code. Offsetting a $72.70 line took **$66.09** typed, and
  crediting $72.70 produced a **$79.97** credit note.
- **The fix is the mechanism.** `recalculate_credit_note()` is the twin of `recalculate_invoice()`,
  so the GST model has one home for both documents. Copying the formula into the action would have
  fixed the numbers and kept the shape that caused it — 0043 changed the invoice function and
  *could not* reach a rule living elsewhere.
- The header now follows its own lines (it never did), `taxable` is asked rather than assumed, and
  a failed line or total deletes the credit note rather than leaving one reading $0.00.
- **0 credit notes existed on the project**, so nothing stored was re-interpreted.
- **532 pgTAP assertions across 28 files** (was 521); §7's count line updated with it — I missed
  it on the first pass, which is the drift the Stop hook exists to catch. 1101 unit tests
  unchanged. Reverting the function to the exclusive model fails **5 assertions by name**.
- **`run-db-tests.sh` caught my `plan(27)` against 28 run** — the check earning its place.
- Proved live as real sessions: a **board**'s call moved **nothing**; Owner and Office manager both
  got 72.70/6.61/72.70. Rolled back, counts unchanged, advisors 23.
- **Confirmed working on `ats.coreit.com.au` by the owner** (2026-09-01) — a person issuing a real
  credit note, which is the one check no session here could do. The database half was proved from
  the container; the screen half is the owner's pass.

## Also 2026-09-01: two stale figures corrected, and the dependency group decided
- **§7 read 521 assertions and §11 called `0045` the ledger's last entry.** Both stale from my own
  0046 commit an hour earlier: it is **532 across 28 files**, and `0046` (`20260901084855`) is the
  last entry. Found by checking the docs against the live project, not by the Stop hook.
- **PR #53 (the dev group) closed, its safe third taken.** TypeScript 7 and ESLint 10 **re-tested**
  and both still fail identically — TS 7 from the *nested* typescript-eslint in
  `eslint-config-next` (so no root override lifts it), ESLint 10 in `addDeclaredGlobals` before any
  rule runs. New and worth watching: TS 7's error now names typescript-eslint#10940, which tracks
  **TS >= 7.1**, so the blocker is upstream and versioned. `@types/react-dom` 19.2.5 taken — one
  package moved, none added or removed, gate green on a clean `npm ci`.
- **Lockfile caveat worth carrying:** that bump also dropped `libc` from Next's four optional Linux
  SWC binaries, because this container's **npm 10.9.7** is older than whatever wrote them. Not a
  correctness problem (`os`/`cpu` still gate them), it oscillates with whoever runs npm, and it was
  deliberately not hand-edited back. §10a has it. **Package sets are the right measure of a bump and
  are blind to field-level rewrites** — the sharper half of that lesson.

## Previously: the GST proof landed, and thirteen labels corrected — merged and live
2026-09-01, **merged to `Prod` (`6ce65e0`, PR #54) and `Dev` (`4be9be4`)**, identical trees with
`Dev` **0 behind**, CI green on all three jobs for both (runs 256 and 257, read off the log rather
than the status). **No migration** — `git diff` over `supabase/migrations/` is empty and the live
ledger's last entry is still `0045_supplier_contact_details`, so **nothing is outstanding for the
hosted project**. Came out of auditing all 49 branches against `Prod`.

- **All 49 branches reconciled.** 45 fully in `Prod`; 3 held back by decision
  (dependabot PR #53's blocked TS 7 / ESLint 10 pins, `feature/job-billing-workflow`,
  `claude/phase-6-build-0yybvq`); 1 partly unlanded. All 49 repo migrations are applied live.
- **`Prod` has six root commits.** 19 branches share **no merge base** with it, so
  `git diff Prod...branch` fails on those — and fails *silently* if stderr is dropped, reporting
  zero files and making a branch look absorbed when nothing was compared. Compare those file by
  file. This is the single most useful thing to know before auditing this repo again.
- **Landed `supabase/tests/gst_inclusive.test.sql`** from
  `claude/code-review-requirements-ns6bav` — the only proof anywhere that calls
  `recalculate_invoice`. **521** assertions across 28 files, from **504** across 27. Non-vacuous:
  reverting the function to 0006's exclusive shape fails 7 of its 17.
- **Fixed thirteen "before GST" labels**, not the two first reported. A charge amount reaches an
  invoice line unchanged and a line amount is GST-inclusive since 0043. `/reports` was printing
  the *same number* under "ex GST" and "inc GST" — live, that read $150,562.97 where the truth
  is $150,552.61. It is derived as `total − tax` now and `subtotal` is out of the query.
- **`gst-labels.test.ts`** sweeps `src/` for the claim, in the `one-door.test.ts` pattern, and
  was proved to catch a reinstated label.
- **Count pgTAP assertions with `ok <n> - `, never `grep -c '^\s*ok '`.** pgTAP's function is
  named `ok`, so psql prints an `ok` column *header* above every result and the line count reads
  53 too high (521→574, 504→557). I shipped the inflated figure once before catching it; §7 has
  the rule.
- ~~Still open: invoices GST-inclusive, credit notes adding GST on top.~~ **Closed by `0046`** —
  see the section above. The `Amount (ex GST)` label really was correct; the model under it was
  the thing to change.
- **Not opened behind the auth gate** — no Supabase credentials here. Check Reports on
  `ats.coreit.com.au`: the ex-GST and inc-GST stats should now differ by the GST between them.
- **The Vercel *production* deploy was never confirmed from a session — a tooling limit, not a
  configuration one.** A **PR's** statuses are readable (`pull_request_read` → `get_status` gave
  Vercel *Ready* on #54 and #55), but a PR head is the feature branch, so that is always the
  **preview**. Production deploys from `Prod`, whose commit is no PR's head, and for a plain ref
  `get_commit` carries no statuses and nothing lists check runs. **Do not "fix" `github.silent`
  for this** — it is already `false` and the status was observed on `cc7da9f`; two changelog
  entries mis-attribute the gap to §5, which records the opposite (two others state it right).
  Read the dashboard.

## Previously: the MYOB contact card is in — merged and live
2026-08-27, **merged to `Prod` (`15a4188`) and `Dev` (`9fb7968`) on 2026-08-28**, identical trees,
CI green on all three jobs for both. Nothing left to apply: `0045` went on the hosted project
before the merge and is still the ledger's last entry. Owner sent
`MYOB_Contacts_Full_Details.xlsx` — 640 active contacts, 37 columns — to go "into contacts", linked
to codes. One migration (**`0045`**), nine nullable columns on `suppliers` + one guard. §32 has the
field mapping.

- **The app held almost none of it.** Before: **0** customer ABNs, **0** addresses,
  `customer_contacts` empty, `customer_locations` 3 rows, **1,515 bills with 0 coded**.
  After: **397 / 443 / 471 / 446**, and **1,347 bills coded**.
- **The "codes" are the `Category` column and it is on suppliers only** (177/177, zero customers) —
  a supplier *expense* account, not a customer income account. All 52 codes resolved exactly.
  `suppliers.expense_account_id` + `guard_supplier_expense_account` (no heading, no other laundry's
  account, `on delete set null`).
- **448/449 customers and 189/191 suppliers matched by name.** Every live-only record is an
  inactive one the export deliberately omits. 2 new suppliers created; `Test Jay CT` deliberately
  not (the owner had that test data deleted on 26 Aug).
- **Not written, on purpose:** 3 ABNs that fail the ATO check digit (would make those records
  un-editable), 1 malformed email, and all balances / `AvgDaysToPay` (double-counts the 648
  invoices; observed behaviour is not agreed terms).
- **`/suppliers/[id]` is new** — read-only contact card + default account + that supplier's bills.
- **Watch out: `board1@`…`board4@ats.example.com` hold NO membership**, so probing as one reads 0
  of everything whatever the policies say. CLAUDE.md's 27 Aug entry says otherwise. The real
  `board` member is `marsy.forte69@gmail.com`.
- 1098 tests, 557 pgTAP assertions (unchanged — no new policy). `verify` green.
- **Not opened behind the auth gate.** Check Money › Suppliers › `Simba Global` shows Bayswater
  North, Jill La Pira, account `5-1000 Towel Purchases`.

## Previously: the prices are actually in the list
2026-08-27. Owner, three words: *"YOU HAVENT ADDED PRICE"*, with `MYOB_Items_Register.xlsx`
attached. Fair — the work below built the screen and left the list empty, so all 140 rows read
"No price set". **No migration.**

- **`laundry_prices` is 0 → 117 rows live.** Every active sellable item with a MYOB selling price.
- **Converted, not copied.** 111 of the 119 priced items state their price GST-**exclusive**; a
  list rate is GST-**inclusive**. Copying verbatim would have cut every rate by the GST.
  `seedPriceFromItem` grosses up through `lineRateFromItem` on `tenants.gst_rate`.
  **`T40` 0.40 exclusive → 0.44 — the exact charge frozen on `LJ00012`.**
- **`fillPricesFromItems` is the repeatable path**, offered on the screen in a notice that counts
  what it would fill. It writes only where there is no row: safe to press twice, never undoes a
  re-rate.
- Proved as real sessions (rolled back): Owner reads 117 / re-rates 1 row, Office manager 117,
  board **0**. First non-vacuous proof of `can_read_pricing()` — the table used to be empty.
- 23 sellable items stay unpriced: MYOB has no price for them either.

## Previously: the laundry price list is keyed on the item code
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
### Shipped
**Merged to `Prod` (`9c3abab`) on 2026-08-27**, clean fast-forward, never force-pushed. CI green on
all three jobs — Verify (1090 tests / 64 files), Security, and the DB job (504 pgTAP assertions
across 27 files, + seed). No migration, so nothing to apply. `Prod` moved twice mid-flight and was
merged in both times; only the two docs ever conflicted.

### Not done — needs a browser and the owner
1. **Open Money › Laundry prices on `ats.coreit.com.au`, price `T22`, take a job in for it and press
   Price this job.** The charge should carry the rate just set. Nothing here proves that end to end.
2. `T22`/`T38`/`T40` can now collapse to one code with three customer prices. Touches frozen
   charges — a decision, not a repair.

## Previously: the customer picker offers the customer database
2026-08-27, branch `claude/laundry-creation-customer-db-3tp9d1`. Reported from the deployed
app: *"Customer doesn't pick up when we create new laundry from customer database."*
**No migration; `git diff` over `supabase/` is empty**, no role gained or lost anything.
§6 holds the rule, §11 the live state.

- **One clause.** The job form's picker narrowed to
  `.in("status", ["active","prospect","on_hold"])` while the Customers screen listed all five
  statuses and `createOrder` checked none. The MYOB import had left **508 of 511** customers
  `inactive`, so the search box found **three** of five hundred — and said nothing.
- **The picker was the only refusal.** `createOrder` filters tenant + `deleted_at` only, and
  the top-up read fetches a customer it is *handed* whatever its status — which is why
  **New job** from a customer's own record always worked. That is why nobody spotted a filter.
- **The rule is now `lib/domain/customers.ts`**, pure and tested: `isPickableCustomer` (all but
  `archived`) and `customerStatusNeedsSaying` (badge anything not `active`). A rule inside a
  `.from()` chain is one no unit test can reach — `form-data.ts` imports `next/headers`.
- **Cap 500 → 1000.** Widened, the list is 511, so the old cap sat *inside* a real customer
  base — eleven at the end of the alphabet would have been unfindable. 157 kB, measured.
- **`Showing 12 of 14`** — the results list drew twelve and threw the total away. Harmless at
  three customers, not at 511.
- **Pre-existing defect found by measuring:** the "different delivery address" checkbox was
  hand-rolled — 16px box, 36px row, `border-strong` (1.42:1). Now `Checkbox`'s skin in a 44px
  label. It survived because **`JobForm` had never been in `/design-preview`**; it is now.
- **The data half was released by somebody else mid-investigation.**
  `reactivate_tenant_records()` ran at 05:31 UTC → **451 active / 60 inactive**. So the symptom
  went away by that, not by this commit; the code defect still hid the 60 and, past 500, eleven
  more. **Nothing in `src/` can release an import** — 0024's functions are service-role only.
- Proved as a real session (`cmignone219@gmail.com`, `operations_manager`): old clause **451**,
  new clause **511**, **60** badged. 1060 tests, 30 browser assertions, `verify` green.
- **Not opened behind the auth gate** (no Supabase creds here). Next: on `ats.coreit.com.au`,
  Take in laundry → search an inactive customer → expect an *Inactive* badge and a saved job.
- **Merged to `Prod` (`bc4fa45`)**, clean fast-forward from `1cbc31b`, never force-pushed. CI
  green on all three jobs; no migration, so nothing to apply. **`Dev` is level as of
  2026-08-27** — it carried no non-merge commit Prod lacked, so bringing it up was purely making
  its tree match, which it now does byte for byte. The standing drift the earlier note describes
  is closed rather than merely smaller.
- **Trap, the other way round:** Verify looked stale at `in_progress` for "thirteen minutes"; it
  actually ran 70s. This container's clock had barely moved. Check elapsed time against the
  runner's own timestamps, and remember the job log 404s while a job is genuinely running too.

## Also today: the import hold released, and the People list is real
2026-08-27, branch `claude/user-creation-by-role-bre21j`. All **live data**, no migration and
no code change — `git diff` over `src/` and `supabase/` against `Prod` is empty. The §18
entries hold the detail; this is the state to start from.

**Adelaide Towel Service now looks like a business rather than a sandbox:**
- **451 customers active** (was 2). The MYOB import of 2026-08-13 deliberately held every
  imported record `inactive` (0024) and nobody had flipped it back; the job form's picker
  correctly filters inactive customers out, so it offered 2 of 510. Replayed each row's
  *recorded previous status* — **60 customers and 4 suppliers stayed inactive** because they
  were already inactive in MYOB. **188 suppliers** released the same way.
  `import_activation_state` is now **empty**; that table has nothing left to say.
- **8 memberships, all real people.** Angelo Mignone (Owner), Christian Mignone (Manager),
  Mario Forte (Board 1), `board2@`–`board4@ats.example.com` placeholders, and darshan@/jay@
  (Owner + platform admins). **No `@roles.example.com` profile holds a membership.**
- **4 rounds, every one linked to a login that holds a membership.** Board 1 signs in as Mario
  Forte, whose `drivers` row is linked too — a board is the round, a driver is the person.
- **`TESTBOARD` and `board@roles.example.com` are deleted**, board row and login. Safe because
  the reference sweep was empty; the two other test profiles kept their logins because
  `audit_logs.actor_id` named them on 10 rows.

**Two things still open, both flagged to the owner:**
- **`RoleTest!2026` is in `scripts/role-profiles.mjs`, a committed file in a public repo**, and
  11 test logins still exist under it. None can reach anything now (no memberships), so nothing
  is exposed — but the constant belongs in the environment. `owner@roles.example.com` held
  `super_admin` on the real laundry under that password until today.
- `scripts/role-profiles.mjs` still lists a `board` profile, so `npm run seed:roles` would
  recreate the deleted login. `role-profiles.test.ts` pins that list against `ROLES`, so
  removing it is a code change with a test behind it.

**Method that kept paying off:** every live change was rehearsed in a transaction ending in
`raise`, read back to prove the rollback, then applied behind assertions — and read back **as
real sessions**, because a policy refusing a caller writes zero rows in silence.

**Nothing today was verified in a browser.** This container's network policy refuses both
`ats.coreit.com.au` and `*.supabase.co` (403 to CONNECT — an org rule, not retryable). Worth
checking in the app: sign in as Mario and see Board 1's day; open a new job and see 451
customers in the picker.


## Previously: a login can be created with a password, not only invited
2026-08-27, branch `claude/user-creation-by-role-bre21j`. Owner: *"allow in settings to
create user with Password as well like ysm-hub has."* Adopted from `ysm-prog/ysm-hub`'s
`api/create-staff.js` (cloned to `/home/user/ysm-hub`). **No migration; `git diff` over
`supabase/` is empty**, no role gained or lost anything. §10c holds the design.

## Who to probe as, now the test profiles are gone
No `@roles.example.com` profile holds a membership, and neither does `board1@ats.example.com` —
deliberately, by the session whose entry is *"The rounds get their memberships back, and Board 1
becomes a person"*: `owner@roles.example.com` held `super_admin` on the real laundry under a
password committed to a public repo. So §3a's "sign in as each role" no longer works here.

Probe as these instead — all three confirmed to hold their memberships after that cleanup:
- `angelo@adelaidetowelservice.com.au` — `super_admin`, **not** a platform admin, so it tests
  `has_role()` rather than `is_platform_admin()`.
- `cmignone219@gmail.com` — `operations_manager`.
- `board2@ats.example.com` (or `board3`/`board4`, or `marsy.forte69@gmail.com`) — `board`, the
  role that should be refused.
