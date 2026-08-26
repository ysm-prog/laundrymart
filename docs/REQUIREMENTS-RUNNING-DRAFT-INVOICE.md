# One invoice per customer per period — the running draft

> **Status:** requirements, written 2026-08-26 from the owner's description of the
> flow they expect. Analysed against the build as it stands at `13b1ed3`, then
> implemented in the same session. Where the delivered system departs from the
> wording below, §9 says so.

---

## 1. The flow the owner described

> The flow to generate an invoice is linked to each customer. While a job is in
> review the owner or Office manager adds the charges and the job is completed.
> Now that recorded charge is pushed to a **draft invoice for that customer**.
> Within the same month the same customer's new job arrives and the owner sets
> the charge — this charge should be added into the **same draft invoice**
> created for that customer earlier. At the end of the month the owner is ready
> to push that draft invoice out to the customer, so it becomes **one invoice per
> month**. Also do not restrict to monthly only: allow the owner or Office
> manager to **generate the invoice at any time** from the draft invoice.

Restated as a sequence, so each step can be checked off:

```
  Job LJ00007 completed ──► awaiting review ──► charges added ──► APPROVED
                                                                     │
                                                     places the charge on …
                                                                     ▼
                            ┌──────────────────────────────────────────────┐
                            │  INV00042 · DRAFT · Acme Hotels · August      │
                            │    Bath towel      100    $0.22     $22.00    │
                            └──────────────────────────────────────────────┘
                                                                     ▲
  Job LJ00011 completed ──► awaiting review ──► charges added ──► APPROVED
                                                                     │
                            ┌──────────────────────────────────────────────┐
                            │  INV00042 · DRAFT · Acme Hotels · August      │
                            │    Bath towel      150    $0.22     $33.00    │  ← merged, not a second line
                            │    Fuel levy (LJ00011)                $4.00   │  ← an event keeps its own line
                            └──────────────────────────────────────────────┘
                                                                     │
                              Owner presses "Issue" — on the 31st, or on the 9th
                                                                     ▼
                                              INV00042 · ISSUED · dated today
```

Two customer-visible promises fall out of that picture, and everything below
serves one or the other:

- **P1 — one invoice.** A customer who hands laundry over eleven times in August
  receives one document, not eleven, and not two because somebody pressed
  Generate twice.
- **P2 — the owner's clock, not the calendar's.** The draft can be closed on the
  31st, on the 9th, or twice in one month. Nothing waits for a month-end run.

---

## 2. What the build already does right

Worth stating plainly, because most of the machinery exists and this is a
**placement** change rather than a new billing system.

| Already true | Where |
|---|---|
| Completing a job never bills anybody — it sets `awaiting_review` | `guard_laundry_order_transition`, 0017 |
| Charges are added, edited and re-priced while a job is in review | `/orders/:id`, `saveJobCharges` |
| Approval **freezes** the charge rows; the trigger then refuses every write | `job_charge_snapshots.frozen_at`, 0017 |
| A job cannot be billed twice, ever | `uq_invoice_source_jobs_once`, 0017 |
| Voiding an invoice releases its jobs to be billed again | the partial index above |
| Several jobs' charges roll up per item into one line | `consolidateChargeLines` |
| The per-job breakdown survives under the rolled-up lines | `invoice_source_jobs` → `job_charge_snapshots` |
| Generating an invoice never sends it | `lib/invoices/from-jobs.ts` vs `lib/invoices/send.ts` |
| Only the Owner and the Office manager can price, approve, generate or send | `JOB_TO_INVOICE` in `roles.ts`, and 0025's restrictive policies |

So the freeze, the roll-up, the breakdown, the billed-once rule and the role
model are all in place and unchanged by this work.

---

## 3. The gaps

Each of these was read out of the code, not assumed.

### G1 — Consolidation is a property of one button press, not of the customer

`generateInvoicesForJobs` **always inserts a new invoice**. `groupJobsForInvoicing`
groups the jobs *in the call it was given* — so a consolidated customer gets one
invoice per **generation run**, not one per period.

Approve job A on the 3rd and press Generate; approve job B on the 11th and press
Generate. Result: two invoices, same customer, same August, both `consolidated`.
The customer's `monthly_consolidated` setting only produces one invoice if every
job in the month happens to be generated in a single press — which is exactly the
month-end-only working pattern the owner is asking to be freed from.

**This is the defect P1 names, and it is the whole of this change.**

### G2 — Approval leaves the money nowhere

Approving freezes the charges and moves the job to `approved`. Nothing puts it on
an invoice. The job sits in the *Awaiting invoice* queue until somebody comes back
and presses Generate — a second visit, on a different screen, to a list that has
by then grown other rows. The owner's description has no such step in it: setting
the charge *is* what puts it on the draft.

### G3 — There is no way to find "this customer's open draft"

A job-generated invoice carries **no period at all**: `generateInvoicesForJobs`
only stamps `period_start`/`period_end` when a caller passes `options.period`, and
the two callers that matter — Generate Selected on the queue, and the jobs half of
the month-end run — pass none. So there is no key to look an existing draft up by,
which is why G1 could not have been avoided by the callers.

### G4 — Nothing can be added to an invoice that already exists

Even by hand. The invoice detail screen can add a **free-text line**, but there is
no "put this approved job on that draft". The only relationship between a job and
an invoice is created at generation time.

### G5 — Taking one job back off means destroying the invoice

The only reverse gear is Void, which releases *every* job on the invoice. On a
running draft carrying eleven jobs, correcting the twelfth would mean voiding all
eleven, re-approving them and generating again.

### G6 — The month-end run raises **two** invoices for one customer

`CLAUDE.md` §4 states: *"Recurring invoicing is one invoice per customer per
period, carrying every contract they hold **and every laundry job they had
completed in it**."* The code does not do that. `generateInvoices` writes a
`recurring` invoice from the contract charges, and then calls
`generateInvoicesForJobs`, which writes a **second, separate** invoice from the
approved jobs. A customer with a contract and counter laundry gets two documents
for one month.

The duplicate-billing guard hides the shape of this: the contract half skips a
customer who already has a `recurring` invoice for the exact period, and the jobs
half is guarded by `uq_invoice_source_jobs_once`, so nothing is billed twice — the
month is simply split across two invoices.

### G7 — Appending must re-merge, not append lines

If job A contributed *Bath towel × 100 @ $0.22* and job B contributes *× 50 at the
same rate*, P1 requires **one line of 150**, not two lines. `consolidateChargeLines`
already states that rule, but it runs over a single batch. Appending to an existing
invoice has to re-consolidate across everything the invoice bills.

And it must do so **without touching the lines a person typed by hand**, which the
detail screen can add to any draft. Nothing on `invoice_lines` currently says where
a line came from, so "rebuild the job lines" is not expressible.

### G8 — A draft's dates go stale, and issuing early makes it worse

`issueOneInvoice` stamps `status` and `issued_at` and **leaves `issue_date` and
`due_date` exactly as generation wrote them.** A draft opened on 3 August with
14-day terms carries a due date of 17 August; issued on the 31st, it reaches the
customer already a fortnight overdue. This is latent today (drafts are short-lived)
and becomes a certainty the moment a draft is *designed* to sit open for a month.

### G9 — Nothing shows the open drafts

There is no screen answering "what is accumulating right now, and for whom?" The
register lists drafts among everything else with no sense of "still filling up";
`/billing` is a period report; the queue is a list of jobs. The owner's month-end
question — *which drafts are ready to go out?* — has no home.

### G10 — Two approvals at once can open two drafts

Nothing in the schema stops two invoices being `draft` for the same customer and
period. Two reviewers approving simultaneously both find no draft and both open
one. A partial unique index is the only thing that makes "one open draft" a fact
rather than a convention.

### G11 — Lines can be changed on an invoice that is no longer a draft

`addInvoiceLine` and `removeInvoiceLine` check the caller's capability and **not
the invoice's status**, and `invoice_lines_write` in 0006 is a plain role policy.
So a line can be added to an issued, sent, paid or voided invoice, from the app or
straight off `/rest/v1/invoice_lines`, and the customer's copy and ours then
disagree. Not introduced by this work, but the rebuild in R4 writes lines
programmatically, and doing that safely means the boundary has to exist.

---

## 4. Decisions taken

Recorded here because each closes off an alternative somebody will otherwise
re-open.

**D1 — The customer's `billing_method` is the setting; there is no new one.**
`manual` already means "a person decides each time, nothing happens on its own",
and that is precisely the opt-out from automatic placement. A tenant-level
"auto-draft" switch would be a second answer to a question this column already
answers.

**D2 — The open draft is keyed on (customer, period start, period end).** Not on
"the customer's latest draft": a July job approved late in August must join
*July's* draft, not August's. The period comes from the job's completion date and
the customer's method (R2).

**D3 — `invoice_type` on a running draft is `consolidated`.** `recurring` stays a
valid value for the invoices that already carry it, and nothing new writes it —
because after R6 a single invoice can hold both contract charges and job charges,
and one type cannot describe both. Which is which is now a property of the
**line** (`invoice_lines.origin`), which is the honest place for it.

**D4 — Job lines are rebuilt from the frozen snapshots, never patched.** Appending
deletes the invoice's job-origin lines and re-derives the whole set from every job
the invoice bills. Deterministic, idempotent, and it cannot drift from the
breakdown underneath — both are computed from the same rows by the same rule.
Patching would need a diff, and a diff of consolidated lines is where a rounding
disagreement between the invoice total and the frozen charges would come from.

**D5 — An invoice is dated the day it is issued.** R7. This changes existing
behaviour for the month-end run (whose drafts are currently dated at period end)
and is the correct trade: the period an invoice covers is carried in
`period_start`/`period_end` and printed, whereas the issue date is a claim about
when the document was raised. Dating it in the past is what makes a customer
overdue on arrival.

**D6 — No new capability, no new role.** Everything here is `invoices.write`,
`invoices.approve` or `invoices.send`, all three of which are already the Owner's
and the Office manager's alone (`JOB_TO_INVOICE`). The owner's sentence says
exactly those two people, and the model already says it.

**D7 — Placement failures never fail the approval.** Approval is the freeze and it
either happened or it did not. If the draft cannot be opened, the job stays
`approved`, sits in the queue exactly as it does today, and the operator is told
in the same sentence that reports the approval. Rolling an approval back because a
downstream write failed would lose a decision somebody actually made.

---

## 5. Requirements

### R1 — Approving a job places its charges on the customer's open draft

1. On approval, the job's frozen charges are placed on the open draft invoice for
   that customer and that billing period.
2. If no such draft exists, one is opened, as `draft` / `consolidated`, stamped
   with the period.
3. If one exists, the job is added to it and its lines are rebuilt (R4).
4. A customer whose method is `invoice_per_job` gets one invoice per job, exactly
   as now — placement, not consolidation, is what is new.
5. A customer whose method is `manual` is **not** placed automatically (D1). The
   job waits in *Awaiting invoice* for somebody to choose.
6. Approval succeeds even when placement does not (D7), and the operator is told
   which happened.
7. Bulk approve behaves identically, one placement per job, reported in aggregate.

### R2 — The period a job falls in is derived, and stated once

| `billing_method` | window containing the job's completion date |
|---|---|
| `monthly_consolidated` | the calendar month |
| `fortnightly_consolidated` | the fortnight, on a fixed Monday anchor |
| `weekly_consolidated` | the ISO week, Monday to Sunday |
| `invoice_per_job` | none — the job is its own invoice |
| `manual` | none — placement is a person's decision |

1. The rule is **pure** and lives in `src/lib/domain/`, with tests, for the reason
   this repository records three times over: a rule stated inside a `"use server"`
   module or beside I/O is a rule no unit test can reach, and two such contracts
   have shipped broken here behind a green `verify`.
2. Dates resolve in the **business timezone**. A job completed at 9am Adelaide on
   1 September belongs to September, and composing the boundary in UTC is how it
   would land on August's invoice — silently.
3. A job with no completion date has no period and is not placed automatically.
4. The fortnight anchor is a fixed historical Monday, so the same job always lands
   in the same fortnight regardless of when the question is asked.

### R3 — There is at most one open draft per customer per period

1. Enforced in the **database**, by a partial unique index — not by the reader
   that looks the draft up. Two concurrent approvals must not produce two drafts.
2. The loser of that race re-reads and joins the winner's draft rather than
   failing.
3. Issuing closes the draft. A job approved afterwards for the same period opens a
   **new** draft, which is correct: the first document has gone to the customer.

### R4 — Appending re-consolidates, and leaves hand-written lines alone

1. Adding a job to a draft rebuilds every **job-derived** line on it, by
   re-consolidating the frozen charges of *all* the jobs that invoice bills.
2. Lines a person typed by hand are untouched, as are contract lines.
3. `invoice_lines` records where each line came from, so 1 and 2 are expressible
   at all.
4. Quantities and amounts are **summed from the frozen charges**, never recomputed
   from quantity × price — the invoice total must equal the sum of the snapshots
   to the cent.
5. The invoice is recalculated after every rebuild.
6. Rebuilding is refused unless the invoice is a draft.

### R5 — A job can be taken back off a draft

1. `invoices.write`, on a draft only.
2. The job returns to `approved` and reappears in the queue.
3. The draft's lines are rebuilt without it.
4. A draft whose last job is removed is left in place, empty, rather than deleted —
   an invoice number that has been issued to a screen is not silently reused.

### R6 — The month-end run produces one invoice per customer per period

1. Contract charges are written onto the **same** draft the jobs are on, as
   `contract`-origin lines, so a customer with both receives one document.
2. Re-running the same period does not duplicate the contract lines.
3. The run's own period is the draft key for both halves, so an operator who runs
   1–31 August meets the drafts that August's approvals opened.
4. A run over a window that is not a whole month raises its own draft for that
   window, which is what was asked for.

### R7 — Issuing is available at any moment, and dates the document

1. Any open draft may be issued from the drafts board or the invoice itself, by
   the Owner or the Office manager, on any day.
2. Issuing stamps `issue_date` to today and `due_date` to today plus the invoice's
   payment terms (D5).
3. Issuing is unchanged in every other respect — the Xero push still happens after
   the invoice is issued and still never blocks it.
4. Sending remains a separate act with its own capability.

### R8 — The open drafts board

1. A screen under Money listing every open draft: customer, period, how many jobs,
   the running total, when it last grew.
2. Per row: open the invoice, and **Issue now**.
3. Bulk: issue a selection.
4. It is the answer to "what is ready to go out?", so it opens on everything and
   is narrowed by the standard filter language (§29), not by a bespoke control.
5. A count badge, so the rail says work is waiting.

### R9 — The invoice screen says what a draft is

1. A running draft says it is still collecting, and for which period.
2. It lists the jobs it bills, each with its date, its number and its total, and a
   control to take it off (R5).
3. Issued and later states show the same list without the controls.

### R10 — Lines cannot change on an invoice that is not a draft

1. Enforced by a database trigger, not only by the actions, because
   `invoice_lines` is published on `/rest/v1/invoice_lines`.
2. It refuses out loud (`42501`), rather than writing zero rows in silence — the
   failure this project has shipped twice.
3. Voided invoices are equally frozen: a void is a record of what was said.

### R11 — Pages read in columns

1. The screens this work adds or substantially touches lay out as columns on a
   wide screen rather than one long scroll, using the existing card grid.
2. Below `sm` everything still stacks, and `DataTable`'s labelled-card fallback is
   unchanged.

---

## 6. Out of scope, and why

- **A configurable fortnight anchor.** R2 fixes one, deterministically. A laundry
  that bills fortnightly from a particular Monday needs a setting on the customer;
  nobody has asked, and inventing the column now would be a second answer to
  "which fortnight is this?".
- **Automatic issuing on a schedule.** The owner's ask is the opposite — the
  decision to close a draft stays a person's.
- **Editing a frozen job charge from the invoice.** Correcting an approved job is
  still: send it back for review, or credit-note it. Nothing here softens the
  freeze.
- **Merging two existing drafts.** R3 makes them not arise.

---

## 7. Acceptance

| # | Check | Serves |
|---|---|---|
| A1 | Approve one job for a monthly customer → a draft exists, carrying that job's charges | R1 |
| A2 | Approve a second job for the same customer in the same month → **the same** invoice number, no second invoice | P1, R1 |
| A3 | Two identical item charges on those two jobs → **one** line, quantities summed | R4 |
| A4 | Two fuel levies on those two jobs → **two** lines, each naming its job | R4 |
| A5 | Issue the draft on the 9th → dated the 9th, due the 9th + terms | P2, R7 |
| A6 | Approve a third job after issuing → a **new** draft, the issued one untouched | R3 |
| A7 | Remove a job from a draft → job back to `approved`, lines rebuilt without it | R5 |
| A8 | A `manual` customer's approval → no draft, job waits in the queue | D1, R1 |
| A9 | An `invoice_per_job` customer's approval → its own invoice | R1 |
| A10 | A job completed 1 Sept 09:00 Adelaide → September's draft | R2 |
| A11 | Month-end run for a customer with a contract **and** jobs → one invoice | R6 |
| A12 | Re-run the same month → no duplicate contract lines, no duplicate jobs | R6 |
| A13 | Insert a line on an issued invoice through PostgREST → refused, 42501 | R10 |
| A14 | Two concurrent approvals → one draft | R3 |
| A15 | A hand-typed line on a draft survives the next job being added | R4 |

---

## 8. What this changes for somebody using the app

**Before.** Take laundry in, complete it, price it, approve it. The job then sits
in *Awaiting invoice* until somebody remembers to come back, tick it and press
Generate — and whether the customer ends up with one invoice or five depends on
how many presses that took.

**After.** Take laundry in, complete it, price it, approve it. The charge appears
on that customer's invoice for the month straight away. Approve their next job and
it joins the same invoice, with the towels added to the towel line. When you want
to bill them — the 31st, or the 9th, or twice in a month if that is the
arrangement — you open *Open drafts*, see the running total, and press Issue. The
invoice is dated that day.

---

## 9. Where the delivered system departs from §1

- *"the charge is pushed to a draft invoice"* — true for every billing method
  except `manual`, which is the setting that already means "ask me first" (D1).
- *"within the same month"* — the window is the customer's own billing method, so
  a weekly customer's draft covers a week. Monthly is the default and the common
  case.
- *"one invoice per month"* — one invoice per customer **per period**, which is
  the same sentence for a monthly customer and the correct one for the others.
- The month-end run and the per-customer *Raise invoice* button now **join** the
  running draft instead of raising a second invoice. That is a change to existing
  behaviour and is the point of R6.
- Every invoice's issue date now follows the day it was issued, including invoices
  raised by paths this document does not otherwise touch (D5).
