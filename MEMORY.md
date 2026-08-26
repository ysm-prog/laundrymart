# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

## There is one tenancy: Adelaide Towel Service
The owner's instruction, 2026-08-26. `ats.coreit.com.au` **is** Adelaide Towel Service — its
customers, its 647 invoices, its 254 items, its 268 chart-of-accounts rows. **Every question about
live data is a question about that tenant.** Do not reach for a second one to explain a result;
two answers in a row were framed that way and it was the wrong frame both times.

`Harbour Commercial Laundry` is the demo seed in `supabase/seed.sql`, not a laundry. Name it only
where that is genuinely what it is: the home of the eleven `@roles.example.com` test logins (§3a),
and the second tenant the pgTAP proofs need in order to be refused by one. Its rows are still on
the project; deleting them is a separate decision nobody has taken, and it would strand those test
logins — which live there precisely so they cannot read the real business's records.

**The multi-tenancy architecture stays.** One operating tenancy is a fact about today's data, not
a reason to drop `tenant_id`, RLS, or §23's rule that a read feeding a write names its tenant.

## Latest: a line's code is a real account, and a levy gets one unasked
2026-08-26, branch `claude/account-chat-linking-bknjn3`. Reported against `LJ00007`: an
invoice line `LJ00007 — fuel` coded `—`, under *"Remove and re-add a line to give it a
code."* One migration (`0044`); **nothing dropped, no row changed, no capability moved.**

- **Two faults.** Nothing could ever code that line — a fuel levy names no item, and the
  Charges card's account picker was removed on the owner's instruction, so it had no first
  tier and no second. And **the advice would have billed twice**: a job line removed and
  re-added returns `origin='manual'`, the next `rebuildJobLines` re-derives the job line
  beside it, and the invoice carries the charge twice.
- **`resolveChargeAccount` is now the one ladder** — charge → item → **charge type** — used
  by all four writers (three had the first two rungs inlined). `charge_type_accounts`
  (0044) is the new rung: a real table, FK `on delete set null`, gated on
  `can_write_purchases()`, validated by `guard_charge_type_account`.
- **Where a code is written depends on where the line reads it from.** A job line's account
  is derived and re-derived on every rebuild, so an override on the *line* would vanish
  silently. It goes to the **frozen charges** instead; `0044` narrows
  `guard_job_charge_snapshot` to permit `gl_account_id` **alone** while the invoice is a
  draft, refused once issued. Money stays as immutable as it was.
- **This reverses §27's own "a per-charge-type map was left out".** Owner's call,
  2026-08-26. Both halves answered: the item's account still wins, and it is a table with a
  foreign key rather than a settings blob that could dangle.
- **New screen** `/invoices/charge-accounts` (Money, last tab, `purchases.read`). Placed
  last deliberately — first, it became finance's landing page for the whole area, caught by
  `nav.test.ts`.
- **Load-bearing role assumption, now pinned:** every `invoices.approve` holder must hold
  `purchases.read`, because `rebuildJobLines` reads the map on the caller's client. If they
  part company the read is empty, which reads as "no defaults set", and levies quietly stop
  being coded.
- 1,004 unit tests (was 991), **504 pgTAP across 27 files** (was 485/26), `verify` green,
  45 migrations to a fresh PG16. New assertions confirmed to fail without their fix.
- **The migration's own assertion caught a bug in the migration** (`NULL || with_check`
  swallowed the two policies with no USING half). **The proof's first draft was wrong the
  way this repo keeps recording** — it expected 42501 from an UPDATE a policy excludes,
  which matches zero rows and raises nothing. By outcome now.
- Browser-driven at 320/390/768/1440, both themes: 16 assertions, 0 console errors, 0
  overflow in-section, 0 targets <36px. Found the links at 18–23px; and a "clean" pass that
  was **measuring a dead server on the wrong port**, given away only by console errors.

**APPLIED to `laundrymart-syd`** on 2026-08-26 as `charge_type_accounts`, before the merge —
the ledger's last entry (49). **Two migrations numbered 0044 are now live**, this one and
`item_master_detail`; disjoint objects, nothing to reconcile.
- Pre-flight: live guard body **byte-identical to this repo's 0017** (md5 vs a local build
  with this migration held back), both new objects absent, 0 anon grants, 0 tables sans RLS.
- After: both function bodies byte-identical to the repo (`34974e1e…`, `dd396a8a…`), 4
  policies, 0 `for all`, neither function on the RPC surface, advisors **23** (unchanged).
- Behaviour proved on the **real** row and rolled back: `LJ00007`'s frozen $50 fuel charge,
  on draft `INV00002`, recoded — **1 row**, not a silent zero. Amount refused, delete
  refused, heading refused, duplicate refused, recode refused once issued, account-delete
  cleared the map. Nothing survived.
- Seven real logins: board/driver/counter/dispatcher read 0 write 0; auditor reads 1 writes
  0; finance and owner read 1 write 1 — `can_read_purchases` / `can_write_purchases` exactly.

**The finding that changes the first step:** `LJ00007`'s fuel charge is
`charge_type = 'other'`, **not** `fuel_levy`. The default that codes it is Money › Charge
accounts › **Other**. Setting Fuel levy alone would leave the line uncoded and read as the
feature not working.

**Left to do, needs a browser:** open `INV00002`, press the `—` on `LJ00007 — fuel`, give it
an account; set Charge accounts › Other to the same; approve a second job for that customer
and confirm the fuel line comes back coded unasked.
## Also in this tree: MYOB's item page, and the line that reads it
2026-08-26, branch `claude/functionality-request-fi8erj`. The owner captured every field on
MYOB's item page for all 257 of Adelaide's active items; nine had nowhere to live here. One
migration (`0044`), **no table, no policy, no function, no capability; nothing dropped, no row
changed.** All fifteen fields are null on all 254 imported rows.

- **`0044_item_master_detail`** — twelve columns on `items` (`use_item_description`,
  `track_stock`, three account FKs, the four buying fields, `buy_tax_code`,
  `supplier_item_code`, `primary_supplier_id`, `default_reorder_qty`), three checks, two
  partial indexes. Eight self-assertions, **each proved to fail** against a real Postgres 16.
- **Twelve, not fifteen — `0043` had already shipped `selling_unit`,
  `items_per_selling_unit` and `sell_price_basis`** with the same meanings, from the branch
  that never landed here, so nothing in `src/` had ever read them. 0044 *asserts* them rather
  than adding `sell_unit`/`sell_units_per` beside them, and this change is what gives them a
  reader. **Do not add the second pair.**
- **`gl_accounts`, not `accounts`.** `tax_code` stays the **selling** code (`line-form.tsx`
  reads it that way) and `reorder_level` stays the *minimum stock level*; `buy_tax_code` and
  `default_reorder_qty` sit beside them. All four asserted.
- **`/items/:id` is MYOB's four groups now** (+ a fifth for rental linen), **one `<form>`, one
  Save**. The add form gains only the selling unit and the basis. `ITEM_COLUMNS` states the
  select once — the two hand-maintained strings had already drifted, and a form that posts a
  field it never read clears it on every save.
- **The invoice line prints the unit beside quantity and one basis sentence under the price.**
  Labels only: nothing extra posted, no column on a line, totals untouched. `sellPriceLabel`
  and `priceBasisHint` are pure and tested; the hint is **null on a non-taxable line**, because
  both sentences are claims about GST.

**The under-billing is FIXED** (owner's instruction, after it was first reported and left). An
`exclusive`-basis item short-charged by the whole GST component — `addInvoiceLine` stores
`quantity × unit_price` and 0043's `recalculate_invoice` extracts GST *out of* that, so $100
exclusive billed $100/$9.09 where the item says $110/$10.
- **`lineRateFromItem`** grosses an exclusive price up at the moment an item becomes money.
  **The totals maths is untouched** — a line amount being GST-inclusive is 0043's decision, so
  the conversion was wrong, not the arithmetic. A per-line basis column would reverse 0043 and
  re-price every invoice; do not.
- **Both call sites**: the invoice composer and `chargePatchForItem` (worse — approval *freezes*
  that number). Untouched on all three no-GST paths: no basis (all 254 items), FRE/N-T, rate 0.
  An unknown basis is never guessed at.
- Reads `tenants.gst_rate` via `lib/gst.ts`. **`GST_RATE_FALLBACK` lives in
  `lib/domain/items.ts`, not beside its reader** — `coding.ts` needs it and reaches the client
  bundle, so importing a module naming the server client is the §2 `next build` trap.
- Hint wording changed with it: "GST **has been** added to the item's price". Two tests pinning
  the old string were rewritten to the decision.

**The Xero half is FIXED too**, independently on `Prod` while this was in flight —
`buildInvoicePayload` now sends `LineAmountTypes: "Inclusive"`. **The two agree, and their
reasoning is the same:** `recalculate_invoice` totals `invoice_lines` unconditionally inclusive
regardless of any item's basis, so a *stored* line has one basis and never a mixture, and
`sell_price_basis` only ever governs **composition** — which is where this change converts it.
End to end: exclusive list price grossed up into the line, stored line inclusive, totals extract
the tax, Xero told so. The old caution that a per-item basis could not go through a per-document
field is retired: the per-item basis never reaches a stored line.

**Also stated rather than fixed:** an `optionalText`/`optionalUuid` field cannot be *cleared*
once set anywhere in this app (`""` → `undefined` → dropped by `JSON.stringify`). 0044's new
fields use a local `clearable` and do not inherit it, so `income_account_id` and the
cost-of-sales account beside it behave differently on one card. And **`MYOB_Items_Register.xlsx`
was not in the container** — the column mapping is the request's, not one read off the file,
which is why no importer was written.

**1001 unit tests** (was 991), **485 pgTAP across 26 files (unchanged — adds no policy)**,
`verify` green, all 44 migrations on a fresh Postgres 16 with the suite and the seed. **36
browser assertions** on the composer at 390/1440, 0 failures.

**Merged to `Prod` (`ec75cd9`) and `Dev` (`0f1a4c1`)** — identical trees, CI green on all three
jobs for each. `Prod` a clean fast-forward. Nothing outstanding: 0044 went on the project first.
**Read the log, not the status** — both Verify jobs served stale `in_progress`; their logs carry
`== PASSED ==`. Third time this file records that trap.

**Applied to `laundrymart-syd`** as `20260826132916`, the ledger's last entry (48). Rehearsed and
rolled back first; applied text **byte-identical to the file** first time; the live `items` table
diffed object by object against a local build from `supabase/migrations/` — **80 parts, zero
differences**. As real sessions: **board reads 254, writes 0** (on a row it read back itself, so
0 means refused); **Owner and Office manager write 1 each**; warehouse reads 254, writes 0.
Advisors 23, unchanged. All 254 rows still at their defaults. **Not opened behind the auth
gate** — the browser half is still unproved.

## Latest: 0043 is in the repo, and the Xero basis disagrees with it
2026-08-26, branch `claude/invoice-creation-job-workflow-11mobw`. The owner asked for the live
migration this repo lacked. **No `src/` change; one migration file, reconstructed not authored.**

- **`0043_myob_invoice_lines`** — MYOB's line columns (`discount_percent`, `unit_label`,
  `tax_code`) on `invoice_lines` and `job_charge_snapshots`, `selling_unit` /
  `items_per_selling_unit` / `sell_price_basis` on `items`, freight on `invoices`,
  `sync_tax_code_taxable()`, and **`recalculate_invoice()` re-created**.
- **The re-create is a money change, not an additive one.** 0006 adds GST on top
  (`total = sub + tax`); 0043 treats the line as **GST-inclusive** and extracts it
  (`total = sub`). Without the file, CI's database billed differently from production.
- **Byte-identical to what ran live**, md5-verified against the ledger
  (`63e12d194b94fd82c793947d579842a0`). Only the header is ours. **If the authoring branch lands,
  this path conflicts and theirs wins.**
- **The pgTAP pass over it is vacuous — nothing in `supabase/tests/` calls
  `recalculate_invoice`.** Proved by probe instead: $72.70 → 72.70 / **6.61** / 72.70;
  `tax_code='FRE'` forces `taxable=false`; freight totals right.
- **Found and then fixed (same day):** `buildInvoicePayload` sent `LineAmountTypes: "Exclusive"`
  with the raw `unit_price`, so Xero would have added 10% on top of a GST-inclusive figure —
  $72.70 here, $79.97 there. Now `"Inclusive"`. Latent throughout: no Xero connection, nothing
  ever pushed.
  - The earlier caution (`items.sell_price_basis` is per-item, so the basis might be mixed) **did
    not apply**: that column is about reading an item's *list price*, while `recalculate_invoice`
    totals `invoice_lines` unconditionally inclusive. One basis per document.
  - `payloadTotal()` models **Xero's** arithmetic including the basis, so it changes answer if the
    string is flipped — all three assertions proved to fail without the fix.
  - **Still open, in §20:** freight is not sent at all (`invoices.freight_amount` is not in the
    payload), and Xero recomputes `Quantity × UnitAmount` where we deliberately sum frozen
    amounts, so a merged line can differ by a cent. Both inert; both want a real Xero connection.


## Previously: a job never becomes an invoice — it joins a draft
2026-08-26, branch `claude/invoice-creation-job-workflow-11mobw`. Reported from the deployed app:
*"you allowed to create a invoice from Job by clicking on Approve button but it shouldn't, it
always should go to draft invoice and only create invoice from draft always."* **No migration; no
schema, RLS, capability or policy change.**

**The report was right and two doors were open.** The running draft made approval place charges
on the customer's open draft — for a `*_consolidated` customer only.
- **`invoice_per_job`**: `placeGroupOnInvoice` branched on "no billing period" and **inserted an
  invoice itself**, so one Approve press raised a whole document.
- **`manual`**: reached no draft at all, so its jobs waited for **Generate Selected** — a button
  whose whole job was turning selected jobs straight into invoices.

**One door now, and structurally so.** `lib/invoices/open-draft.ts` is the only module in `src/`
that inserts an invoice for a job, and everything it opens is `status: 'draft'`. The codebase
holds exactly **two** invoice inserts — that one, and `createManualInvoice` (a hand-raised blank,
not from a job, also a draft).
- **`manual` collects on a monthly draft now.** Its `null` period *was* the defect: no window
  means no draft to look up, so every press opened another document. What it still buys is
  `sweptByMonthEndRun` — the scheduled run leaves them alone.
- **`invoice_per_job`** still means one invoice per job, as a `per_job` **draft** per job. Only a
  per-job *customer* gets that shape; a consolidated customer with no `completed_at` must not.
- **Generate Selected → Add to Draft**, kept only as the retry path for a placement that failed
  (approval freezes charges whatever happens next), routed through `placeApprovedJobs`.
- **Wording was half the defect**: "Draft invoice INV00042 **raised**" → "**Started** draft
  invoice INV00042 … Issue it when you are ready to bill"; badge "Invoice generated" → "**On a
  draft invoice**"; a line under Approve says what it does. Glossary gained *Draft invoice* and
  *Issue*, lost *Generate*.
- **Add to Draft fails a partial batch** (Generate Selected did not) — deliberate: this verb only
  ever retries jobs that already failed, so one still in the queue must not read as success.
- `generatesAutomatically` removed — same question as `sweptByMonthEndRun`, no caller in `src/`.
  Depot stamping kept asymmetric on purpose: customer's for a periodic draft, the job's for a
  period-less one (merging the branches nearly lost that).
- **`findOpenDraft` filters `deleted_at`** — its comment claimed it mirrored
  `uq_invoices_open_draft` and it did not, so a deleted draft could be found and joined.
  `archived_at` stays out: RLS answers that, and **no policy mentions `deleted_at`**. 0 such rows
  live, nothing in `src/` writes it.
- `one-door.test.ts` reads the **sources** and fails if a second insert appears (`lib/invoices/*`
  → `lib/env` is unimportable from vitest). Proved to catch the regression, and guarded against
  passing vacuously.
- 981 tests on the branch, **991 with `Prod` merged in**; no migration, `supabase/` untouched.
  Merged tree: 45 migrations + **485** pgTAP assertions + seed, run locally on a fresh Postgres 16.

**Live shape unchanged:** all **509** customers are `monthly_consolidated`, **0** `per_job`
invoices exist, so neither closed door was in use. Forward-looking narrowing, checked against the
database rather than assumed.

**Merged to `Dev` (`5736797`) and `Prod` (`077a73b`)**, identical trees, CI green on all three
jobs for both. No migration; nothing to apply. `Prod` moved twice mid-flight (the status track +
`0042`, then the `vercel.json` deploy change) and was merged in each time — only the two doc files
ever conflicted. MEMORY.md was rebuilt on `Prod`'s tidied 96-line structure rather than
concatenated.

**Live ledger carries `0043_myob_invoice_lines` (`20260826115214`) and no branch here has the
file** — another session's, the §11 pattern again. Additive and harmless to this work: every
column it adds is nullable or `not null default`, checked against the applied statements.

**Before trusting it:** take a job in on `ats.coreit.com.au`, approve it, confirm the toast says
*Started draft invoice…* (not "raised"), that "Approved, not yet on a draft" is empty, and that
the invoice reaches the register only after Issue on the drafts board.

## Previously: a job's stage is picked, not walked
2026-08-26, branch `claude/tasks-design-ysm-hub-loe44p`. **One migration (`0042`), applied to
`laundrymart-syd` as `20260826112650 free_status_moves`.** CLAUDE.md §4 (rules), §6 (screen),
§7 (migration) and §11 (the apply) hold it.

Reported on `LJ00007`: the *What happens next* card offered one step forward and Cancel, and
nothing else, because `guard_laundry_order_transition` held a linear table. `/orders/:id` now opens
on a **status track** adopted from `ysm-prog/ysm-hub`'s job detail — the stages as a dot-and-rail
stepper, every stage this job can reach pressable, forwards or back.

- **Four rules survive, none of them "you cannot go backwards"**: a pickup has no delivery to be
  on; laundry still in the plant is not given to a round; a delivery job is assigned before it goes
  out; and it goes out before it is completed. `completed`/`cancelled` stay terminal — the owner
  was asked, and `LJ00007` is now `completed` + `invoice_generated`, which is the case it protects.
- **The guard was rebuilt from 0031's body**, so 0017's two billing hooks and 0031's board clearing
  survive verbatim. Clearing widened from one edge to all six moves back into the plant.
- **`buildStatusTrack` is the rule**, pure and tested; the component decides nothing.
- **Two capabilities not widened**: sending out stays `orders.manage`, pulling a job off a round
  gains `routes.write` (`leavesTheRound` / `capabilitiesForMove`), so the status control is not a
  back door around Remove Assignment. `advanceOrder` also runs `retireStopIfEmpty`.
- Found on the way: a platform admin was offered the status buttons on **another laundry's** job,
  where the tenant-filtered UPDATE matched no row and the toast said it worked.
- 981 unit tests, **485 pgTAP assertions**, `verify` green. Four proofs asserting the old one-step
  rule were rewritten to the decision rather than deleted.

**Applied and proved as real sessions** (rolled back): the counter moved a pickup **back** a stage
— **1 row**, not the silent zero a restrictive policy writes — finished it from `new` with the
0017 hook firing, was refused a van unassigned and refused reopening `LJ00007`; a board touched 0
rows; the owner assigned a real round and pulled it back with the assignment cleared. The applied
body was proved **byte-identical to the repo file** by `md5(prosrc)`. Advisors 23, unchanged. The
apply also closed a live RPC-surface exposure that was not this migration's — `authenticated`
could execute the guard (the 0019/0036 trap, standing since 0031 re-granted it).

**Merged**: `Prod` `5792ce8` (clean fast-forward), `Dev` `70379d8`, identical trees, CI green on all
three jobs for both. `Prod`'s Verify job reported a stale `in_progress` for minutes after finishing —
read the job log, not the status.

**Left, and it needs a browser:** take a job in on `ats.coreit.com.au`, press a stage already
behind it, and confirm it moves back with the timeline recording it under your name.

## Before that: no ledger accounts on a job charge
2026-08-26, branch `claude/code-review-requirements-ns6bav`. **No migration.**

The client's instruction: MYOB puts the Item ID and the Category on a line together, and nobody
picks a ledger account per line. So the job charges editor now asks **one** question — which item
— and the account travels silently from `items.income_account_id`.

- Gone: the `AccountPicker`, the "Add item or code" toggle, the "Not coded…" sentence and the whole
  `ChargeCoding` strip. `codingOffer` went with them rather than sitting as dead code.
- **The chart is still read and never shown**: `accounts` survives as a prop only to look up the
  item's income account for the GST tick.
- **A charge naming no item reaches the invoice uncoded.** That is the trade; the invoice line
  composer is where a code is chosen by hand, and it was deliberately left alone.
- 968 unit tests, 431 pgTAP assertions, `verify` green.

## And before that: the item code is typed where the charge is written
The description box on a charge line is an item type-ahead — `tw` offers
`TW · Towels - Wash & Dry Only`, and picking it fills the description, rate, GST and account.
Free text still wins: suggestions only while focused, Escape dismisses, nothing chosen without a
deliberate Enter or click. The item field is drawn open on every row.
`chargePatchForItem` is the one pure rule for what an item fills in, with `descriptionIsQuery`
telling it whether the text it replaces was a search or a sentence.

## The thing that still blocks codes reaching Xero, and it is data
- **0 of Adelaide's 254 items carry an `income_account_id`**, so picking an item fills the
  description and rate but brings no account. The MYOB inventory export has no such column, so
  nothing was dropped or guessed. Set it on `/items/:id` — only the handful of items a customer is
  actually charged for need it (`TW`, `GTW`, `HTW`, `BT`, `Del`, `Capes`, `GL`, `SH`, `PC`, `TC`).
- **0 of Adelaide's 261 postable accounts carry a `xero_account_code`**, so even a coded line sends
  nothing to Xero. There is also no `XERO_CLIENT_ID` on the deployment and 0 `xero_connections`.

## Standing rules worth not relearning
- `Prod` and `Dev` both deploy; feature branch → PR → `Prod`, then bring `Dev` up. Never
  force-push `Prod`.
- Migrations are applied to `laundrymart-syd` **before** the merge — the schema leads the code.
- A rule stated inside a component or a `"use server"` module is a rule no test can reach. This
  repo has shipped that broken behind a green `verify` three times.
- `npm run verify` needs a `.env.local`; placeholders are enough for typecheck/lint/test/build.
- **A Vercel deploy is not the gate.** `vercel.json` builds with `bash scripts/verify.sh ||
  next build`, so a failing gate falls through to a plain build and still ships. CI holds the
  gate; read it, not the deploy. `github.silent` is `false` since 2026-08-26, so the deploy now
  reports itself on the commit — but a session like this still cannot read it: the raw GitHub API
  answers "GitHub access is not enabled for this session", and `ats.coreit.com.au` is refused by
  the egress policy. **The GitHub half is an authorization gap, not an egress block** — every
  `api.github.com` path answers *"GitHub access is not enabled for this session. An org admin must
  connect the Claude GitHub App"* — so connecting that App is what would let a session here read a
  deploy. Until then, ask the owner and record the answer with its provenance, which is how
  `5792ce8` was confirmed live on 2026-08-26.
- **`github.silent` is `false` and it works** — the Vercel status is on `cc7da9f`, checked. But do
  not conclude it from `github.com/…/commit/:sha`: that page fetches 200 and carries **no** check
  data at all, not even CI's, so an absent status there means nothing. Check a known-green control
  before reporting an absence.
