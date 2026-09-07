# Electro Services — the twenty UX essentials, audited

**Date** 1 September 2026 · **Method** `.claude/skills/ux-essentials/` (TradeFlow repository) ·
**Scope** `src/`, 132 UI files (72 pages, 22 shared components), test files excluded

A checklist of twenty interface details was supplied — the ones users never ask for by
name and always notice the absence of. This document records what this codebase actually
has, feature by feature, traced to code. It was produced against the `dev` checkout at
`/home/user/laundrymart`; nothing here was committed or pushed, and no other file in the
repository was touched.

**Method.** `scripts/detect.py` (borrowed from a sibling project's tooling, standard-library
Python, no network) produced a first-pass grep over the tree; every signal — and every
silence — was then read in the actual source: components were traced to where they mount,
not just where they are defined, and every occurrence of a word like `success`, `draft` or
`aria-expanded` was checked against what it actually names before it counted as evidence.
Every verdict below cites `file:line`.

**A gap and a decision are not the same thing.** Several of the findings below are
deliberate design choices with the reasoning written into the code beside them — the
service worker's cache list, the confirm affordance's own design-spec comment, the "compose
locally, commit once" rule that governs three specific screens. They are recorded as
decisions, with what they cost, not as oversights. Two more are marginal calls this
document says so about rather than forcing into PRESENT or ABSENT.

## Scoreboard

| | Count | Features |
| --- | --- | --- |
| **PRESENT** | 9 | 3 empty states, 4 loading skeletons, 5 drag-drop, 8 focus rings, 9 dark mode, 10 hover states, 11 sticky header, 14 disclosure, 19 success state |
| **PARTIAL** | 5 | 7 offline banner, 15 progress bar, 16 confirm modals, 17 updated dates, 20 error state |
| **ABSENT** | 6 | 1 command palette, 2 undo toasts, 6 autosave, 12 back to top, 13 copy buttons, 18 support float |

The shape of this result is worth naming before the detail, because it is a different
shape than the same audit tends to find on a first design pass: **this codebase's shared
primitives already reach almost everywhere, and most of what is short is a specific,
nameable last mile on a mechanism that is otherwise built well** — not a missing
foundation. `components/ui.tsx`'s `DataTable` gives every table row in the product a hover
state and a mobile card fallback in one place; `components/form.tsx`'s `Field` wires
`aria-invalid`/`aria-describedby` for every input in one place; `lib/actions.ts`'s
`fail()`/`done()` carries a flash message across every server-action redirect in one place.
Three of the five PARTIAL findings are exactly this: a real, well-built mechanism with one
clearly nameable piece missing (a keyboard path, an `aria-live`, a route boundary) — not a
mechanism that only reaches one screen out of many, which was the more common shape the
first time this checklist was run elsewhere.

---

## PRESENT (9)

### 3 · Empty states

A shared `EmptyState` (`src/components/ui.tsx:235`) takes a title, description and
optional action, and the created-vs-filtered distinction the catalogue asks for is not a
one-off — it is the standard shape across essentially every list screen in the app, via one
recurring ternary:

```tsx
title={filtered ? "No jobs match those filters" : "No jobs yet"}
description={filtered ? "Try a broader search, or clear the filters."
                       : "Take in a customer's laundry and it appears here…"}
```

(`src/app/(app)/orders/page.tsx:439-441`, and the same pattern at
`src/app/(app)/customers/page.tsx:105`, `src/app/(app)/boards/page.tsx:148-151`,
`src/app/(app)/drivers/page.tsx:141-143`, `src/app/(app)/vehicles/page.tsx:115-117`,
`src/app/(app)/suppliers/page.tsx:90-91`, `src/app/(app)/admin/depots/page.tsx:137-139`,
`src/app/(app)/admin/holidays/page.tsx:136-139`, `src/app/(app)/admin/users/page.tsx:315-317`,
`src/app/(app)/admin/audit/page.tsx:126-128`, `src/app/(app)/inventory/page.tsx:144-146`,
`src/app/(app)/warehouse/page.tsx:199-203`, and more than a dozen others). The first-run
case carries a conditional CTA (`action={canCreate && !filtered ? <ButtonLink …> : null}`),
and the copy names the object ("No jobs yet", "No contracts yet") rather than the state.

**The third case — not permitted to see any — is handled differently than the catalogue
describes, and better for this product's shape.** Every list page sits behind
`requireCapability()`, which redirects to `/dashboard?error=forbidden` before a
role-inappropriate user ever reaches an empty list (`src/lib/auth/context.ts:152`,
surfaced by `src/app/(app)/dashboard/page.tsx:74`). A driver who cannot see invoices never
sees an *empty* invoice list that reads as "there are none" — they never reach `/invoices`
at all. Row-level narrowing (a driver's own jobs, a board's own run) is a real subset of
"empty because of who you are," and `src/app/(app)/my-runs/page.tsx:120-132` names it
directly: *"You do not have any delivery jobs assigned for [date]"* — the reason is in the
sentence, not left for the reader to infer from a blank list.

### 4 · Loading skeletons

`src/app/(app)/loading.tsx` is the route-level shell shown on every navigation inside the
app before data streams in under `<Suspense>` — stat-card placeholders and row placeholders
matching the real layout, `animate-pulse` throughout. Beyond that instant shell, every
data-heavy region in the product is independently wrapped: `<Suspense fallback={<SkeletonRows
rows={N} />}>` and `<Suspense fallback={<SkeletonStats />}>` (both defined at
`src/components/ui.tsx:662-678`) appear roughly 90 times across 40 files — every list page,
every stats row, both detail-page halves of `src/app/(app)/customers/[id]/page.tsx:114-137`
and `src/app/(app)/invoices/[id]/page.tsx:132-163`. Row counts are tuned per screen (`rows={2}`
for a two-row summary, `rows={10}` for the audit log), which is what keeps a skeleton from
visibly jumping once real content arrives.

**Not measured against the ≤200ms budget any given screen actually needs** — some of these
Suspense boundaries may be fast enough that the skeleton flashes rather than helps, per the
catalogue's own caution. That is a tuning question, not a gap in the mechanism.

### 5 · Drag and drop

Two independent hand-rolled implementations, both with a working keyboard alternative —
the part most drag-and-drop builds skip:

- **Run sequencing** — `src/app/(app)/runs/sequence-board.tsx:137-150` (`onDragStart`,
  `onDragOver` with `preventDefault()`, `onDrop`) and its non-drag twin
  `src/components/stop-sequencer.tsx:49-51,76-89` — two real `<button>`s per row,
  "↑"/"↓", that call the same reorder function drag does (`moveStop`/`moveStopTo` in
  `src/app/(app)/runs/sequence.ts`). A keyboard or switch-device user reaches the identical
  outcome.
- **Route planning** — `src/app/(app)/routes/planner/planner-board.tsx:162-163,226-229`
  (jobs dragged onto a day/driver column) with the same up/down button pair at
  `planner-board.tsx:269,274`.

Both persist through the same "compose locally, commit once" contract described under item
6 below, and both are documented as **locked by default** — dragging is only possible after
a deliberate "Adjust Run" / edit-mode press (`sequence-board.tsx:17-20`), specifically so a
manager casually opening a run on a phone cannot nudge a row by accident.

**Not a gap:** photo capture (`src/components/media-capture.tsx:93`, `capture="environment"`)
is click-to-camera only, with no drop zone. On a driver's phone that is the correct
interaction — there is nothing to drag onto a camera capture button — so this is a
non-finding rather than the missing-drop-zone gap this checklist often surfaces on desktop
upload forms.

### 8 · Focus rings

The best-built item on the list, and the only one with a documented before/after against a
measured WCAG failure. One global rule:

```css
:focus-visible {
  outline: 3px solid hsl(var(--ring));
  outline-offset: 2px;
}
```

(`src/app/globals.css:269-271`) — no `border-radius` on the rule, deliberately: the comment
above it explains that a radius there reshapes the *element* outline follows automatically,
which had been visibly squaring off every rounded button and card on focus.

The counter-evidence is what makes this PRESENT rather than merely present-looking: `grep`
for `outline-none` across `src/` returns **zero** live uses. The only two hits are a comment
in `src/components/ui.tsx:365-371` *documenting a defect that was fixed* — `CONTROL` used to
carry `focus:outline-none focus:ring-2 focus:ring-primary/25`, which measured about 1.5:1
against the page, under the 3:1 WCAG 2.2 SC 1.4.11 floor, on every input, select and
textarea in the app. Removing the `outline-none` let the global 3px ring back through; the
tinted ring stays as a decorative layer on top of it. That is the shape of a real
accessibility review having happened here, not just a class that was never added.

### 9 · Dark mode

Three states, correctly ordered: system preference is the default, an explicit choice
persists and wins in both directions. The bootstrap script in `src/app/layout.tsx:78`
(`var dark = stored ? stored === "dark" : matchMedia("(prefers-color-scheme: dark)").matches`)
runs before paint, so there is no flash; `ThemeToggle`
(`src/components/app-nav.tsx:267-295`) reads the live `<html class="dark">` state via a
`MutationObserver` rather than owning its own copy, writes the override to `localStorage`
inside a `try`/`catch` for private browsing, and is mounted in the real app shell at
`src/app/(app)/layout.tsx:130` (not only in a preview gallery). `color-scheme: light` /
`color-scheme: dark` are set on `:root` and `.dark` (`src/app/globals.css:42,119`), so native
form controls and scrollbars follow.

**Contrast was re-verified in dark, not inverted**, and the comments prove the check was
real rather than assumed: `--muted-foreground` in dark mode is annotated *"The dark value
actually failed AA where it lands most often: 4.45:1 on `--surface-sunken` and 4.76:1 on a
card, against the 4.5 floor. Lifted to clear AAA…"* (`src/app/globals.css:112-114`). Every
token in both palettes carries its measured ratio in a trailing comment (`--muted-foreground:
… 8.7:1 card, 8.1:1 page, 7.0:1 sunken`, `--primary: … 5.7:1 on paper, 6.1:1 on a card…`).
That is not typical of a dark-mode pass; it is typical of one that found and fixed a real
failure before shipping.

### 10 · Hover states

Structural, not per-screen. `DataTable` — the app's one table component, used by every list
screen the empty-state section above names — puts `hover:bg-surface-muted/70` on every row
by construction (`src/components/ui.tsx:591`), so coverage does not depend on any individual
screen remembering to add it. The shared `Button` variants (`src/components/ui.tsx:320-329`
and `src/components/form.tsx:258-268`) cover primary/secondary/danger/ghost/subtle
consistently, and `hover:` appears in 64 files, 146 uses, spanning icon buttons
(`src/components/app-nav.tsx:290`), menu items (`src/components/user-menu.tsx:96`), the
mobile drawer, and table links (`className="hover:underline"` on every `<Link>` cell).

`DataTable` also gives a horizontally-scrolling table `tabIndex={0} role="region"
aria-label={label}` (`src/components/ui.tsx:576-577`) so a keyboard user can reach a wide
table at all — a WCAG 2.1.1 concern this checklist does not ask about but that lives right
beside the hover coverage it does ask about, in the same component.

### 11 · Sticky header

Two real anchors: the app shell's own header (`src/components/app-shell.tsx:173`,
`sticky top-0 z-30`) and desktop rail (`app-shell.tsx:95`, `sticky top-0 h-screen`), plus a
second sticky bar for the day picker on My Runs (`src/app/(app)/my-runs/page.tsx:148`) and a
sticky filter rail on the invoices screen (`src/app/(app)/invoices/page.tsx:146`,
`lg:sticky lg:top-4`).

**One related piece is built but unused, worth flagging as tidy-up rather than a gap.**
`DataTable` accepts a `stickyHeader` prop that pins its own `<thead>` and caps the body at
`max-h-[70vh]` (`src/components/ui.tsx:494,510,570,574`) — but no call site anywhere in the
app passes it. Every list uses pagination instead of an internally-scrolling tall table
(see item 12), so the prop has had nothing to do; it is dead code, not a broken feature.

### 14 · FAQs / disclosure

Both halves the catalogue asks to be checked separately are present, which is not the usual
finding.

**The mechanism:** `FormDisclosure` (`src/app/(app)/customers/customer-form.tsx:20-24`) wraps
native `<details>`, used across the job form (`src/app/(app)/orders/job-form.tsx:633,750`),
the customer form (`customer-form.tsx:88,119`), the contract wizard
(`src/app/(app)/agreements/agreement-wizard.tsx:209`) and the staff form
(`src/app/(app)/admin/users/page.tsx:209`) — each with a documented reason nothing inside a
closed disclosure is ever `required` (`admin/users/page.tsx:155-162`: a `required` field in a
closed `<details>` fails native validation with nothing visible to focus).

**The content:** `src/app/(app)/help/page.tsx` (315 lines) is a real, substantial reference —
a five-step "how the day works" walkthrough with links to the actual screens
(`help/page.tsx:22-43`) and a glossary defining the app's own vocabulary against the terms
the previous system used (`help/page.tsx:45+`, e.g. "Contract, also: service agreement").
It is reachable by everyone signed in, pinned last in the rail rather than buried
(`src/lib/nav.ts:376-378,513`), and it is not itself gated by role.

The one honest gap: the Help page does not itself use the `<details>` disclosure mechanism —
it is a single scrollable reference rather than a collapsed FAQ. For a glossary meant to be
skimmed or searched with browser find, that is a reasonable choice rather than a missing
piece, but it means the two halves, while both real, are not the same artifact.

### 19 · Success state

The exact mechanism this checklist most often finds missing — a way to show a message
*after* a server action redirects — is built and used everywhere. `fail()`/`done()`
(`src/lib/actions.ts:42-48`) set a one-shot, non-`httpOnly` cookie and redirect;
`(app)/template.tsx` reads it on the next render (chosen deliberately over the layout, since
templates re-render even on a same-path redirect); `FlashToast`
(`src/components/flash-toast.tsx`) renders it — `role="status"` for success,
`role="alert"` for error — and deletes the cookie so it is never replayed.

Every create/update path checked ends in `done()`, not a bare `redirect()`:
`createOrder` → `return done(\`/orders/${order.id}\`, \`Job ${order.order_number}
created.\`)` (`src/app/(app)/orders/actions.ts:349`); `createCustomer` → `return
done(…, \`Customer ${data.customer_number} created.\`)`
(`src/app/(app)/customers/actions.ts:97-99`). The message names the record, not just "Saved."
`FlashToast`'s own comment (`src/components/flash-toast.tsx:14-22`) documents a considered
change: success toasts used to auto-dismiss after five seconds and no longer do, because the
toast is "the only record that anything happened" once the form has redirected away, and
five seconds was not long enough for someone to find, read and understand it — both tones
now wait to be dismissed, which is also what WCAG 2.2.1 asks for.

`firstIssue()` (`src/lib/actions.ts:70-73`) carries the same discipline for the failure
case: it used to surface the raw Zod field path (`expected_delivery_date: Invalid input`)
and was rewritten because, at 112 call sites, it was "the most-read sentence in the app."

---

## PARTIAL (5)

### 7 · Offline banner — real, correctly scoped, one coverage gap and one accessibility gap

This is a deliberately narrow mechanism, and the scope decision is well-reasoned and
documented, not accidental — which is a different shape than the more common "we built the
whole thing and only wired it into one screen" finding. `public/sw.js:1-9` states the
scope directly: *"Scope is deliberately narrow: keep the app shell reachable without signal
so a driver can open their run and capture stops. Field data is NOT cached here — it goes
through the IndexedDB outbox… idempotent and replayable."* Its precache list is exactly
`["/run", "/offline", "/manifest.webmanifest"]`. `OfflineCapture`
(`src/components/offline-capture.tsx:28-113`) writes to that outbox first and syncs second,
so the driver gets the same "Saved on this device" confirmation with or without signal
(line 137); the pending-write count is shown (`{queued} waiting to sync`, line 152), which
is exactly what the catalogue asks for when writes are queued; and `/offline`
(`src/app/offline/page.tsx`) is a real branded fallback page, not the browser's own.

**Two things are short of "done" within that deliberate scope, not outside it:**

1. **The indicator is inside the active-stop capture card, not on the run screen itself.**
   `OfflineCapture` is only rendered once a driver has selected a stop
   (`src/app/(app)/run/page.tsx:246,252`, inside `if (active) { … }`). A driver who loses
   signal while still looking at the stop list (`Stops` in `run/page.tsx:180-227`) sees
   nothing telling them so until they open a stop.
2. **The Online/Offline chip has no `role="status"`/`aria-live`**
   (`src/components/offline-capture.tsx:144-150` — a plain `<span>`), so a screen-reader
   user is not told when connectivity changes underneath them, unlike the pending-count text
   beside it which shares the same markup and the same gap.

### 15 · Progress bar — real and correctly built where it exists, absent for uploads

`ProgressBar` in the My Runs day summary (`src/app/(app)/my-runs/run-view.tsx:77-85`) does
everything the catalogue asks: `role="progressbar"` with `aria-valuenow`/`min`/`max` and an
`aria-label`, driven by the real completed/total count rather than a timer, with the number
shown in text beside it — the component's own comment is explicit that the bar exists only
"so the shape of the day is readable at a glance," with the number carrying the actual
answer (`run-view.tsx:70-72`).

**Missing where the catalogue specifically calls it out: uploads.** Every media upload in
the app — office pickup/delivery photos, signatures — goes through `fetch()`
(`src/components/media-upload-field.tsx:49`), which has no upload-progress event; nothing in
the repository uses `xhr.upload.onprogress`. A multi-photo upload from a desk gives no
feedback beyond a disabled button while it runs (`media-upload-field.tsx:38,74` — `busy`
state with no percentage). No multi-step "Step 2 of 4" text exists either, though the
numbered `Stage` checklist (`src/components/ui.tsx:207-233`, used for the driver's daily
workflow at `src/app/(app)/run/page.tsx:110-166` and the three-step contract wizard at
`src/app/(app)/agreements/agreement-wizard.tsx:54,151-301`) covers the same need in a
different, arguably more informative shape — every step shown at once with its own status,
rather than a compact counter. That is a reasonable substitute, not a gap.

### 16 · Confirm modals — a real, deliberate, documented alternative to a dialog, with a keyboard gap and inconsistent adoption

**Not `window.confirm`.** A repo-wide search finds zero uses. Instead, `ConfirmSubmit`
(`src/components/confirm-submit.tsx`) is a purpose-built inline affordance: the button swaps
in place for a panel stating the consequence in plain words, an optional required reason
field, the real submit beside a "Keep it" way out. Its own docstring names the design
decision and the reasoning: *"Inline rather than a modal on purpose. The consequence should
sit next to the button that causes it, especially on a phone, where a centred dialog covers
the very row the operator is trying to check before they commit."* (`confirm-submit.tsx:8-16`,
design spec AD-9). It is used for 40+ genuinely destructive actions across 15 files — void
an invoice (`invoices/[id]/page.tsx:211`), close a run (`run/page.tsx:161`), deactivate
staff (`admin/users/page.tsx:392`), disconnect Xero (`invoices/xero/page.tsx:73`), cancel a
batch mid-wash, and more — and the copy names the object and the consequence, not "OK",
matching the catalogue's two copy rules.

**What is missing, precisely:**

- **No Escape-to-cancel.** There is no keydown handler in the component at all; the only
  way out once open is clicking "Keep it."
- **No guaranteed focus movement on open.** `autoFocus` is only set on the optional reason
  `<input>` (`confirm-submit.tsx:88`); when `reasonName` is not passed (e.g. "Close run",
  `run/page.tsx:161-167`), opening the panel unmounts the button that had focus and nothing
  claims it — a keyboard user's focus falls back to the document body.
- **No `role="alertdialog"` or live-region announcement** when the panel appears, so a
  screen-reader user gets no signal that a decision now requires their attention beyond
  whatever they were already reading.

**Adoption is not quite universal**, found by checking every `variant="danger"` button
against this component:

| Action | Location | Finding |
| --- | --- | --- |
| Cancel run | `src/app/(app)/routes/daily/[id]/page.tsx:136` | Genuinely unguarded — a plain `<Button variant="danger">` inside a one-click `<form>`, no reason, no "are you sure," no undo. Cancels a whole day's route. |
| Stop this batch | `src/app/(app)/warehouse/[id]/page.tsx:154-166` | Not `ConfirmSubmit`, but not bare either: folded behind a `<details>` disclosure ("Something went wrong with this batch"), a required reason field, and the consequence stated in prose beside it ("The linen goes back to the depot shelf and can be counted into a new batch"). Functionally close to a confirm, just not the shared component — an inconsistency, not a hole. |
| Flag exception | `src/app/(app)/jobs/[id]/page.tsx:123` | Styled `danger` for what is a routine, reversible operational step (recording a delivery exception), not a destructive one. Likely coloured for visual urgency rather than because it needs guarding — worth a second look only because pairing "danger" styling with a non-destructive action trains people to stop trusting the colour. |

### 17 · Updated dates — shown, but on two screens out of many, and never relatively

`updated_at` is threaded through the schema and read in 13 files, but reaches the screen in
exactly two places: `src/app/(app)/orders/[id]/page.tsx:356` (`<Row label="Last updated"
value={dateTime(order.updated_at)} />`, alongside "Created by" naming the actual person at
line 354) and `src/app/(app)/invoices/drafts/draft-card.tsx:69` (`"Last change"`, using
`formatIso(...)` on the date portion only). Customer, invoice, agreement, supplier and item
detail pages show none of it.

`dateTime()` (`src/lib/format.ts:25-33`) is timezone-aware — it defaults to
`Australia/Adelaide`, matching the rest of the app's timezone discipline — but it returns a
plain string, not a `<time dateTime={iso}>` element (a repo-wide search for `<time` returns
nothing), and there is no `Intl.RelativeTimeFormat` anywhere in the codebase. Every
timestamp shown is an absolute one; "2 hours ago" does not exist as a pattern here at all.

### 20 · Error state — three of four layers, and the strongest field-validation layer this checklist tends to find

**Layer 1 (field validation) is fully built and wired through one shared component** —
notably including the exact association (`aria-invalid` tied to the message via
`aria-describedby`) that this checklist most often finds missing entirely. `Field`
(`src/components/form.tsx:20-56`) computes `errorId`/`hintId` and hands them down through
context (`FieldControlContext`, `form.tsx:63-68`) to `Input`, `Textarea` and `Select`, each
of which sets `aria-describedby={field.describedBy} aria-invalid={field.invalid ||
undefined}` (`form.tsx:110,123,156`). The docstring names this as a fix, not an original
design: *"Neither was wired up before: `aria-describedby` and `aria-invalid` appeared
nowhere in the app, and a refusal was only ever a toast in the corner"* (`form.tsx:26-27`).

**Layer 2 (action failure) is the same mechanism item 19 uses** — `FlashToast`'s
`role="alert"` branch, plus inline `Notice tone="danger"` — applied with the same
`if (!parsed.success) return fail(path, firstIssue(parsed.error))` shape at well over 100
call sites.

**A version of layer 4 (permission vs. not-found) exists and is used deliberately, not by
accident.** `requireCapability()` sends a role-inappropriate user to
`/dashboard?error=forbidden` with a distinct message (`src/lib/auth/context.ts:152`), which
is a different answer from `notFound()`. One call site goes further and explains the
trade-off explicitly: `src/app/(app)/my-runs/jobs/[id]/page.tsx:55` chooses 404 over 403 for
a specific case with the reasoning attached — *"a 404 tells an attacker nothing a 403 would
not"* — a case where the checklist's "distinct" requirement was consciously weighed against
not confirming a record's existence to someone who should not see it.

**Layer 3 (route error boundary) does not exist at all.** Zero `error.tsx`,
`global-error.tsx` or `not-found.tsx` anywhere in `src/app`. 18 route files call `notFound()`
(`src/app/(app)/customers/[id]/page.tsx:54` and 17 more), and every one of them lands on
Next's bare, unbranded default page rather than anything the app shell wraps. The same is
true of an uncaught render error in a Server Component.

---

## ABSENT (6)

**None of the six carries a documented decision as clear as the ones recorded above** — this
section is closer to a plain gap list than the PRESENT/PARTIAL sections were, though two of
the six are genuinely lower-consequence than the other four given how this specific product
is shaped, and this document says which.

### 1 · Command palette

Zero `metaKey`/`ctrlKey`/`key === "k"` handlers anywhere, and no document-level keydown
listener outside a menu's own open state (`src/components/user-menu.tsx`). Search is a plain
`<form method="get" action="/search">`
(`src/components/global-search.tsx:42-47`), server-rendered
(`src/app/(app)/search/page.tsx`), querying customers, contracts, invoices, stops, item
types, drivers and vehicles — gated per group exactly like each group's own screen. No
comment anywhere states this as a considered alternative to a palette the way a sibling
project's equivalent decision is written down; it reads as not-yet-built rather than
declined.

**Cost:** every search is a full navigation, and there is no keyboard route to a record from
elsewhere in the app. The existing `/search` service already does the cross-entity query
work a palette would need — it is the overlay and the keyboard handling that are missing,
not a second search path to build.

### 2 · Undo toasts

No toast carries a reversal anywhere. What looks adjacent on a grep is not it:
`sequence-board.tsx`'s "Cancel Changes" discards an *uncommitted* local edit — nothing is
written until Save & Lock Run (`sequence-board.tsx:22-30`, "compose locally, commit once"),
so there is nothing to undo in the catalogue's sense, only something never sent. And the
comment at `src/app/(app)/invoices/actions.ts:1156` ("undo the half-made record rather than
leave it to be found") describes a server-side compensating delete run automatically when a
multi-step write fails partway — not a user-facing action.

The blocker is the same one this checklist usually finds: nothing in the data model is
built to be reversed by the user after the fact. `deleted_at`/`archived_at` exist and are
used extensively, but always through `set_records_archived()`
(SECURITY DEFINER, per the archive-policy discussion in `CLAUDE.md` §3) rather than a
short-lived, self-service reversal a toast could trigger.

### 6 · Autosave

Zero `debounce`, zero `beforeunload`, in any `.ts`/`.tsx` file. The one long, single-page
form in the product — `src/app/(app)/orders/job-form.tsx`, described in its own comment as
"a form twice as long as the work it was recording" (`job-form.tsx:629`) — has no draft
persistence; closing the tab mid-entry loses everything typed.

**Worth being precise about what the "compose locally, commit once" comments do and do not
cover**, since they read at first glance like a considered stance against autosave. They
govern exactly three specific composed-JSON payloads — run sequencing
(`runs/sequence-board.tsx`), the contract wizard's priced lines
(`agreements/wizard-lines.ts`), and the route planner (`routes/planner/plan.ts`) — and the
reasoning given is about not writing a *transiently wrong* intermediate state to the server
mid-drag, not about declining autosave as a feature. It says nothing about the job form,
which is where the exposure actually sits.

### 12 · Back to top — a genuine architectural difference from the more common finding, and a marginal case either way

Zero `scrollTo`, `scrollY`, `scrollIntoView`-as-navigation, or `IntersectionObserver`
anywhere. Unlike an app shell built around fixed-height internally-scrolling panes (where
this item is cleanly inapplicable because there is no long page to scroll back up), this
app's shell scrolls at the document level: the root layout is `min-h-screen lg:grid`
(`src/components/app-shell.tsx:91`) with a `sticky` header and sidebar riding on top of
normal page flow, not a capped, internally-scrolled region. A sufficiently long page here
*would* leave a user scrolled away from the top with no way back except the scrollbar or
repeated key presses.

**What keeps this from being a clear gap in practice: real pagination.** Every list screen
checked uses `.range(from, to)` (`src/app/(app)/customers/page.tsx:85`,
`src/app/(app)/invoices/page.tsx:247`, `src/app/(app)/orders/page.tsx:357`, and more) rather
than rendering an unbounded table, so the pages most likely to grow long are capped by
design. The two realistic long-scroll candidates are `src/app/(app)/help/page.tsx` (315
lines of static reference content, no pagination applicable) and individual report views
under `src/app/(app)/reports/page.tsx`, which render one report at a time but can run to a
full date range of daily rows. Neither is long enough today to call this an active problem;
call it a low-consequence, marginal item to revisit if either grows, not a feature to build
now.

### 13 · Copy buttons

Zero `navigator.clipboard`, zero `execCommand("copy")`, anywhere in `src/`. Unlike the
tokenised-link case this checklist explicitly carves out as a legitimate reason to withhold
a copy button, there is no such token here to protect: this application has no public,
credential-bearing link at all — no customer portal, no magic-link document, nothing under
`src/app` outside `(app)`, `auth`, `login` and `offline`. Every reference number in the
product — job numbers (`LJ-…`), invoice numbers (`INV-…`), customer numbers (`CUST-…`),
contract numbers (`SA-…`), all minted by `next_number()` — renders as plain text throughout,
with no affordance to copy one into an email, a search box, or MYOB/Xero's own search. This
is a plain, low-risk gap.

### 18 · Support float

No fixed-position widget, no third-party chat SDK (`intercom`/`zendesk`/`crisp`/`tawk` all
return zero). What exists instead is stronger than the bare "Contact link in a footer" the
catalogue names as the usual near-miss: `src/app/(app)/help/page.tsx` is a real,
substantial, ungated reference page (see item 14), pinned permanently at the foot of the
navigation rail for every signed-in role (`src/lib/nav.ts:376-378,513`) rather than tucked
in a footer. It is not a persistent floating affordance, and no comment states a deliberate
"no float" position the way this document records for other items — so it is recorded as
ABSENT rather than a decision — but the honest read is that a driver or a counter hand is
one rail click from real help content on every screen, which is most of what a support float
is actually for. Whether that is enough, or whether an internal team decided a live-chat
widget or even just a `tel:`/`mailto:` link belongs beside it, is a product call this
document does not make for them.

---

## What to do first

Ordered by consequence, not by list position.

| | Work | Why first |
| --- | --- | --- |
| 1 | Guard "Cancel run" (`routes/daily/[id]/page.tsx:136`) with `ConfirmSubmit` | The one genuinely unguarded destructive action found: one click cancels a whole day's route, no reason, no undo, no confirmation at all. |
| 2 | Add `error.tsx`, `not-found.tsx`, `global-error.tsx` | 18 routes call `notFound()` into Next's unbranded default. Small, bounded, and the one layer of error handling with nothing built at all. |
| 3 | `Escape` + guaranteed focus movement on `ConfirmSubmit` open | One shared component, used in 40+ places — fixing it once fixes every destructive-action confirmation in the product at once. |
| 4 | Announce the Online/Offline state (`offline-capture.tsx:144-150`) and surface it on the stops list, not only the active capture card | Small, contained, and closes the one real coverage hole inside an otherwise well-scoped, deliberately-built mechanism. |
| 5 | Roll `updated_at` display out past the two screens that have it, using the existing `dateTime()` helper, and add one `Intl.RelativeTimeFormat` helper for the relative form | The data and the formatting helper already exist; this is adoption, not new plumbing. |
| 6 | Reconcile the two off-pattern danger buttons: adopt `ConfirmSubmit` for "Stop this batch," recolour "Flag exception" off `danger` | Small, and stops "red" from meaning two different things in the same product. |
| 7 | Copy buttons on job/invoice/customer/contract reference numbers | No security reason found to withhold them (unlike a tokenised link); a plain per-day convenience gap. |
| 8 | A command palette over the existing `/search` service | The cross-entity query already exists; what is missing is the overlay and the keyboard handling around it. |

**Needs a decision before UI work, not more UI work first:** autosave and undo both need a
data-model or product decision — what "reversible" means for a laundry job, an invoice line,
a run assignment — before either is worth building; building the toast host or the debounce
timer first would be building the easy 20% of either feature.

**Not recommended as active work right now:** back-to-top, given real pagination keeps
almost every list short and only two pages are even candidates; and a floating support
widget specifically, given the Help page already gives every role a one-click route to real
content — if a decision is made that live help is needed, that is a staffing and privacy
question (a third-party widget ships trackers into a tenant's session) before it is a UI one,
per the same reasoning this checklist gives for that item generally.
