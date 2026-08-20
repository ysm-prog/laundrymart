# LaundryMart — Simplification Design Spec

*Companion to `SIMPLIFICATION-ROADMAP.md`. The roadmap says what is hard and
in what order to fix it; this document says how — as a solutions architect
(so every change fits the Server Actions + RLS architecture instead of
fighting it) and as a UI/UX designer (concrete screens, patterns and copy
inside the existing Plantline design system). Written 2026-08-05.*

**The one-sentence design brief:** make every screen answer, in the
operator's own words, "what should I do now?" — using the guided six-stage
run screen as the model, because it is already the best screen in the app.

---

## Part 1 — Architecture decisions (solutions architect)

The constraint that shapes everything: pages are async server components,
writes are server actions that redirect, RLS is the boundary, and there is
deliberately no client-side state framework. Every decision below preserves
that. Only two changes in this entire spec need a migration (AD-3, AD-4),
and they share one.

### AD-1. Flash messages: cookie flash, not URL params
**Decision:** `fail()`/`done()` keep their exact signatures but set a
one-shot cookie (`flash`, JSON `{tone, message}`, maxAge ~60 s) and redirect
to a clean path. The `(app)` layout reads and clears it, rendering a
`<Toast>` client component: success auto-dismisses after 5 s, errors stay
until dismissed. `FlashMessages` remains during migration; call sites move
by deleting their `?error=`/`?ok=` searchParams plumbing — ~40 sites, all
mechanical.
**Why not** a client toast library + action return values: that converts
every form to `useActionState` and makes pages client-stateful — a rewrite
of the app's core convention to fix a cookie-sized problem.

### AD-2. Wizards: client-side steps, one server action at the end
**Decision:** the agreement wizard is a single client component holding step
state in memory, posting once to the existing `createAgreement` action on
the final step. No draft rows, no schema change, no step-per-URL.
**Why not** step-per-URL with a draft record: durable but needs a draft
state machine and a migration; a 3-step form abandoned halfway should
simply be abandoned. The planner board already establishes this exact
pattern — compose locally, commit once, server re-validates everything.

### AD-3. One `tenants.settings jsonb` column carries all preferences
**Decision:** a single migration adds `settings jsonb not null default '{}'`
to `tenants`. It holds `ui_mode` ("simple" | "full"), notification
preferences (Phase C) and future per-tenant switches. Read once in the
`(app)` layout alongside the session; passed down like nav counts are today.
**Why not** a column per setting or a settings table: one jsonb column with
a Zod schema at the read site is the smallest thing that can hold "a bag of
tenant preferences", and it means Phases C and D share one migration.

### AD-4. Notifications: a table written by the code that already knows
**Decision:** `notifications` (tenant-scoped, `apply_tenant_policy` like
every other table): `id, tenant_id, created_at, audience` (capability
string — reuses the existing capability model for targeting), `kind, title,
href, read_at`. Two writers:
- **Server actions** insert at the moment they cause an event (inspection
  failed, batch stuck) — same transaction, no new infrastructure.
- **A swept check** for time-based events (invoice past terms, run not
  started past its window): one authed route hit by Vercel cron, inserting
  idempotently (`unique (tenant_id, kind, subject_id, date)` so a sweep can
  run twice without double-notifying).
The bell is a server component in the context bar using the exact pattern
of today's nav badges — count query per request, no websockets, no realtime
subscription. At this scale, refresh-on-navigate is honest and boring.
**Why not** Supabase Realtime: a laundry ops app does not need live push;
it needs the count to be right when you look at it.

### AD-5. IA consolidation: merge the three stop lists
**Decision:** Jobs, Pickups and Deliveries become one screen — **Stops** —
with filter tabs (All · Pickups · Deliveries · Problems). They are already
one concept: a job *is* a stop, pickups/deliveries are its two halves. Old
URLs 301-redirect; the exceptions list becomes the "Problems" tab and the
nav badge moves with it. This shrinks even full-mode nav by two items and
removes the "how is a job different from a pickup?" question entirely.
**Why safe:** all three pages are reads over the same `jobs` spine; RLS and
actions are untouched.

### AD-6. Simple mode is a filter, not a fork
**Decision:** `ui_mode: "simple"` does exactly two things: the nav renders
the 8-item map (Part 2) instead of the full one, and Admin → Users offers
three role *presets* (Owner → `operations_manager`, Office → `dispatcher`,
Driver → `driver`) with "advanced roles" behind a disclosure. No capability,
policy or route changes — a simple-mode tenant that types a full URL still
gets the page if their role allows it. One rendering decision, zero
security surface.

### AD-7. Users screen: resolve identities via the admin client
**Decision:** the page already runs server-side with `admin.read`; use
`createAdminClient().auth.admin.listUsers()` filtered to the membership
`user_id`s of the current tenant, mapping id → email/name. Invite (Phase D)
is the same admin client creating the user + membership and sending the
login page's existing magic link. No migration.
**Guard:** the admin client bypasses RLS — the lookup must start from the
tenant's membership rows, never list-and-filter globally.

### AD-8. Global search: one page, N tenant-scoped queries
**Decision:** `/search?q=` runs parallel RLS-bound queries (customers,
invoices by number, jobs by number, vehicles by rego, agreements by number)
each `limit 5`, rendered in groups. The context-bar form just changes its
`action`. Postgres `ilike` on already-indexed identifier columns; no search
engine, no new index until proven needed.

### AD-9. Confirmation: a disclosure, not a modal
**Decision:** a small client component, `<ConfirmSubmit>`: first tap swaps
the button for an inline strip — one line stating the consequence
("This closes the run for the day. It cannot be reopened."), an optional
reason field (the void-invoice pattern generalised), Confirm and Cancel.
The form still posts to the same server action; the component is pure
presentation.
**Why not** a modal dialog: the design system is flat and square with one
faint shadow; an overlay is a new pattern and modals on mobile (the driver)
are exactly where mis-taps happen. Inline keeps the consequence next to the
button that causes it.

### What is deliberately not changed
Routes and schema names (labels change, URLs and tables don't, except the
AD-5 redirects) · the offline outbox · RLS/tenancy · the domain layer ·
the design tokens. And the run screen's stage pattern is promoted from
"nice screen" to *the* pattern (Part 2, P-1).

---

## Part 2 — UX design (UI/UX designer)

### Voice: five copy rules
1. **Address the person, not the schema.** Never "child transactions",
   "row-level security", "Supabase". If a sentence describes the data
   model, it belongs in a code comment.
2. **Verbs on buttons, outcomes in messages.** "Create this month's
   invoices" not "Generate period"; "Invoice INV-0042 sent to
   accounts@hotel.com" not "OK".
3. **Trade term in brackets on first use**: "Contracts (service
   agreements)" — then the plain word thereafter.
4. **Every dead end names the way out.** No empty state, error or notice
   without a linked next action.
5. **Say what's final.** Any irreversible action states it in the confirm
   strip, in plain words.

### The rename map
| Now | Becomes | Note |
|---|---|---|
| Depots | Sites | "depot" stays in reports for the trade audience |
| Exceptions | Problems | tab within Stops (AD-5) |
| Service agreements | Contracts | subtitle: "(service agreements)" |
| Route templates | Weekly runs | they are the recurring week |
| Daily routes | Today's runs | |
| Dispatch planner | Plan the day | |
| Jobs / Pickups / Deliveries | Stops | one screen, AD-5 |
| Generate period | Create this month's invoices | period pre-filled |
| Inventory → "Record a movement" | "Adjust stock" | |
| Users and roles | People | |

### Simple-mode navigation (8 items, 2 groups)
```
TODAY                    SET-UP
  Home                     Customers
  Today's runs   (n)       Contracts
  Stops          (n)       Invoices    (n)
  Problems       (n)       Settings
```
"Settings" gathers Sites, People, Public holidays, Weekly runs, Vehicles,
Drivers, Items as sections of one screen — set-up furniture a small
operator touches monthly, not daily. Full mode keeps today's nav (minus the
AD-5 merge). Reports stay in full mode only; the numbers a simple-mode
owner needs daily are on Home.

### P-1. The pattern: numbered stages, one live at a time
The run screen's `Stage` component (numbered circle → tick, exactly one
step actionable) is extracted into `ui.tsx` and becomes the app's guidance
pattern, reused by:
- **Getting-started checklist** (Home, empty tenant): 1 Add your site →
  2 Add a customer → 3 Create their contract → 4 Set up the weekly run →
  5 Plan today. Ticks driven by row counts; each stage's button deep-links
  to the creation screen; the wizard returns you to the checklist.
- **Agreement wizard** (P-3) — the same visual grammar for its 3 steps.
- **Invoice pane "Do next"** — already conceptually this; adopts the visual.

First-timers then learn one idiom on day one and meet it everywhere.

### P-2. Home (dashboard), simple mode
Top to bottom, one column on mobile:
1. **"Needs attention" strip** — the existing "Needs a decision" list,
   renamed, each row a plain sentence with the action verb on the right:
   "Harbour Hotel's invoice is 12 days overdue — **Chase** / **Record
   payment**".
2. **Today at a glance** — three Stats max in simple mode (runs out,
   stops done/total, unpaid invoices $ if `invoices.read`).
3. **Runs today** rail (exists) — each run showing its stage number from
   the driver's six stages, so the office sees "run 2 is at stage 3 of 6".
4. Empty tenant: the whole page is the getting-started checklist and
   nothing else. One obvious thing to do.

### P-3. Agreement wizard (3 steps, one post)
- **Step 1 — Who and when** (3 fields): customer (with inline "+ new
  customer" that opens the 4-field quick-create), site (auto-selected when
  the customer has one), start date (default today). Everything else —
  terms, PO, surcharges, holiday rule — behind "Billing details" collapsed,
  pre-filled with defaults (terms 14, surcharges 0, monthly, follow-holiday
  rule).
- **Step 2 — Service days**: one `WeekdayPicker` labelled "We collect on…"
  and a default-on checkbox "and deliver the clean linen the next service
  day" — the two-pattern editor appears only when that box is un-ticked.
  This makes the common case (delivery follows pickup) one control.
- **Step 3 — What and price**: item rows (item, qty, unit price), "simple:
  one price per item" as the default model; "Advanced pricing" discloses
  per-kg, included allowances, minimum charge. Live plain-English summary
  on the right: "Every Mon & Thu we collect ~40 sheets. You bill about
  $210/week + GST."
- Post once → `createAgreement` unchanged → toast: "Contract AGR-0007
  created. It starts appearing on runs from Monday." with the link.

### P-4. Customer quick-create
Four fields (business name, phone, billing email, site address) create the
customer; "Billing details" and "More" are collapsed sections with defaults.
The same quick-create is embeddable in wizard step 1. ABN moves to billing
details, optional at creation, still validated when present.

### P-5. Driver: problems without leaving the run
On the capture card, alongside Pickup/Delivery: a "Something's wrong"
disclosure — reason select (the existing `EXCEPTION_REASONS`), a note, an
optional photo, one submit. Goes through the offline outbox like every
other capture; the job-page form remains for the office. The inspection
checklist starts unchecked with a single "All checks OK" button that ticks
every box in one deliberate tap (A8): the fast path is one affirmative act,
not a pre-signed form.

### P-6. Toast and confirm, in the design system's accent
- **Toast:** bottom-right (bottom-center mobile), same visual grammar as
  `Notice` — hairline border, 5px left rule in the status colour, square
  corners, no new shadow. Success auto-dismisses in 5 s with a visible
  timer rule; errors persist with a dismiss ×. Colour keeps meaning status;
  the toast is never teal-branded.
- **Confirm strip (AD-9):** replaces the button in place; consequence
  sentence in `text-2xs` mono uppercase eyebrow ("CANNOT BE UNDONE") over
  plain-English detail; Confirm is the near-black `--action` button, Cancel
  is a ghost. Reason field appears where the action demands one.

### P-7. Empty-state spec
Every `EmptyState` gets three parts, enforced by making `description` and
`action` required props: what this screen will show · why it's empty now ·
one button to the action that fills it. Audit list = every page in §6 of
CLAUDE.md.

### Accessibility & mobile notes
Toasts announce via the existing `role="status"`; the confirm strip keeps
focus where the button was; wizard steps are one `<form>` with real
buttons, so keyboard and screen-reader flows are native. Simple-mode nav
fits one thumb-reach column in the existing mobile drawer. Nothing here
adds an overlay, so no focus-trap machinery is needed.

---

## Part 3 — Build order (maps to roadmap phases)

| Roadmap | This spec | Migration? |
|---|---|---|
| A1 toasts | AD-1, P-6 | no |
| A2 renames + glossary | rename map, voice rules | no |
| A3 empty states | P-7 | no |
| A5 checklist | P-1, P-2 | no |
| A6 user names | AD-7 | no |
| A7 confirms | AD-9, P-6 | no |
| A8 inspection | P-5 (last ¶) | no |
| B1–B2 wizards | AD-2, P-3, P-4 | no |
| B3 plan my day | P-2 (+ existing planner) | no |
| B5 run problems | P-5 | no |
| C notifications | AD-3, AD-4 | **one** (settings + notifications) |
| D simple mode | AD-3, AD-6, nav map | shares the above |
| D consolidation (AD-5) | Stops merge + redirects | no |
| D search | AD-8 | no |

Sequencing note: AD-5 (Stops merge) is scheduled with Phase D in the
roadmap but has no dependency — it can ship any time the rename pass ships,
and doing it early makes every later screen count smaller.

## Part 4 — The three forks worth an owner's decision
1. **Simple mode default for the existing tenant?** New tenants default
   simple; flipping the seeded live tenant changes screens under current
   users' feet. Recommend: default `full` for existing, `simple` for new.
2. **"Stops" as the merged name** — or keep "Jobs" as the trade term with
   tabs? Recommend Stops; drivers already hear "stops".
3. **Overdue-chase email tone and threshold** (Phase C3): days past terms
   before the first reminder, and whether reminders repeat. Needs the
   owner's voice — it goes to their customers.

Everything else in this document is reversible presentation and needs no
sign-off to start.
