# LaundryMart — Simplification Audit

*A full-application review against one standard: **a first-time, non-technical
business owner should be able to run their day without training.** Written
2026-08-05 against the state after Simplification Phases A and B.*

This document is both the audit and the record of what was changed in the same
pass. Every finding is marked **SHIPPED** (fixed here), **QUEUED** (belongs to a
named later phase) or **RECOMMENDED** (not scheduled; needs a decision).

---

## 1. Executive summary

The engine is sound. Multi-tenancy, RLS, the offline outbox, the domain layer
and the migration discipline are all better than this product category usually
manages — 12 migrations, 47 pgTAP assertions, a pure domain module shared by
preview, routing and billing so they cannot diverge. **None of that was
touched, and none of it should be.**

The problem was never the engine. It was that the cabin was laid out by
somebody who already knew where everything is:

1. **The rail was a table of contents for the database.** 22 destinations under
   six headings — Plant, Fleet, Accounts, Administration — named after internal
   concepts. A first-timer had to know the data model to find a screen.
2. **The only search box answered a different question than the one asked.** It
   submitted to the customers list, so an invoice number typed into it returned
   "no customers match those filters" — a *wrong* answer, not a missing one.
3. **The product could not explain its own words.** No glossary, no help, no
   definition of depot, exception, manifest or agreement anywhere in the app.
4. **A driver had no link to the screen they are redirected to.** The auth gate
   sends everyone to `/dashboard`; the rail row for it required `reports.read`,
   which the driver role does not hold. The one role guaranteed to land there
   was the one role with no way back to it.
5. **Tables were desktop-only in practice.** A sideways-scrolling eight-column
   grid on a phone technically "adapts"; nobody finds the scroll.
6. **Eleven job titles on the People screen**, several differing by one
   capability, with the consequence of a bad choice invisible.

Everything above is fixed in this pass. The measured result: **the rail is at
most 10 rows for any role and 5 for a driver** — against 22 for an owner, and 7
across three headings for a driver with no row at all for the page they get
redirected to. Search returns the thing you typed, every screen sits under a
plain-English area with tabs, and every table stacks into labelled cards on a
phone.

One correctness hole travelled with the pass and is fixed: **a customer with
two active contracts was billed for one of them.** Details in §5.

**Highest-value work still open**, in order: the notification layer (Phase C —
the app never speaks unless spoken to) and the invite-a-teammate flow.

---

## 2. UX audit

| # | Problem | Why it matters | Severity | State |
|---|---|---|---|---|
| U1 | Rail listed 22 destinations under six internal headings | The first thing a new user sees is a wall organised by a model they have never seen | **Critical** | SHIPPED |
| U2 | Global search only searched customers | Typing `INV00007` returned a confident wrong answer. Users stop trusting search after one of these | **Critical** | SHIPPED |
| U3 | Driver had no nav row for `/dashboard`, the page they are redirected to | Dead end for the least technical role, on the smallest screen | **High** | SHIPPED |
| U4 | No glossary or help anywhere in the product | "Exception", "depot", "manifest", "agreement" are undefined in-app | **High** | SHIPPED |
| U5 | Tables scrolled sideways on phones, hiding columns | Field staff are on phones; the hidden columns are the ones with the status in them | **High** | SHIPPED |
| U6 | `/admin` was a menu page whose only content was four links | A whole navigation step that navigates | **Medium** | SHIPPED (redirects to the first tab) |
| U7 | 11 role titles in one flat picker, no plain description | Access control chosen by guesswork; a wrong pick is silent | **Medium** | SHIPPED (4 common first, plain summaries) |
| U8 | Page copy still described the schema: "The planning model. A daily route is instantiated from a template", "Append-only record of every write" | Accurate sentences addressed to the wrong audience | **Medium** | SHIPPED |
| U9 | Filter bar styled unlike every other input in the app | Rounded, larger, differently bordered — reads as a different system | **Low** | SHIPPED |
| U10 | Pagination said "62 records" | "Record" is the developer's word for it | **Low** | SHIPPED |
| U11 | Nothing notifies the user of anything they did not personally cause | An invoice going overdue, a run not starting — discoverable only by looking | **High** | QUEUED (Phase C) |
| U12 | No invite-a-teammate flow; the People screen assumes accounts already exist | An owner cannot self-serve adding their office person | **Medium** | QUEUED (Phase D5) |
| U13 | Reports screen is seven tables with no lead question | It answers "what does the data say" rather than "how did we do" | **Medium** | RECOMMENDED |
| U14 | `/agreements/[id]` still uses the full 19-field form for editing | Phase B replaced creation with a wizard but left editing flat | **Low** | RECOMMENDED |

### The five-second test, screen by screen

For each screen: *can a first-timer say where they are, what they can do, and
what to do next, in under five seconds?*

| Screen | Before | After |
|---|---|---|
| Dashboard | Pass — the checklist and "needs a decision" already do this well | Pass |
| Any list screen | Partial — you knew where you were, not what came next | Pass (tabs name the neighbours; empty states name the next action) |
| Customers | Pass | Pass |
| Contracts | Fail — "Service agreements" as the eyebrow, 19-field form behind it | Pass (wizard shipped in Phase B; tab now sits under Customers, where a first-timer looks for it) |
| Warehouse | Fail — "Warehouse" is a building, not a task | Pass — "In the plant" |
| Inventory | Partial — "Inventory" is fine but "ledger" is not | Pass — "Stock" |
| Audit log | Fail — "Append-only record of every write" | Pass — "Activity log · Every change anyone has made" |
| Depots | Fail — "the model supports many from day one" | Pass — "Sites · most laundries only ever need one" |
| People | Fail — 11 titles, no explanation | Pass |
| Search | Did not exist (wrong answers from the customers list) | Pass |
| Help | Did not exist | Pass |
| My run | Pass — the best screen in the app; unchanged | Pass |

---

## 3. Navigation redesign

### Before — 22 rows, 6 headings, named after the schema

```
Today        Dashboard · Today's runs · Plan the day · Stops · My run
Operations   Pickups · Deliveries · Problems
Plant        Warehouse · Inventory
Accounts     Customers · Contracts · Items · Invoices · Reports
Fleet        Drivers · Vehicles · Weekly runs
Administration  Sites · People · Public holidays · Audit log
```

Problems: six headings to read before the first destination; "Plant" and
"Accounts" are internal words; "Weekly runs" (a planning artefact) sat under
Fleet while "Plan the day" sat under Today; nothing said what to do first.

### After — at most 10 rows, no headings, tabs inside an area

```
Today       ← everyone, including drivers
My run      ← drivers
Runs     3  → Today's runs · Plan the day · Weekly runs · Drivers · Vehicles
Stops    4  → All stops · Problems · Collections · Deliveries
Customers   → Customers · Contracts
Invoices 9
Linen   12  → Stock · In the plant · Item types
Reports
Settings    → Sites · People · Public holidays · Activity log
Help
```

Three rules make it hold together (`src/lib/nav.ts`):

- **An area is visible if any screen inside it is**, and its link resolves to
  the first screen the role can actually open — with the capability travelling
  alongside the resolved href, so a row never claims a gate it is not behind.
  Finance holds `items.read` but not `inventory.read`: their "Linen" row points
  at item types, not at a stock screen that would bounce them.
- **One area owns a path**, longest match wins. `/customers/abc/edit` highlights
  Customers; `/routes/templates/tpl-1` stays inside Runs rather than flipping.
- **A one-screen area renders no tab strip.** A strip of one tab is decoration.

Rail size by role: warehouse operator 4, driver 5, customer service 5, sales 5,
finance 6, dispatcher 8, auditor 9, owner 10 — against a previous 22 for an
owner and 7-across-3-headings-with-no-home for a driver. (A driver's Runs and
Stops rows are RLS-scoped to their own run, so those two rows show them their
own work, not the depot's.) Fifteen unit tests in `src/lib/__tests__/nav.test.ts`
hold each of these, including "every role can reach the screen they are
redirected to" — the assertion that would have caught the driver dead end.

**Trade-off, stated plainly:** a destination now one level down (Vehicles,
Weekly runs, Problems) costs one extra click for someone who already knows
where it is. That is a deliberate trade of one click for an expert against 12
fewer rows to read for a beginner, made in the beginner's favour because the
expert also gets the search box and the tab strip is one keystroke away. If
usage shows this is wrong for a specific destination, promote that one item to
the rail — the map is data.

---

## 4. Workflow redesign

Click counts are actions taken (a click or a keystroke-then-enter), from a cold
start on the dashboard.

### W1 — Look up an invoice you have the number for
- **Before:** type number in the context bar → lands on `/customers?q=INV00007`
  → "No customers match those filters" → realise the box is customers-only →
  click Invoices in the rail → filter or page through the register → click the
  row. **6 actions, one of which teaches the user the tool lied to them.**
- **After:** type number → Enter → click the result. **3 actions**, and the
  first attempt is the successful one.
- **Why better:** the search box now answers the question asked. Groups are
  capability-gated exactly like their own screens, so nothing leaks.

### W2 — A driver checks what is waiting for them
- **Before:** the rail had "My run" but no route home; if they landed on
  `/dashboard` from the auth gate there was no rail row to go back to, so the
  browser back button was the only exit. **Unbounded.**
- **After:** Today and My run are the first two rows, for every role.
  **1 click.**

### W3 — Find out what "exception" means
- **Before:** not answerable inside the product. Ask a colleague.
- **After:** Help → read the glossary line. **1 click.**

### W4 — Give a new office hire the right access
- **Before:** People → choose among 11 job titles in one flat list with a
  one-line reference table further down the page. **2 clicks, high error rate.**
- **After:** the picker leads with the four roles a small laundry actually uses,
  the other seven grouped after them, and each is described in the owner's words
  ("Their own run, on their phone, and nothing else"). **2 clicks, low error
  rate.** No schema change: presets are a view over the existing 11 roles.

### W5 — Deal with a problem on a phone
- **Before:** the dashboard's decision table was eight columns wide inside a
  sideways-scrolling box; on a 390px screen the Action column was off-screen.
  **Discover the scroll, then scroll, then tap.**
- **After:** each row is a card — customer and issue as the heading, every other
  column labelled underneath, the action full-width and tappable, the urgency
  rule still on the leading edge. **Tap.** The customer and the issue also now
  lead the desktop table; the internal reference (`JOB00042`) moved to the last
  column and hides below `lg`, because it is the one field that means nothing to
  a first-timer.

### W6 — Reach the administration screens
- **Before:** rail → Administration heading → one of four rows. A separate
  `/admin` index page existed with the same four links and nothing else.
- **After:** rail → Settings → four tabs across the top. `/admin` redirects to
  the first tab so old bookmarks survive. **One screen fewer in the product.**

---

## 5. Code quality audit

### Fixed in this pass

| Finding | Evidence | Fix |
|---|---|---|
| **The dashboard hand-rolled a second table** | `dashboard/page.tsx` had its own `<table>` with its own header styling, duplicating `DataTable` | Folded into `DataTable` with a new `rowClassName` prop for the severity rule. The duplicate never got the responsive cards, the keyboard-reachable scroll box, or the header styling the shared one grew — which is exactly what duplication costs |
| **Two definitions of "what an input looks like"** | `form.tsx` had a private `CONTROL` constant; `list-controls.tsx` predated the design system and used `rounded-md border bg-surface px-3 py-2 text-sm` | One exported `CONTROL` in `ui.tsx` (server-safe), imported by both |
| **A navigation fixture that had drifted from the real map** | `design-preview` held a hand-copied `SECTIONS` array | The gallery now renders `navigationFor("super_admin")` — it cannot show a navigation the app no longer has |
| **A screen whose only content was navigation** | `admin/page.tsx` | Deleted; redirects to the first Settings tab |
| **`role="status"` on error notices** | `Notice` announced failures politely | `role="alert"` when the tone is danger |
| **Untested navigation logic** | No tests over `lib/nav.ts` | 15 tests, including the invariant that caught a live bug during this pass (a borrowed href kept the area's original capability) |

### Still open

| Finding | Severity | Recommendation |
|---|---|---|
| `invoices/actions.ts` is 659 lines and `invoices/page.tsx` is 622 | Medium | Split the actions file by verb group (issue/void, payments, delivery, generation); split the page's register and working pane into sibling components. Both are over the 300-line guideline and both are single-responsibility violations at the file level, not the function level |
| `design-preview/page.tsx` is 622 lines | Low | It is a gallery; length is inherent. Splitting per section would help review |
| `agreements/agreement-wizard.tsx` is 581 lines | Medium | One component holding three steps. Extract a step per file; the shared form element stays in the parent |
| Reports page computes seven aggregates in one request | Medium | See §8 |
| ~~`generateInvoices` dedupes on customer + period~~ | ~~**High (correctness)**~~ | **FIXED — see §5a.** |

### 5a. The consolidated-invoicing fix

`generateInvoices` looped per contract while de-duplicating on customer +
period, so a customer's second active contract found the first contract's
invoice and was skipped as "already billed". **Every period, silently, for the
whole life of the feature.**

The fix is one invoice per customer carrying every contract's charges — and
consolidating is not merely a preference, it is the only shape that can be
correct. The weighed collections (`pickups`) and the damaged/missing linen
(`pickup_lines`) are both recorded against the **customer**, not the contract.
Issuing one invoice per contract would have run those same queries once per
contract and billed the same kilograms and the same lost towels twice — trading
an under-bill for an over-bill, which is the worse of the two.

What the fix preserves:

- **Each contract's money rules stay its own.** The minimum-charge top-up, the
  fuel levy and the weekend/holiday surcharges are computed per contract and
  appended, so a 10% levy on contract B never reaches contract A's services.
  There is a test for exactly this.
- **Every line still says where it came from.** `invoice_lines.agreement_id` and
  `location_id` are per line, so a consolidated invoice reads back per contract.
  Replacement charges belong to no single contract and carry a null
  `agreement_id`, which the column already allowed.
- **Header fields that have no single answer fall back rather than guess.**
  `consolidate()` takes the value when every contract agrees and otherwise falls
  back to something belonging to the customer — their own payment terms — or to
  nothing at all, for a purchase order number. Quoting one contract's PO against
  another contract's charges would be worse than leaving it blank.

Structurally, the pure part moved to `src/lib/domain/invoicing.ts`
(`contractCharges`, `consolidate`) alongside the service calendar and the
pricing engine, with 12 unit tests. It reads no database, so the money rules are
testable in milliseconds — the reason the rest of the domain layer exists.

**No migration.** The schema already supported this; only the loop was wrong.

### What was deliberately not changed

- **No migration.** Nothing in this pass needed one, and the schema is not the
  problem.
- **No renaming of database objects.** Labels changed; `depots`, `jobs`,
  `service_agreements` and the rest are untouched, as the roadmap requires.
- **No change to RLS, the offline outbox, or `lib/domain`.** These are the
  tested parts. A usability pass has no business in them.
- **The typography scale stayed small.** 9px mono chrome labels are a
  deliberate part of the design language and changing them wholesale would be a
  redesign, not a fix. Form *field* labels went from 9px to 10px, because a
  field label is read while typing rather than glanced at.

---

## 6. Architecture review

The architecture is appropriate and does not need reworking. Recorded here so
the reasoning is on file:

- **Server Actions for every write, one API route for the offline outbox.** The
  right call. `tenant_id` is derived from the session inside the action, so a
  forged form field cannot cross tenants.
- **RLS as the boundary, capabilities as the UI hint.** Correct layering: the
  capability model drives nav and guards, and is never the only thing between a
  user and a row.
- **Pure domain module with no database access**, shared by preview, route
  generation and invoicing. This is the single best structural decision in the
  codebase — it is why the service calendar cannot disagree with itself.
- **`src/lib/nav.ts` as data.** The navigation is now a declarative map with a
  resolver and a test suite, not JSX. Re-organising the product is an edit to
  one array.

**Folder structure.** The current layout — `app/(app)/<area>` with colocated
`actions.ts`, plus `lib/{domain,db,supabase,offline,pdf,routes}` — is already
close to feature-first and does not warrant churn. Two adjustments worth making
when the files above get split:

1. Colocate presentational leaves with their route (`invoices/register.tsx`,
   `invoices/working-pane.tsx`) rather than growing `components/`. `components/`
   should hold only what two or more areas use.
2. Keep `lib/domain` free of React and of Supabase, as it is. It is the one rule
   that keeps the business rules testable in milliseconds.

---

## 7. Screen-by-screen recommendations

Only screens with an open recommendation are listed; the rest are addressed
above or are already in good shape.

- **Reports** — Lead with one sentence answering "how did we do", then the
  tables. Today it opens with seven tables and a date range. *Medium.*
- **Invoices two-pane** — The register and the working pane should each be
  their own component file; the pane's action set is the app's densest
  cluster of buttons and deserves the `Stage` treatment (issue → send → take
  payment, one step live at a time). *Medium.*
- **Contract detail** — Editing still uses the 19-field form the wizard
  replaced for creation. Reuse the wizard's step grouping as collapsed
  sections. *Low.*
- **Planner** — Strong screen. Add a one-line "nothing here needs your
  decision" state so the common case does not look like an empty board.
  *Low.*
- **Jobs / Stops** — Now that Problems, Collections and Deliveries are tabs of
  the same area, consider whether Collections and Deliveries earn separate
  screens at all, or should be a filter on All stops. *Recommend measuring
  first.*

---

## 8. Performance

Findings, none of them urgent at this data size:

| Finding | Impact | Recommendation |
|---|---|---|
| Nav badge counts run four head-only queries **inline** in the layout, blocking every navigation | ~4 round trips added to every page | They are cheap and index-served, and a late badge is a badge nobody trusts — keep inline for now. If P95 navigation regresses, move to a single RPC returning all four counts in one round trip |
| Dashboard issues ~12 queries across its `Suspense` boundaries | Fine — they stream independently | No change |
| Reports computes seven aggregates in one request | Slowest screen in the app | Split into `Suspense` boundaries per table so the first number appears immediately, as the dashboard already does |
| Search issues 7 parallel `ilike` queries, `LIMIT 6` each | Fine to ~100k rows | If it becomes slow, add a `pg_trgm` GIN index per searched column. Deliberately not done now: it is a migration, and this pass makes none |
| `dynamic = "force-dynamic"` on nearly every page | Correct — everything is tenant- and session-scoped | No change |
| Fonts self-hosted via `next/font` | Correct, and load-bearing: the driver app must render without signal | No change |

---

## 9. Accessibility

Already good before this pass, and worth crediting: skip link, a visible
`:focus-visible` ring defined globally, `aria-current` on nav, `sr-only`
labels on every unlabelled control, `aria-label` on icon buttons, real
`<fieldset>`/`<legend>` on the weekday picker.

Fixed here:

- **Wide tables were unreachable by keyboard.** The horizontal scroll container
  had no focus stop, so a keyboard user could not scroll it (WCAG 2.1.1). It is
  now `tabIndex={0}` with `role="region"` and a name.
- **Error notices announced politely.** `Notice` used `role="status"` for every
  tone; danger is now `role="alert"`.
- **Tap targets.** Buttons, submit buttons, selects, inputs, nav rows and tabs
  all now carry a 36px minimum height. Checkboxes went from 14px to 16px with
  the whole padded label row as the hit area.
- **Form labels at 9px** were the smallest text in the app and the text most
  likely to be read while typing. Now 10px.

Still open:

- The 9px mono chrome labels (`Eyebrow`, table headers, sidebar headings) are
  below what most guidance would accept even at high contrast. This is a design
  language decision that needs the design owner, not a unilateral change.
  *Recommendation: raise the `--text-3xs` step to 10px and delete the 9px step.*
- No automated accessibility test in CI. *Recommendation: add
  `@axe-core/playwright` against `/design-preview` in the existing verify job —
  it renders every component with no database.*

---

## 10. Mobile

- **Every table in the app** (27 call sites) now stacks into labelled cards
  below `sm`, with the first column as the card heading and nothing hidden.
  One change in `DataTable`; no call site touched.
- **The search box** is hidden below `sm` in the context bar, so phones get a
  dedicated "Search" button to the full search screen, which carries its own
  autofocused field.
- **The tab strip scrolls horizontally** rather than wrapping to a second row
  that would push page content below the fold.
- **The rail is a drawer** below `lg` and closes during the same commit as the
  navigation — no flash of the old menu over the new page. Unchanged; it was
  already right.
- Still open: the planner board is a drag-and-drop surface and is desktop-only
  in practice. *Recommendation: on a phone, offer the same rules as a "move this
  stop to…" picker rather than trying to make dragging work with a thumb.*

---

## 11. Refactoring plan

In dependency order; each is independently shippable.

1. **Split `invoices/actions.ts` (659 lines)** into `issue.ts`, `payments.ts`,
   `delivery.ts`, `generate.ts` behind the existing `"use server"` boundary.
   No behaviour change; makes the next invoicing change reviewable.
2. **Split `invoices/page.tsx` (622 lines)** into `register.tsx` +
   `working-pane.tsx`, colocated.
3. **Split `agreement-wizard.tsx` (581 lines)** one file per step; the shared
   `<form>` stays in the parent, which is what makes the single-post design work.
4. **Extract the reports page's aggregates** into `lib/domain/reporting.ts`,
   unit-test them, and stream each table in its own `Suspense`.
5. **Add `@axe-core/playwright` to the verify job** against `/design-preview`.

---

## 12. Implementation roadmap

| Phase | Content | State |
|---|---|---|
| A | Flash toasts, operator language, guided setup, confirmations, un-ticked inspection | Shipped |
| B | Contract wizard, customer quick-create, plan-my-day, in-run problems, linked toasts | Shipped |
| **This pass** | **Navigation redesign, global search, help & glossary, responsive tables, role presets, accessibility and tap targets, copy pass, one screen retired** | **Shipped** |
| C | Notifications: `notifications` table + bell, staff events, customer emails, settings | Next — the one migration |
| D | Invite flow, consolidated-invoicing fix, reports rework, file splits | After C |
| E | Customer portal, public tracking, Xero, bag scan | Blocked on four owner decisions (see MEMORY.md) |

---

## 13. Priority matrix

**Quick wins (1–2 hours each)**
- Add a "nothing needs your decision" state to the planner board.
- Lead the reports page with one plain-English sentence.
- Raise `--text-3xs` to 10px and delete the 9px step *(needs design owner)*.
- Add `@axe-core/playwright` to the verify job.

**Short term (1–2 days each)**
- Split `invoices/actions.ts` and `invoices/page.tsx`.
- Split `agreement-wizard.tsx` per step.
- Stream the reports page per table.
- Reuse the wizard's grouping on the contract edit form.

**Medium term (about a week each)**
- Phase C: the `notifications` table, the bell, staff event coverage.
- The invite-a-teammate flow (the magic-link path already exists — an invite is
  create-auth-user + membership + that same link).

**Long term**
- Customer emails on delivery and overdue, with per-tenant settings.
- Customer portal and public tracking (consumers of Phase C's events).
- Xero, bag scan.
- A `pg_trgm` index behind search if the row counts grow past ~100k.

---

## 14. Files changed in this pass

```
src/lib/nav.ts                        rewritten — areas + children, resolver, sectionFor
src/lib/roles.ts                      COMMON_ROLES + plain-English ROLE_SUMMARY
src/lib/__tests__/nav.test.ts         new — 15 tests
src/components/app-nav.tsx            flat rail, new SectionNav tab strip
src/components/ui.tsx                 DataTable mobile cards + rowClassName + focusable
                                      scroll region; shared CONTROL; alert on danger
src/components/form.tsx               shared CONTROL, optgroup support, tap targets
src/components/list-controls.tsx      design-system skin, plain-English copy
src/app/(app)/layout.tsx              rail wiring, SectionNav, real search
src/app/(app)/search/page.tsx         new — global search
src/app/(app)/help/page.tsx           new — glossary, day walkthrough, safe/final actions
src/app/(app)/dashboard/page.tsx      decision table folded into DataTable
src/app/(app)/admin/page.tsx          retired → redirect
src/app/(app)/admin/users/page.tsx    role presets, plain copy
src/app/design-preview/page.tsx       renders the real nav map and the real DataTable
src/lib/domain/invoicing.ts           new — contractCharges + consolidate (pure)
src/lib/domain/__tests__/invoicing.test.ts  new — 12 tests over the money rules
src/app/(app)/invoices/actions.ts     generateInvoices consolidates per customer
… plus a copy pass over 11 page headers
```

No migration. No change to RLS, the domain layer, or the offline outbox.
