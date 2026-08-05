# LaundryMart — Simplification & Redesign Roadmap

*A business-analyst review of the shipped app, judged against one standard: a
non-technical person, using the app for the first time, should be able to run
their day without training. Written 2026-08-05 against the state described in
CLAUDE.md (stages 1–3 of the Plantline redesign complete).*

---

## 1. What already works in the first-timer's favour

Credit where due — these should be preserved through any redesign:

- **Error messages are written in plain English.** "This customer has no billing
  email. Add one, or type an address to send to." is exactly the right voice.
  The `describeDbError()` helper translates database codes into human sentences.
- **The database enforces the business rules**, so a confused user cannot break
  the books — a run can't start without an inspection, an invoice recalculates
  itself, stock moves atomically. Guard rails exist; they're just invisible.
- **Empty states exist** on most list pages, and a few already point at the next
  step ("No depots yet — add your first depot before creating routes").
- **The dashboard is exception-first** ("Needs a decision") rather than a wall
  of charts, and nav badges show live counts.
- **The driver's day is already simple**: one "My run" screen, works offline,
  photos and signatures built in.

The problems below are therefore about *guidance, language, and feedback* — not
about rebuilding the engine.

## 2. Findings — where a first-time operator gets lost

### F1. The navigation is an inventory of the database, not of the user's day
An admin sees **22 destinations across 6 groups**. The groups are named after
internal concepts (Plant, Fleet, Operations, Accounts) and several labels are
jargon a first-timer must already know:

| Current label | What a first-timer would call it |
|---|---|
| Depots | Sites / branches |
| Exceptions | Problems / things that went wrong |
| Service agreements | Customer contracts |
| Route templates | Regular weekly runs |
| Dispatch planner | Plan today's runs |
| Jobs | (unclear how a "job" differs from a pickup, a stop, or a run) |

Nothing in the nav says *what to do first* or *what to do next*.

### F2. The big forms front-load every decision
- The **agreement form is 19 fields on one page** — fuel levy %, weekend
  surcharge %, holiday rule, holiday region, linen ownership, minimum charge,
  billing frequency, collections per visit — and that's *before* the user
  discovers that priced lines and the two service patterns (pickup + delivery,
  each needing service days) are configured afterwards on the detail page. A
  first-timer cannot tell the three fields that matter from the sixteen that
  have sensible defaults.
- The **customer form is 16 fields** with the same flat treatment (ABN next to
  status next to special instructions).
- There are only **~25 inline hints in the entire app**. The hint
  infrastructure exists (`Field` supports `hint=`) — it's just barely used.

### F3. The order of operations lives only in the operator's head
To reach a working first day the user must do, in order: depot → customer →
location → items → agreement → agreement lines → service patterns → route
template → template stops → generate daily route → assign driver + vehicle →
vehicle inspection → confirm load → run. The app never states this sequence.
You discover it backwards, one error at a time ("No active template runs on
that weekday", "Every template for that weekday already has a route on that
date"). On an empty database the dashboard says "Nothing needs a decision" —
friendly, but a dead end.

### F4. Notifications are incomplete and the one mechanism that exists is wrong
- **Flash messages ride in the URL** (`?ok=` / `?error=`). Consequences: the
  message re-appears on every refresh, survives into bookmarks and shared
  links, vanishes if the user navigates before reading, and never
  auto-dismisses. `FlashMessages` renders whatever the query string says,
  however stale.
- **There is no notification anywhere that the user didn't just cause.**
  No in-app notification centre or activity feed; no reminder when an invoice
  passes its terms (it silently joins a dashboard count); no alert when a run
  hasn't started by its planned time; no email/SMS to the *customer* at any
  point (pickup done, delivery done, invoice overdue). The single outbound
  email — invoice send — is manual, per invoice, and (per MEMORY.md) still
  untested against the provider.

### F5. Eleven roles is small-operator hostile
`super_admin, operations_manager, dispatcher, driver, finance,
warehouse_operator, customer_service, sales, branch_manager, regional_manager,
auditor`. A three-person laundry has an owner, a driver, and maybe an office
person. Choosing among eleven titles on the Users screen is a test the
first-timer didn't study for — and several role pairs differ by one capability.

### F6. No help, no search, no undo vocabulary
- Global "search" in the context bar only submits to the customers list.
- There is no glossary, no help page, no contextual "what is this?" anywhere.
- Destructive-ish actions (void an invoice, cancel a run) rely on the user
  already knowing they're safe/final; the UI doesn't say which are reversible.

### F7. The Users screen shows people as truncated UUIDs
`admin/users` renders each member as `user_id.slice(0, 8)…` — an
administrator managing access literally cannot tell who anyone is. The page's
own copy compounds it: the description tells the user that "Row-level
security in Postgres enforces the same boundary", and the invite notice says
"Users are created through Supabase Auth" — both meaningless (and mildly
alarming) to a non-technical owner. This is the single most first-timer-hostile
screen in the app.

### F8. No confirmation step exists anywhere
A grep for any confirm dialog across the app returns nothing. Voiding an
invoice at least demands a written reason (good pattern — keep it), but
closing a run, cancelling, deleting a holiday, changing someone's role are
all one click with no "are you sure" and no statement of whether the action
can be undone. First-timers explore by clicking; the app must make the final
actions announce themselves.

### F9. The vehicle inspection is pre-ticked
Every checklist item on the driver's inspection form defaults to *checked*
(`defaultChecked` in `run/page.tsx`). A driver can legally submit a "pass"
without reading a single line. For a safety/compliance record this inverts
the burden: the form attests by default and honesty requires effort.

### F10. Developer voice leaks into user-facing copy
The Jobs page explains itself as: "One customer stop. Pickups and deliveries
hang off the job as child transactions." Invoicing is "Generate period" /
"Generate recurring invoices". These are accurate sentences about the data
model addressed to the wrong audience.

### F11. Flagging a problem mid-route breaks the driver's context
"My run" is otherwise the best screen in the app — a guided six-stage
workflow where exactly one step is actionable at a time. But when something
goes wrong at a stop (the moment a driver is most stressed, on a phone, maybe
offline), the capture card says: open the *job page* and record an exception
there. The one workflow that must never leave the run screen, leaves it.

## 3. Gap analysis — what's missing outright

Things a BA would expect in this product category that don't exist yet (over
and above the four known Stage-4 items: customer portal, public tracking,
Xero, bag scan):

| # | Gap | Why it matters |
|---|---|---|
| G1 | **First-run setup experience** | Empty tenant = blank screens. Nothing walks the operator from zero to a first completed run. |
| G2 | **Customer-facing notifications** | Pickup/delivery confirmations with proof-of-service, and overdue-invoice reminders, are table stakes; today the customer hears nothing unless someone manually emails an invoice. |
| G3 | **Staff alerting** | A run not started 30 min after its window, a failed inspection, a batch stuck in washing — all discoverable only by looking. |
| G4 | **Automatic invoice chasing (dunning)** | The chase queue exists but every chase is a human remembering to look at it. |
| G5 | **Global search** | Any identifier (customer, invoice #, job #, rego) should be findable from the top bar. |
| G6 | **Help & glossary** | No in-product definition of depot/agreement/exception/manifest. |
| G7 | **Consolidated invoicing is silently wrong** | `generateInvoices` dedupes on customer + period, so a customer with two active agreements gets only the first billed (known, pre-existing). A simplification pass must not paper over a correctness hole. |
| G8 | **Media retention** | Nothing prunes `run-media`; storage grows forever. Operational, not UX, but it will become an operator-visible bill. |
| G9 | **User invite flow** | Admin → Users assumes accounts already exist in Supabase Auth; there's no "invite a teammate by email" path an owner could self-serve. Cheaper than it sounds: the login page already has a working magic-link path ("No password? Email me a sign-in link"), so an invite is create-auth-user + membership + that same link. |

## 4. Design principles for the redesign

1. **Organise by task, not by table.** The home screen answers "what do I do
   now?"; the nav answers "where do I do X?" — in the operator's words.
2. **Three fields now, the rest later.** Every create-form asks only what is
   needed to exist; everything else is a default the user can change after.
3. **The app states the next step, always.** Every empty state, every success
   message, every completed step names the action that follows, as a link.
4. **Notifications are events, not URL decorations.** A message the user
   caused shows once and dismisses itself; a message the user *needs* arrives
   in a notification centre and, where configured, by email.
5. **Plain English everywhere**, with the trade term in brackets where the
   industry word matters ("Contracts (service agreements)").
6. **Simple mode is the default.** Three roles, eight nav items. The full
   eleven-role, 22-screen surface remains available behind an "advanced"
   toggle for the multi-depot operator it was designed for.

## 5. Roadmap

Four phases, each independently shippable, ordered so the cheapest changes
with the highest first-timer impact land first. No phase before Phase C
requires a migration.

### Phase A — Language, feedback and guidance (quick wins; no schema changes)
*Goal: a first-timer stops hitting walls. Rough size: days, not weeks.*

- **A1. Fix the flash-message mechanism.** Replace `?ok=`/`?error=` with a
  short-lived cookie flash (set on redirect, cleared on render) rendered as a
  dismissible toast: success auto-dismisses (~5 s), errors stay until
  dismissed. Kills the stale-on-refresh / stale-in-bookmark bug class and
  keeps the server-rendered architecture. `fail()`/`done()` keep their
  signatures, so ~40 call sites don't change.
- **A2. Renaming pass + glossary.** Nav and page titles to operator language
  (per the F1 table); one glossary page linked from a `?` in the context bar;
  the `Eyebrow`/subtitle slot carries the trade term where useful. Routes and
  schema names do not change — labels only.
- **A3. Next-step empty states everywhere.** Audit all ~20 list/detail pages;
  every `EmptyState` gets a description and a button to the action that fills
  it (the depot page already models this).
- **A4. Hints and defaults on every field that has a sensible one.** Target:
  no field on customers/new or agreements/new without either a default or a
  hint. Payment terms default 14, surcharges default 0, billing frequency
  default monthly, status default active, etc.
- **A5. "Getting started" checklist on the dashboard** for tenants with no
  completed run: an ordered list (add a site → add a customer → add a
  contract → set up a weekly run → plan today) with live done/not-done ticks
  driven by row counts — the same pattern as the existing nav badges. Replaces
  the dead-end "Nothing needs a decision" on an empty tenant.
- **A6. Names on the Users screen (F7).** Resolve each membership's email and
  name via the admin client (service-role lookup of `auth.users`, tenant-
  filtered as always) instead of a truncated UUID, and rewrite the page copy
  for an owner, not a DBA. No migration needed.
- **A7. Final actions announce themselves (F8).** A shared confirm affordance
  (the void-invoice "give a reason" pattern generalised) on every action that
  cannot be undone — close run, void, cancel, role change — each stating
  plainly whether it is reversible.
- **A8. Un-tick the inspection (F9).** Checklist items default unchecked, with
  a single deliberate "All checks OK" tap as the fast path — an affirmative
  act instead of a pre-signed form.

### Phase B — Guided workflows (forms become conversations)
*Goal: the big forms stop front-loading expert decisions. ~2–3 weeks.*

- **B1. Agreement creation becomes a 3-step wizard.** Step 1: who + where +
  when (customer, site, start date). Step 2: service days (one pattern editor,
  "deliveries follow pickups" as the default instead of two patterns). Step 3:
  what and price (lines, with a "simple: one price per item" default hiding
  per-kg/minimum/levies behind "Add advanced pricing"). Same server action
  underneath; the wizard is presentation.
- **B2. Customer form split into "Required" (name, phone, email, site
  address — 4 fields) and collapsed "Billing details" / "More".** ABN
  validated but optional at creation.
- **B3. "Plan my day" one-click.** A single dashboard action that generates
  today's routes from templates, pre-assigns the usual driver/vehicle, and
  lands on the planner only if something needs a human choice. The pieces all
  exist; today the user must know to visit two screens in the right order.
- **B4. Order-of-operations errors become redirects.** Where an action fails
  because a prerequisite is missing ("no active template runs on that
  weekday"), the error links straight to the screen that fixes it.
- **B5. Exceptions recorded from "My run" (F11).** Inline "something's wrong
  at this stop" on the capture card — same reasons, same action as the job
  page, but the driver never leaves the run screen, and it works through the
  offline outbox like every other capture.
- **B6. Invoicing in operator words (F10, F12).** "Generate period" becomes
  "Create this month's invoices" with the period pre-filled to the obvious
  one; the Jobs page description written for the person, not the schema.

### Phase C — Correct notifications (the event layer; first migration)
*Goal: the app speaks up on its own. ~2–3 weeks.*

- **C1. `notifications` table + bell.** Tenant-scoped, RLS'd like everything
  else; written by the same server actions and DB triggers that already know
  the events. Bell in the context bar with unread count; a notification links
  to the screen where it's handled; read/unread, no delete (audit posture).
- **C2. Staff event coverage:** invoice passed terms · run not started past
  its window · inspection failed / vehicle off road · batch stuck in a stage ·
  sync/media upload failures from the offline outbox.
- **C3. Customer emails (Resend, existing plumbing):** delivery confirmation
  with proof-of-service photos/signature (signed URLs already exist), and an
  overdue-invoice reminder on a schedule with per-tenant opt-out and a "days
  overdue" threshold. Every send audited, as invoice email already is.
  *Prerequisite: finish the untested Resend path end-to-end first.*
- **C4. Notification settings page** (per tenant): which events, in-app vs
  email, quiet hours. Ship with conservative defaults on.

### Phase D — Simple mode (structural simplification)
*Goal: the three-person laundry sees a three-person app. ~3–4 weeks.*

- **D1. Role presets.** Users screen offers **Owner / Office / Driver** (each
  a preset over the existing capability model — no schema change; the eleven
  roles remain underneath behind "advanced roles").
- **D2. Nav collapses in simple mode** to ~8 items: Today · Problems ·
  Customers · Contracts · Invoices · Runs · Stock · Settings. Full nav stays
  for advanced tenants; the toggle is a tenant setting.
- **D3. Global search** across customers, invoices, jobs, vehicles from the
  context bar (the search field already exists; it just only knows customers).
- **D4. Fix consolidated invoicing (G7)** — a customer with two agreements
  gets both billed (one consolidated invoice or two; confirm intent with the
  owner first). This is a correctness fix travelling with the simplification
  because "simple" must not mean "quietly wrong".
- **D5. User invite flow (G9)** — invite by email from Admin → Users.

### Phase E — folds into the existing Stage-4 plan
Customer portal, public tracking, Xero, bag scan — unchanged, but Phase C's
event layer is a prerequisite worth sequencing first: tracking pages and the
portal are consumers of the same events.

## 6. What "done" looks like (acceptance, per phase)

- **A:** A brand-new user on an empty tenant always has exactly one obvious
  next action on screen; no success message ever reappears on refresh; the
  Users screen shows names, not UUIDs; no final action fires without an
  explicit confirmation; an inspection cannot be submitted un-read.
- **B:** A first-timer creates a customer + contract + first day's routes
  unaided in under 10 minutes (test with someone outside the project).
- **C:** An invoice going overdue and a run not starting each produce a
  notification without anyone looking for them; a delivered customer receives
  proof of service without staff action.
- **D:** A new tenant in simple mode sees ≤8 nav items and 3 role choices;
  a customer with two agreements is billed for both.

## 7. Out of scope for this roadmap

- Any change to the RLS/tenancy model, the offline outbox, or the domain layer
  — the engine is sound and tested (47 pgTAP assertions); this is a cabin
  refit, not an engine swap.
- Renaming database objects to match UI language (labels change; schema
  doesn't).
- The `/design-preview` gallery stays the review surface for every new
  component introduced above.
