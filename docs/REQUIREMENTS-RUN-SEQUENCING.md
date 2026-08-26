# Electro Services — Controlled Run Sequencing

*The requirement, and the system that meets it. Written 2026-08-25 from the
client's master specification of the same date, restated as requirements and
reconciled against what was actually built, tested and deployed.*

**Status: delivered.** Every requirement below is implemented, proved, and live
on `laundrymart-syd` (migration `0036_run_sequence_control`, applied 2026-08-25).
Section 12 records where the delivered system deviates from the original wording
and why; section 13 records what is deliberately not done.

This document supersedes the original master prompt as the reference for this
feature. It is traceable to it: section numbers below carry the original
section in brackets, so `[§14]` means section 14 of the master specification.

---

## 1. The business rule

> **Management determines the order of the run. Drivers execute it.**

For each Board and operational date, the order in which a round drives its
calls is a management decision. It is set deliberately, saved as a whole, and
locked. Nobody else may change it, and no accident may change it.

---

## 2. Scope, and what a "run" is `[§2, §20]`

The existing architecture is extended, not replaced. The chain is unchanged:

```
laundry_orders → stop_id → jobs → route_id → daily_routes → board_id + route_date
```

- A **stop** (`public.jobs`) is one visit to one customer. Several laundry jobs
  for the same customer on the same day are one stop, because the van knocks
  once. **Ordering is by stop, not by job** — ordering two jobs at one address
  apart would mean driving there twice.
- A **run** (`public.daily_routes`) is a board's day. It is found-or-created by
  the assignment action; nobody creates, opens or names one, and no run code
  appears on any screen.
- A **board** is a standing delivery round with its own login. A **driver** is a
  person. Both are kept: `daily_routes.operated_by_driver_id` records who
  actually drove.

Screens say *stop* for a customer visit and *job* for a customer's laundry.

---

## 3. Who may change a run's order `[§3]`

**Requirement.** Only the Owner and the Operations Manager may change a run's
sequence. A Dispatcher may not. A Driver may not. A Board may not.

**As built.** A dedicated capability, `routes.sequence`, in `src/lib/roles.ts`.

| Role | `routes.read` | `routes.write` | `routes.sequence` |
|---|---|---|---|
| `super_admin` (Owner) | ✅ | ✅ | **✅** |
| `operations_manager` (Manager) | ✅ | ✅ | **✅** |
| `platform_admin` | ✅ | ✅ | **✅** |
| `dispatcher` | ✅ | ✅ | **❌** |
| `branch_manager` | ✅ | ✅ | **❌** |
| `regional_manager` | ✅ | ✅ | **❌** |
| `driver` | ✅ | ❌ | **❌** |
| `board` | ✅ | ❌ | **❌** |
| `customer_service` | ✅ | ❌ | **❌** |
| `auditor` | ✅ | ❌ | **❌** |
| `finance`, `warehouse_operator`, `sales` | ❌ | ❌ | **❌** |

`routes.write` was the wrong authority and could not be reused: three roles hold
it that the requirement excludes. The capability is declared in a `RUN_SEQUENCE`
block and **subtracted** from the roles that derive their capabilities from
`TENANT_ALL`, because a capability that is merely *not mentioned* is one that
six roles silently hold. `branch_manager` and `regional_manager` are the two
this actually catches.

`can_write_run_sequence(tenant)` is the database's copy of the same sentence.
The two halves are pinned against each other by `roles.test.ts` and
`run_sequence.test.sql`.

---

## 4. The two states `[§4]`

### Locked — the default

A run always opens locked. In this state there is **no drag handle, no move
control and no Save button on screen at all** — not a disabled one, because a
disabled control still invites a press. The header reads `🔒 Run locked`.

Only a user holding `routes.sequence` sees the way in: **Adjust Run**.

### Editing — entered only on purpose

Pressing Adjust Run switches the header to `🔓 Editing run` and reveals
drag-and-drop plus 44×44px move-up / move-down buttons.

**No database write happens on entering edit mode, on a drag, or on a move.**
This is not an optimisation — it is what makes Cancel free: `[§6]` requires
Cancel to write nothing, so entering edit mode cannot write either, or Cancel
would have to write it back. A manager who abandons an open tab therefore
strands nothing, and no run is ever "checked out".

---

## 5. Save & Lock Run `[§5]`

One action commits the whole order. In order, it:

1. validates the payload (`sequence.ts`, a plain module with its own tests);
2. re-checks the caller still holds `routes.sequence`;
3. re-resolves the run **from (tenant, board, date)** — a posted run id is never
   trusted;
4. verifies the posted set is exactly this run's current stops;
5. verifies no worked stop has moved;
6. compare-and-swaps the concurrency version;
7. writes positions `1..n` in **one statement**;
8. records an audit row carrying both orders in full;
9. leaves the run locked;
10. revalidates `/runs` and `/my-runs`;
11. reports: **"Run sequence updated successfully. The run has been locked."**

Steps 3–7 happen inside `apply_run_sequence()`, one transaction, so the run is
never transiently numbered twice and a partial reorder cannot exist.

After saving, the board returns to locked in the same render — the component
adopts the server's new order during render, so drag becomes unavailable
immediately.

## 6. Cancel Changes `[§6]`

The saved order is the editing baseline. Cancel restores it exactly and returns
to locked. **No database update occurs.**

```
Saved:      A B C D
Rearranged: C A D B
Cancel  →   A B C D
```

---

## 7. Data model `[§7]`

`daily_routes` is extended. No second run table, and no new column on `jobs`.

| Column | Type | Meaning |
|---|---|---|
| `sequence_locked` | `boolean not null default true` | The standing statement that this order is management's. Read by the guard. |
| `sequence_version` | `integer not null default 1` | Optimistic concurrency token. |
| `sequence_updated_by` | `uuid → auth.users` | Who last set the order. |
| `sequence_updated_at` | `timestamptz` | When. |

Every default describes what was already true, so **no existing run was
invalidated** — verified live: all 11 runs took `locked / version 1`.

`sequence_locked` is the persisted rule, not a mutex. Nothing in the
application flips it; editing is a screen state (section 4).

---

## 8. Sequence storage `[§10]`

`jobs.sequence` remains the single canonical store. **No second sequence field
was created.** On save, positions are recalculated deterministically from 1 —
not nudged — so a run is always `1, 2, 3, …` with no duplicates, no gaps, no
zero and no nulls. Whatever gaps or duplicates the stored data carried are
repaired by the next save.

---

## 9. Server-side enforcement `[§8, §9]`

**The frontend is not the security boundary, and before this work there was no
other one.** `public.jobs` is published at `/rest/v1/jobs` under a single
permissive `for all` policy, so a driver could `PATCH` the sequence of the run
they were standing in, and any other member could PATCH anybody's. This was
reproduced against a 0001–0035 database — `UPDATE 1`, a real row changed — not
inferred.

Two triggers close it:

- **`guard_job_sequence`** on `jobs`, `before update of sequence`. Refuses with
  SQLSTATE `42501` unless the caller passes `can_write_run_sequence()`, and
  refuses any repositioning of a stop the round has already worked.
- **`guard_run_sequence_control`** on `daily_routes`, narrowed to the four
  sequence columns. Without it a board or driver — who may update their own run
  row — could set `sequence_locked = false` and walk past the first guard, or
  rewind the version to defeat the concurrency check. Status, crew, load
  confirmation and closing stay exactly as writable as they were.

**A trigger rather than a restrictive RLS policy, for two reasons.** RLS is
row-level, and the rule is about *one column*: a restrictive UPDATE policy on
`jobs` would also stop a driver writing `progress_status` and `arrived_at` on
their own stops as they work them. And a restrictive policy writes **zero rows
with no error** to a caller it excludes — a silence this codebase has shipped
twice — whereas a trigger raising `42501` reaches the operator as a sentence.

The trigger fires only on `UPDATE OF sequence`, so board assignment (an INSERT,
appended at the end) is untouched.

A malicious caller cannot: call the action directly, forge form data, submit
another board id, submit another date, submit somebody else's run, fabricate a
sequence, bypass the lock, or PATCH `jobs.sequence`. Each is proved in section 11.

---

## 10. Behaviour around the edges

### New work arriving after the order is set `[§11, §21]`
A newly assigned job is **appended to the end**. The existing manual order is
never resorted. `findOrCreateStop` already placed a new stop at
`max(sequence) + 1`; the guard is UPDATE-only precisely so this keeps working
for the roles that assign work and do not order runs.

```
Saved: A C D B      + new job E      →      A C D B E
```

### Work removed `[§12]`
Removing a stop closes the gap: `1, 3, 4` becomes `1, 2, 3`. Handled by
`compact_run_sequence()`, which is `SECURITY DEFINER` because the roles that
legitimately empty a stop (a dispatcher reassigning, the counter moving a job)
are wider than the roles that may order a run. Admitting them is safe **by
construction, not by trust**: the function computes the new positions from the
order already stored and takes no order from its caller, so the most it can do
is close a gap. That is also why it may pass the worked-stop rule — it
preserves relative order, which is what that rule protects.

### Board and date independence `[§13]`
The sequence is isolated by `tenant + board + operational date`. The backend
re-queries the exact run being edited. Changing Board 1 / 25 August affects
neither Board 2 / 25 August nor Board 1 / 26 August.

### Concurrency `[§14]`
`sequence_version` is compared and swapped inside the transaction that writes
the positions. A stale editing session is refused with:

> *This run was updated by another user. Reload the run to see the latest
> sequence before making further changes.*

Deliberately **not** `updated_at`: that column moves for status changes and load
confirmation, so it would refuse saves over edits that never touched the order.
The day's token is the highest version across the board+date's runs and the swap
matches `<= expected`, so a run opened after the last save joins the day's token
rather than deadlocking against a neighbour.

### Worked stops `[§16]`
A stop that has been started, arrived at, delivered or cancelled cannot be
repositioned — **and this holds for the Owner too**, because no role makes it
true that work happened somewhere it did not. The screen names the stops
concerned and says why; it never fails silently.

### Audit `[§15]`
Every successful save writes one row through the existing `recordAudit`. It
carries the board, the run date, the run ids, the actor, their role, the
movement count, the resulting version and **both sequences in full** — because
"what was it before?" is the question an audit log gets asked about a run that
went wrong, and a movement count cannot answer it. The trail is append-only
(`0035`): there is no UPDATE and no DELETE policy on `audit_logs` at all.

The record is built by a **pure rule** (`buildSequenceAudit`) rather than inline
in the action, so the list above is asserted by tests rather than by reading. A
`"use server"` module may export nothing but server actions, so a payload
written inside one is unreachable from a test — and this codebase has shipped
three such contracts broken behind a green build for exactly that reason. No
timestamp is recorded: the database stamps it, and a client's idea of the time
would be a second answer to when this happened.

### The driver's view `[§17]`
`/my-runs` shows the saved order and prints each stop's position. A board or
driver sees no Adjust Run, no handles, no move controls and no Save. Inspection,
load confirmation, start route, delivery and pickup completion and the offline
outbox are all untouched.

### Mobile, tablet and keyboard `[§18]`
Move up / move down are real buttons at 44×44px and are always the equal path —
never a drag-only experience. Both routes call the same tested pure functions.
Verified with no horizontal overflow at 390 / 768 / 1440px in both themes.

---

## 11. Verification

### Logic — 36 assertions on the pure rules
Payload parsing, the movement count, what may move and what may not, the
concurrency token, and the audit record — the last checked against the list §15
names, field by field, including that both orders are copied rather than aliased
to arrays the action still owns.

### Database — `supabase/tests/run_sequence.test.sql`, 30 assertions

The ten proofs the specification requires `[§9]`, each mapped to the assertion
that carries it:

| # | Required proof | Result |
|---|---|---|
| 1 | Owner can update sequence | ✅ saves, version moves |
| 2 | Operations Manager can update sequence | ✅ saves, version moves |
| 3 | Dispatcher cannot | ✅ refused `42501` |
| 4 | Driver cannot | ✅ refused `42501` |
| 5 | Board cannot | ✅ refused `42501` |
| 6 | One tenant cannot touch another's run | ✅ filtered to nothing; entry point refuses `42501` |
| 7 | A forged run/stop id is rejected | ✅ refused `P0001` |
| 8 | A forged board/date is rejected | ✅ refused `P0001` |
| 9 | A locked run resists an unauthorised caller | ✅ refused, and the unlock refused too |
| 10 | A valid authorised update succeeds | ✅ exact order persisted, renumbered from 1 |

Plus: the stale-version refusal, the worked-stop refusal, board independence,
date independence, appending a new stop to a locked run, and repairing duplicate
positions.

### Interface — `/design-preview`, 26 interaction assertions
Driven in a real browser at 390 / 768 / 1440px, light and dark: locked by
default with nothing draggable and no Save anywhere; Adjust Run revealing 44×44
controls; the payload carrying the version; Cancel restoring the exact saved
order and returning to locked; a board seeing no control at all; a worked stop
disabled with its reason beside it. Zero console errors, zero overflow.

### Live — `laundrymart-syd`, 2026-08-25
Probed as **real sessions** in transactions that were then rolled back. A board
and a dispatcher, both of which can *see* the run, were refused `42501` with the
sentence, and both were refused the unlock. A driver was lent a stop inside the
rolled-back transaction — no ordinary driver login on this deployment can see
one, so probing without that would have proved RLS filtering rather than the
guard — and, **seeing the row**, was refused identically. The office manager
saved a real order and the version moved 1 → 2; reversing it was refused because
a stop had been worked; a stale session replaying version 1 got the concurrency
message.

After: 11 runs locked at version 1, both guards attached, **0 duplicate
positions**, and 16 stops / 8 laundry jobs / 647 invoices / 20 memberships /
5 boards / 508 archived customers all unchanged.

---

## 12. Where the delivered system differs from the original wording

Recorded so nobody reads a difference as an omission.

1. **The capability is `routes.sequence`, not `routes.sequence.write`.** The
   specification invited "another appropriately named capability". This name
   matches the existing `routes.read` / `routes.write` / `routes.status` family.

2. **Enforcement is a trigger, not an RLS policy** `[§9]`. Reasons in section 9.
   A restrictive policy would have broken a driver's ordinary writes to their
   own stops and would have refused in silence.

3. **"Editing state" is not persisted** `[§7]`. The specification listed
   "locked/editing state or equivalent" among the run metadata. Persisting an
   *editing* flag contradicts `[§6]`: if entering edit mode wrote, Cancel would
   have to write it back, and Cancel must write nothing. What is persisted is
   the **lock** — the standing statement that the order is management's, which
   the guard reads. Editing is a screen state.

4. **The dispatch planner moved to the same capability.** Not asked for, but
   required: `/routes/planner` also writes `jobs.sequence`, so leaving it on
   `routes.write` would have made the whole boundary a fiction — a dispatcher
   refused on the Runs screen could have reordered the same day there. It costs
   a dispatcher that screen, which is accepted: no rail row has pointed at
   `/routes/*` since 2026-08-14.

5. **Gap closing was newly built** `[§12]`. The existing `retireStopIfEmpty`
   soft-deleted a stop and never renumbered, so a run that lost its second call
   read `1, 3, 4` on the driver's phone. This requirement was not previously met
   at all.

6. **Migration numbering.** This repository's file is
   `0036_run_sequence_control`. The hosted project also carries an unrelated
   `0036_invoice_account_codes` from a branch not in this repository, applied
   the same day. Supabase keys migrations on timestamp, so nothing collided, but
   one of the two needs renumbering when that branch merges — the same situation
   recorded for the two `0015`s and the two `0017`s.

---

## 13. Non-goals, held `[§28]`

No new Runs subsystem. `jobs.sequence` not replaced. Board architecture,
offline driver execution and route execution unchanged. No automatic route
optimisation, no Google Maps, no GPS, no AI sequencing. Drivers cannot modify
the management sequence. Nothing relies on frontend hiding. The run is never
permanently editable.

---

## 14. Known limits and open items

- **A run is never auto-ordered.** A newly created run's stops sit in the order
  they were assigned until somebody presses Adjust Run. This is intended.
- **A stop with no run** (`route_id is null`) is not guarded — it has no
  management-decided order to protect. Only the dispatch planner's tray
  produces one.
- **`compact_run_sequence()` is admitted to any member of the tenant**, by
  design (section 10). It is order-preserving by construction, so the worst it
  can do is renumber `1, 3, 7` as `1, 2, 3`.
- **Persistence across a refresh, a fresh login and another device** `[§23, §27]`
  rests on both screens being `force-dynamic`: neither the office screen nor the
  driver's is cached, so every visit re-reads the saved order, and a save
  revalidates both. That is the mechanism; observing it in a browser belongs to
  the item below.
- **The screens have not been opened against live rows.** Every claim above is
  proved at the database level, in the component gallery, by live probe, or by
  the pure rules. Signing in as `owner@roles.example.com` and taking one real run
  through Adjust Run → Save & Lock Run is **the only part of this specification
  that cannot be settled without a login**.
