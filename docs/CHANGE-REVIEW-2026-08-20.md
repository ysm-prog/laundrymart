# Electro Services — implementation notes reviewed against the code, then redesigned

**Date:** 2026-08-20 · **Branch:** `claude/electro-services-implementation-8l4f4c`
**Input:** the client's "Implementation Notes / Change Requests" (19 sections, 5 priorities).
**This document is analysis and design. No behaviour has been changed.**

---

## 0. The short version

Four of the five priorities are smaller than they read, and one is much larger.

| Priority | Client's ask | What the code already does | Real remaining work |
|---|---|---|---|
| **P1** Monthly/periodic invoicing | §2–§7 | **~70% built.** Consolidated per-customer invoicing, frozen prices, and duplicate prevention are all live and enforced in the database. | A period-scoped **Billing screen**, and **item-level roll-up** on the invoice. |
| **P2** Boards replace Drivers | §8–§12 | Nothing. Assignment is `job → driver → date`. | New entity, new role, **four RLS policies**, a login model. The deep half is RLS, not labels. |
| **P3** Run sequencing | §1 | **The column and its index already exist and are already populated.** | A reorder screen and one server action. Cheapest win of the four. |
| **P4** MYOB item codes | §13–§18 | Nothing usable. Job items are a **hard-coded 9-value enum**. | The expensive one: 144 references across 25 files, **three pricing tiers** keyed on that enum, and a MYOB importer that has no items reader. |
| **P5** Usability | — | — | Falls out of P1–P3 if they are built as designed. |

**One question has to be answered before P4 starts, and it is not a technical one:** this
application already pushes invoices and payments to **Xero** (`0026`, `0027`, `src/lib/xero/`).
MYOB is currently a **one-off migration source** — `docs/IMPORT-MYOB.md` describes carrying the
books across, not keeping them in step. §18 asks for a `last_synchronised` field and for the
structure to stay "MYOB-compatible". Those are two different futures and the item master should
only be built once. See §7.1.

---

## 1. How this review was done

Every claim below is against the code in this repository, cited by file and line. The live
database was not touched. The areas read in full:

- `supabase/migrations/0002`, `0004`, `0014`, `0017` (both), `0018` — the schema the changes land on
- `src/lib/invoices/from-jobs.ts`, `src/lib/domain/invoice-grouping.ts`, `src/lib/domain/job-pricing.ts`
- `src/app/(app)/invoices/` (register, `awaiting/`, `bulk-actions.ts`, `actions.ts`)
- `src/app/(app)/my-runs/actions.ts`, `src/lib/runs/my-runs.ts`
- `src/lib/roles.ts`, `src/lib/nav.ts`, `src/lib/domain/myob/`

---

## 2. Requirement-by-requirement conformance

Read this before costing anything. Several requests are already satisfied and should not be
re-implemented.

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Owner/Manager reorder jobs in a run | **Data model done, UI missing** | `jobs.sequence` exists with index `idx_jobs_route(route_id, sequence)` — `0004_routing_execution.sql:116,135`. It is *populated*: `findOrCreateStop` appends to the end — `my-runs/actions.ts:677-683`. My Runs already renders in that order. Nothing lets a person change it. |
| 1 | Display sequence position 1,2,3… | **Not shown** | My Runs groups To deliver / Out / Completed; it prints no position. |
| 1 | Reordering must not change job details | **Free** | `sequence` lives on the stop, not the job. |
| 2 | One consolidated invoice per customer per period | **Built** | `customers.billing_method = 'monthly_consolidated'` → `groupJobsForInvoicing` (`invoice-grouping.ts:54`) → one invoice carrying all the customer's jobs. |
| 2 | Show each job's items *and* a combined total | **Half** | Each job's lines are on the invoice. **There is no combined total per item.** |
| 3 | Billing screen with date range + quick filters | **Not built** | `/invoices/awaiting` is an *unbounded* list of every open job (`awaiting/page.tsx:50-53`), not a period. The month-end run (`generateInvoices`) takes a period but has no customer view. |
| 3 | Customer list with job count / item total / invoice status | **Not built** | No screen aggregates by customer over a period. |
| 4 | Per-customer job history for the period, expand/collapse | **Not built** | — |
| 5 | Consolidated item totals become the invoice | **Not built — and current behaviour is the opposite** | `from-jobs.ts:152-156` writes **one invoice line per job charge**, prefixed with the job number. Ten jobs × three item kinds = 30 lines, not 3. |
| 6 | Invoice retains the per-job/week breakdown | **Built, by accident** | The breakdown *is* the invoice today. It is also independently preserved: `invoice_source_jobs` + `job_charge_snapshots` keep every job's frozen lines with `source_item_id` provenance (`0017:204-234`). |
| 7 | Prevent duplicate invoicing | **Built, and enforced in the database** | `uq_invoice_source_jobs_once` — a partial unique index on (tenant, job). Partial so voiding releases the work. Plus `billing_status` filtering in `from-jobs.ts:235-244`. **This requirement needs no work.** |
| 7 | Statuses Not Invoiced / Draft / Invoiced | **Built, richer** | `BILLING_STATUSES` — `pending → awaiting_review → approved → invoice_generated → invoice_sent → paid` (`domain/billing.ts:24`). |
| 8–10 | Boards replace Drivers; one login per Board | **Not built** | Assignment is `laundry_orders.assigned_driver_id` + `assigned_delivery_date` (`0016`). `daily_routes.driver_id` → `drivers` (`0004:52`). |
| 11 | Board role with operational-only access | **Not built** | Nearest is `driver` — `run.execute, routes.read, routes.status, operations.read/write` (`roles.ts:224`). That set is very close to what §11 describes. |
| 12 | Move a job between Boards, single + bulk | **Single exists for drivers** | `assignJobToDriver` handles reassignment including the race guard (`my-runs/actions.ts:149-232`). No bulk. |
| 13–18 | MYOB item codes on job items | **Not built** | `laundry_order_items.item_type` is a CHECK enum of nine literals (`0014:164`). No code, no price, no MYOB id. |
| 15 | Item Master with sell/buy flags, prices, MYOB ref | **Partly — wrong table** | `public.items` has `sku`, `name`, `category`, `rental_price`, `wash_only_price`, `replacement_cost`, `status` (`0002:106-128`). It has **no** sell/buy flags, no cost price, no tax code, no MYOB id — and job items do not point at it. |
| 16 | Show and search by item code everywhere | **Not built** | Job form offers the nine labels. |
| 17 | Add/edit items, unique code | **Half** | `/items` exists; `uq_items_sku` is unique per tenant (`0002:128`). |
| 18 | MYOB sync fields | **Not built** | The importer understands eight export kinds and **items is not one of them** (`myob/readers.ts:83-86`). |

---

## 3. BA analysis — what the notes are actually saying

Stripped of implementation language, the client is making three business statements and one
technical one.

**B1. The billing unit is the customer-period, not the job.** Already the app's model; the gap
is only that no screen presents it that way and the invoice does not summarise.

**B2. The operational unit is the vehicle round, not the person.** This is the real change. The
app currently models the *person* as the unit of work, and the person is who RLS scopes on. The
client's reason is turnover and cover — an entirely ordinary reason, and it is why a rename
would not do.

**B3. Sequence is a decision the office makes and the round obeys.** Today it is an accident of
insertion order.

**T1. Item identity should be the ledger's identity.** Staff know MYOB codes; the app invented
nine categories. The notes are right that this should not be a second vocabulary — but they name
MYOB while the app posts to Xero. See §7.1.

### 3.1 Actors after the change

| Actor | Today | After |
|---|---|---|
| Owner | `super_admin` | unchanged; gains reorder + reassign + the Billing screen |
| Manager | `operations_manager` | unchanged; same gains |
| Driver (person) | `driver` role, `drivers` row, login linked by `drivers.user_id` | **stays** — a person is still who did the work, for audit. No longer the assignment target. |
| **Board (new)** | — | the assignment target; one login; sees only its own runs |
| Counter / plant | `customer_service`, `warehouse_operator` | unchanged |

**A finding worth stating plainly:** `drivers` should **not** be renamed to `boards`. They are
different things and the app needs both. A job is assigned to Board 1; *somebody* drives Board 1
on the 21st, and when a delivery goes wrong the business needs to know who. Collapsing the two
loses the audit trail the client has today, and §9's own reasoning ("another person temporarily
covers the route") is the argument for keeping both.

### 3.2 The rules that must survive the change

These are enforced in the database today and each has to be re-stated in board terms, not
dropped:

1. A job on a crewed run must name its assignee (`guard_laundry_order_assignment`, 0016).
2. The stop's run and the job's assignment must agree on assignee and date.
3. A job is billed exactly once; voiding releases it (`uq_invoice_source_jobs_once`).
4. An approved job's price is frozen and unwritable, including to `super_admin` (0017).
5. A board user reads only its own runs — the board equivalent of `current_driver_id()`.

---

## 4. Redesign — Priority 1: periodic consolidated billing

### 4.1 The one structural decision

§5 (roll items up) and §6 (keep the breakdown) look contradictory. They are not, because the
data model already separates the two:

```
                        the invoice the customer receives
invoice_lines  ────────────────────────────────►  one line per ITEM CODE (new)
      │
      │  the audit trail behind it (already exists)
      ▼
invoice_source_jobs ──► laundry_orders ──► job_charge_snapshots (frozen, per job, per item)
```

So: **roll up `invoice_lines`, and render the breakdown from the snapshots.** No new table is
needed for §6 — `job_charge_snapshots` already carries `source_item_id`, `quantity`,
`unit_price` and `frozen_at` per job (`0017:204-234`), which is exactly the "Week 1 / 2 August /
Towels 150" report §6 asks for.

**The consequence that must be handled, not glossed:** `invoice_lines.laundry_order_id`
currently points one line at one job (`0018`). A rolled-up line spans ten jobs, so that column
becomes `null` on consolidated lines. That is safe **only because the billed-once constraint is
`invoice_source_jobs`, not that column** — which it already is. Two follow-ons:

- Anything reading `invoice_lines.laundry_order_id` to answer "was this job billed?" must move
  to `invoice_source_jobs`. (The generator already filters on `billing_status`; the older
  `laundry-billing` path that used the column was deleted in the 2026-08-17 rate-card adoption.)
- Keep the column and keep writing it for `invoice_per_job` customers. It stays correct there.

**Grouping key for the roll-up**, in precedence order:
`source_item_id` → `source_laundry_item_type` → `(charge_type, description, unit_price)`.
Lines at **different unit prices never merge** — a customer whose rate changed mid-period gets
two lines, which is correct and is what they would query. Non-item charges (fuel levy, minimum,
surcharges) never merge across jobs.

### 4.2 New screen: `/billing`

A new area under **Money**, gated `billing.read` / `invoices.write`, replacing nothing.
`/invoices/awaiting` stays as the review queue — it answers "what needs pricing?", which is a
different question from "what do I bill ABC Hotel for August?".

```
Step 1  Period          [ This week | Last week | This month | Last month | Custom ]
                        default: LAST MONTH  (matching the existing month-end default,
                        domain/dates.ts previousMonth — chosen for the reason recorded
                        in the 2026-08-20 changelog: defaulting to the current month
                        reports "nothing to invoice" on the 1st)

Step 2  Customers       Customer | Jobs | Total items | Value | Status
                        ABC Hotel      10   2,970   $X   Not invoiced
                        XYZ Care        7   1,840   $X   Not invoiced
                        Example Motel  12   3,220   $X   Invoiced ✓

Step 3  Customer detail  Job history (expand/collapse, grouped by week)
                         + Invoice summary — consolidated per item code
                         + [ Generate one invoice for this period ]
```

**Period semantics — a decision the client must confirm.** A job is dated by
`completed_at` (when the work finished), not `received_at` and not `due_date`. That is the only
one of the three that means "billable work done in August". Flagged in §8.

**Already-invoiced jobs are excluded by default** (§7) and shown behind a "show invoiced" toggle,
labelled with the invoice number. The database refuses a double-bill regardless.

### 4.3 What has to be built

| Piece | Where | Notes |
|---|---|---|
| `consolidateChargeLines()` | `src/lib/domain/invoice-consolidation.ts` | **Pure, no I/O, unit-tested.** Placed in `domain/` for the reason `invoice-grouping.ts` documents: `lib/invoices/` reaches `lib/env` and is unreachable from a test. This repo has shipped two contracts broken behind a green `verify` for exactly this. |
| `periodBillingSummary()` | `src/lib/invoices/period.ts` | Reads jobs by `completed_at` within range + their snapshots. **Must filter `tenant_id` explicitly** (§23 — a platform admin's session spans two laundries). |
| `/billing` pages | `src/app/(app)/billing/` | Server components; period in `?from=&to=`, customer in `?customer=`. |
| `generateInvoicesForJobs` | `src/lib/invoices/from-jobs.ts` | Add `consolidateLines: boolean`. Per-job invoices keep today's shape. |
| Invoice detail + PDF | `[id]/page.tsx`, `src/lib/pdf/` | Rolled-up lines, then a "Service breakdown" section from the snapshots. |
| Nav | `src/lib/nav.ts` | New child under Money. `nav.test.ts` asserts per-role visibility. |

**No migration is required for P1.** Every column needed already exists.

---

## 5. Redesign — Priority 2: Boards

### 5.1 The part that is not labels

`current_driver_id(t)` (`0002:200`) is what scopes a driver's session. Four policy families read
it — `daily_routes`, `jobs`, `laundry_orders` (0015/0016), and the child paperwork through its
parents. **A Board login with no board equivalent of that function sees an empty app** — the
exact failure the 2026-08-17 changelog records for an unlinked driver ("a login that works and
shows nothing, which reads as a broken app").

So the migration must add `current_board_id(t)` and widen those predicates. That is the
irreducible core of P2.

### 5.2 Schema (`0031_boards.sql`)

```sql
create table public.boards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  depot_id  uuid references public.depots(id) on delete set null,
  code      text not null,                 -- 'BOARD1'
  name      text not null,                 -- 'Board 1'
  user_id   uuid references auth.users(id) on delete set null,   -- the board's login
  default_vehicle_id uuid references public.vehicles(id) on delete set null,
  status    text not null default 'active' check (status in ('active','inactive','archived')),
  ... standard audit columns, archived_at
);
create unique index uq_boards_code on public.boards(tenant_id, lower(code)) where deleted_at is null;
create index idx_boards_user on public.boards(user_id);
select public.apply_tenant_policy('boards');

-- the assignment target
alter table public.laundry_orders add column assigned_board_id uuid references public.boards(id);
alter table public.daily_routes  add column board_id          uuid references public.boards(id);

-- who actually drove it. Nullable, stamped at load confirmation.
alter table public.daily_routes  add column operated_by_driver_id uuid references public.drivers(id);

create or replace function public.current_board_id(t uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select b.id from public.boards b
  where b.tenant_id = t and b.user_id = (select auth.uid()) limit 1;
$$;
```

**Five decisions embedded above, each with a reason:**

1. **`drivers` is kept.** Per §3.1. `operated_by_driver_id` is where "who covered Board 1 on the
   21st" lives, so §9's cover scenario costs one field at load time, not a reassignment sweep.
2. **`assigned_driver_id` is not dropped.** Historical jobs keep it. This is the same call 0016
   made about Pickup Time and 0026/0017 made about `xero_synced_at`: a destructive migration to
   remove a column carrying history is the wrong trade. New writes set `assigned_board_id`; the
   old column stops being written.
3. **`boards.user_id` mirrors `drivers.user_id`** rather than inventing a membership column —
   same shape, same helper pattern, and the People screen's existing unlinked-member picker
   (2026-08-17) works for boards with no change to its logic.
4. **`apply_tenant_policy`** is used, unlike `laundry_prices` — a board is operational data, not
   a finance record, and every member has a legitimate reason to read the board list.
5. **`archived_at` is included**, so `0017_archive_records`' guarantee extends here.

### 5.3 The guard trigger

`guard_laundry_order_assignment` (0016) currently proves driver/date coherence. It must prove the
same in board terms, and the migration's **statement order is load-bearing** the way 0016's and
0017's are: add and backfill the columns *before* replacing the guard, because the backfill is
not a transition.

Rules after the change:
- `status = 'assigned'` requires `assigned_board_id` **and** `assigned_delivery_date`.
- The stop's run must name the same board and the same date.
- A job on a crewed run must name a board.
- The board must be active and of the same tenant.

### 5.4 The role

```ts
// roles.ts
board: ["run.execute", "routes.read", "routes.status", "operations.read", "operations.write"]
```

Identical to `driver`, which §11's description already matches almost word for word. Two
consequences that must be built rather than discovered:

- `MEMBERSHIP_ROLES` is the app's copy of the `memberships.role` check constraint. **Adding
  `board` needs the constraint widened in the same migration**, or every invitation fails.
- `is_driver_only()` narrows `laundry_orders` RLS. It needs a board sibling, or a board account
  reads the whole tenant's laundry through PostgREST — precisely the hole 0015 was written to
  close.
- `role-profiles.test.ts` pins the profile list against `ROLES`; a twelfth membership role needs
  a test profile or the suite fails. That is the test doing its job.

### 5.5 Backfill and cutover

```
1. Create Board 1–4 (owner names them; the migration seeds none — a laundry
   with three rounds should not be given four).
2. Link each board's login via the People screen picker.
3. Open jobs: reassign to boards from the Runs screen. Roughly five live rows.
4. Historical jobs keep assigned_driver_id and read correctly.
```

**Do not auto-create a board per driver.** It manufactures junk boards named after people, which
is the model the client is asking to leave.

### 5.6 Bulk reassignment (§12)

One action, one request, capped and refused rather than truncated past the cap — the same
contract the billing bulk actions hold (`bulk-actions.ts`, cap 200). Partial success reports both
numbers and names each reason.

---

## 6. Redesign — Priority 3: run sequencing

The cheapest of the four. **No migration.**

### 6.1 The one design question

The client's example reorders *jobs* (A–E). The schema sequences *stops*. A stop is one visit to
one customer, and a customer with two jobs on the same day is **one** stop — `findOrCreateStop`
finds it (`my-runs/actions.ts:657-670`).

**Recommendation: sequence the stop, present it as a position, and show the jobs under it.**
Ordering two jobs at the same address independently would mean driving there twice. In practice
each position is one job, so the screen looks exactly like the client's example. This should be
confirmed (§8).

### 6.2 What is built

- **`/runs/sequence`** (Owner/Manager, `routes.write`): pick a date, pick a board, drag the
  stops. Position 1,2,3… printed on every row.
- **Drag-and-drop with a keyboard and no-JS fallback.** Move up / move down buttons stay
  visible: `FormActions` is sticky on a phone and a drag-only control is unusable to a keyboard
  user. The design system's ≥36px target floor applies.
- **Compose locally, commit once** — the established idiom (planner, job form, contract wizard).
  The payload schema goes in a **plain module with tests**, never inside the `"use server"`
  file. Two of the three existing such payloads shipped broken behind a green `verify` for
  exactly that reason; this is not optional.
- **`reorderRunStops`** rewrites `jobs.sequence` for one run in one call, and **refuses to move a
  stop whose `progress_status` has left `not_started`** — the rule `routes/planner/plan.ts`
  already states. A stop the driver has arrived at is not re-orderable.
- **Board users see the order and cannot change it** (§1: "Board users should normally only see
  the final assigned sequence"). Read-only by capability: `routes.write` is not in the board role.

### 6.3 Consequence for My Runs

My Runs currently groups To deliver / Out for delivery / Completed. Within "To deliver" it must
sort by `sequence` and print the position, or the office's decision is invisible to the person
executing it.

---

## 7. Redesign — Priority 4: MYOB item codes

The expensive one, and the one that contradicts a decision this repo made deliberately.

### 7.1 The question that must be answered first

The application posts invoices and payments to **Xero** (`0026`, `0027`, `src/lib/xero/`,
CLAUDE.md §20). MYOB is documented as a **migration source** (`docs/IMPORT-MYOB.md` —
"how the books were carried into the app"). §18 asks for `last_synchronised` and ongoing
MYOB compatibility.

An item code is only worth carrying if it reconciles to the ledger that receives the invoice.
So, before any of §13–§18 is built:

> **Is the business staying on MYOB, moving to Xero, or running both?**

- **Staying on MYOB** → the Xero integration is dead weight and the item master should carry
  MYOB ids and a real sync. The Xero work should be paused, not extended.
- **Moving to Xero** → import the MYOB codes **once** as the item master's codes (staff keep the
  codes they know, which is the actual requirement in §13), and the sync fields point at Xero.
- **Both** → the item master needs two external-id columns and a stated direction of truth.

**Nothing in §13–§18 changes under any of the three except the sync half.** The item master, the
codes on job items, and code-first search are needed either way — so those can start immediately
while the question is answered. That is how this should be sequenced.

### 7.2 Extend `public.items`; do not create a third vocabulary

The app has two item vocabularies today and the notes are asking for a third. It should end with
one.

| Vocabulary | What it is | Fate |
|---|---|---|
| `public.items` | linen the laundry owns and rents out — sku, prices, weight, reorder level | **becomes the Item Master** |
| `laundry_order_items.item_type` | nine hard-coded categories for what arrives in a bag | **becomes a legacy column**; new rows carry `item_id` |
| (proposed new items table) | — | **rejected** — a third would drift |

**This overrides a documented decision, and CLAUDE.md's protocol requires saying so rather than
doing it silently.** `0014_laundry_orders.sql:157-163` reasons: *"Pointing this at items would
force a counter hand to create a stock record before they could take in a bag of sheets."* That
reasoning was correct for a counter with no item list. It is superseded by §13: the client
**has** an item list, staff know it by heart, and typing `TOW` to find `TOW001` is faster than
choosing from nine categories. The counter-speed concern is answered by making the picker
code-first with type-ahead (§16), not by keeping a separate vocabulary.

### 7.3 Schema (`0032_item_master.sql`)

```sql
alter table public.items
  add column item_code   text,                      -- MYOB code, e.g. TOW001; backfilled from sku
  add column description text,
  add column is_sell     boolean not null default true,   -- "Item I Sell"
  add column is_buy      boolean not null default false,  -- "Item I Buy"
  add column sell_price  numeric(12,2) not null default 0,
  add column cost_price  numeric(12,2) not null default 0,
  add column tax_code    text,                      -- MYOB/Xero tax code, e.g. GST/FRE
  add column myob_item_id     text,
  add column myob_item_code   text,
  add column external_synced_at timestamptz;

create unique index uq_items_code on public.items(tenant_id, lower(item_code))
  where deleted_at is null and item_code is not null;

alter table public.laundry_order_items
  add column item_id uuid references public.items(id) on delete restrict;
create index idx_laundry_order_items_item on public.laundry_order_items(item_id);
```

Notes:

- **`item_code` is separate from `sku`.** `sku` is in use with a unique index and its own history;
  overloading it would rewrite existing rows. Backfill `item_code := sku` and let them diverge.
- **`item_type` stays `not null`** through the transition, with new rows writing both — an item
  carries a `laundry_category` mapping to one of the nine so three pricing tiers keep working
  while they are migrated. Dropping it first breaks pricing for every existing job.
- **`on delete restrict`**, not `set null`: an invoice line must be able to say what was billed.
- No `laundry_prices` change in this migration — see below.

### 7.4 The ripple, stated honestly

This is the part that makes P4 expensive. Three pricing tiers are keyed on the nine-value enum:

| Tier | Column | Migration 0018/0017 |
|---|---|---|
| Rate card | `service_agreement_lines.laundry_item_type` | `0017:151` |
| Price list | `laundry_prices.item_type` | `0018:46` |
| Frozen charge | `job_charge_snapshots.source_laundry_item_type` | `0017:225` |

Each needs an `item_id` path added **beside** the existing one, with precedence
`item_id` → `item_type` → unpriced. `priceJob` (`domain/job-pricing.ts`) is pure and tested, so
this is the safest part of the change — but it is four modules, not one.

`job_charge_snapshots.source_laundry_item_type` must **not** be migrated. Those rows are frozen
historical facts and the guard refuses updates even to `super_admin` (0017). Add `source_item_id`
for new snapshots — it already exists — and read the old column for old ones.

**Estimated blast radius:** 144 `item_type` references across 25 files (`grep -c`), of which
roughly 40 are display-only and change with the label helper.

### 7.5 The MYOB items reader (§13, §14)

`MYOB_KINDS` is eight kinds and items is not one (`myob/readers.ts:83-86`). A ninth is added
following the existing pattern exactly: a `readItems()` in `readers.ts`, a plan builder in
`plan.ts`, and the two-step preview the import screen already enforces — plan first, write
second, same code for both, because a plausible wrong number in a set of books is worse than a
loud failure.

**This cannot be written from a specification.** §14 says so itself, and it is right: the
developer must inspect the actual MYOB export. **The client needs to supply an item export**
before this is built. Guessing at column names is how the dropped-column bug in the bills import
happened.

### 7.6 Code visible everywhere (§16, §17)

- `describeItem()` in `domain/laundry-orders.ts` becomes code-first: `TOW001 — Bath Towel`.
- The job form's picker becomes a type-ahead over code **and** name — the same shape as the
  customer picker rewritten in the 2026-08-13 redesign, which is already in the design system.
- `/items` gains the new fields; the unique index gives the duplicate refusal §17 asks for, and
  the action must report it as *"That item code is already in use"* rather than a database error.

---

## 8. Decisions needed from the client

Ordered by how much they block.

| # | Question | Why it blocks | Recommendation |
|---|---|---|---|
| 1 | **MYOB or Xero as the live ledger?** | Determines whether P4's sync half is built at all, and whether the existing Xero work continues. | Answer before P4 starts. P4's item master can begin regardless. |
| 2 | **A period's jobs are dated by `completed_at`?** | Decides which jobs land in August. | Yes — it is the only one of the three dates that means "work done". |
| 3 | **Reorder by stop (visit) or by job?** | Two jobs for one customer on one day are one visit. | Stop, presented as positions. Looks identical in practice. |
| 4 | **Do rolled-up invoice lines merge across different unit prices?** | A mid-period rate change. | No — separate lines. |
| 5 | **How many Boards, and their names?** | Backfill. | Owner creates them; the migration seeds none. |
| 6 | **Does a Board login see other Boards' runs read-only?** | RLS predicate. | No. Own runs only; managers see all. |
| 7 | **Is `drivers` kept for "who actually drove"?** | Audit trail. | Yes — §9's cover scenario is the argument for keeping it. |
| 8 | **MYOB item export file** | §13–§15 cannot be built without it. | Needed before P4 phase 2. |

---

## 9. Sequencing

Each phase is independently shippable and leaves the app working.

| Phase | Contents | Migration | Blocked by |
|---|---|---|---|
| **1** | `/billing` screen, `consolidateChargeLines`, roll-up option on the generator, breakdown on invoice + PDF | none | Q2, Q4 |
| **2** | Run sequencing: reorder screen, action, positions in My Runs | none | Q3 |
| **3** | Boards: `0031`, role, RLS helper, guard, screens, single + bulk reassign | `0031_boards` | Q5, Q6, Q7 |
| **4a** | Item master: `0032`, `/items` fields, code-first picker and search, `item_id` on job items | `0032_item_master` | — |
| **4b** | Pricing tiers read `item_id` | `0033_pricing_item_id` | 4a |
| **4c** | MYOB items importer | none | Q1, Q8 |

**P1 before P2 deliberately**, matching the client's own priority — and it is also the phase with
no migration and no RLS change, so it carries the least risk of the four.

**Phase 3 is the one that needs a live rehearsal.** Every migration in this project is applied to
`laundrymart-syd` by rolled-back probe first (CLAUDE.md §11); a migration that rewrites RLS
predicates on four table families is precisely the kind that has to be read back *as a real
member* before it is trusted, and as a board account after.

---

## 10. Risks

| Risk | Severity | Handling |
|---|---|---|
| A Board login sees an empty app | **High** | `current_board_id()` + the four predicates land in the same migration as the table. pgTAP proves a board reads its own run and zero of another's. Precedent: the 2026-08-17 unlinked-driver bug. |
| Rolled-up lines break the billed-once check | **High** | The check is already `invoice_source_jobs`, not `invoice_lines.laundry_order_id`. Prove it with pgTAP before the roll-up ships. |
| Item migration breaks pricing for existing customers | **High** | `item_id` is added *beside* `item_type`, never instead of. Precedence tested in `job-pricing.test.ts`, which is pure. |
| §5/§6 read as contradictory and get built as one | Medium | Roll up the lines, render the breakdown from snapshots. Both, from data that already exists. |
| `board` role added to `roles.ts` but not to the `memberships` check constraint | Medium | Same migration. `roles.test.ts` already pins the two together. |
| A new payload contract written inside a `"use server"` file | Medium | Plain module + tests. Two such contracts have shipped broken here behind a green `verify`. |
| Reads that feed a write span two laundries | Medium | Every new read takes `tenantId` as a **required argument** (§23 convention). |
| MYOB reader written against guessed columns | Medium | Do not start without the export. |

---

## 11. What this document does not do

- No code has been changed. This is review and design.
- No migration has been written or applied. The SQL above is illustrative of shape and intent.
- The live database was not read. Row counts quoted come from CLAUDE.md §11.
- Effort estimates are deliberately absent — the four phases are sized relative to each other in
  §0 and §9, and a calendar estimate needs the eight answers in §8 first.
