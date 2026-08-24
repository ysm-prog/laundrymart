# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

## Latest: usable by somebody who has been shown it once
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

## Verified against the live project (2026-08-24) — nothing to apply
This branch adds **no migration**; the ledger's last entry is still `0033_laundry_prices_read`.
Checked anyway: advisors **18** (unchanged — no function added), **0** `anon` table grants, **0**
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
- **Adelaide's four boards are linked to no login (0 of 4)** and it still has no member who is not
  a platform admin — yet `LJ00003`/`LJ00004` are assigned to those boards. Real jobs are now
  behind the §24 cutover step. Its price list is still empty, so `LJ00002` was priced by hand.

## Do these next
- **Open it with real rows in it.** This container has no Supabase credentials, so no
  authenticated screen was rendered. Sign in as `owner@roles.example.com`, press each card on the
  home screen, and set the text to Biggest on a phone.
- **§26 is the owner's decision, not mine.** `orders.write` is held by two roles and
  `customer_service` — the role named for the counter — is not one, so an untrained counter hand
  must be made `operations_manager` (31 screens). Restoring it would cut that to ~11 but reverses
  the 2026-08-16 decision **and** needs `0025`'s restrictive write policies widened, or the
  counter writes zero rows with no error (the exact silent failure boards hit in 0031).
- Still from the previous session: take one job through complete → Price → Approve → run the
  month (use Harbour, it has prices); invite a real person into Adelaide and link them to a board;
  enter Adelaide's own prices.

## Still open (unchanged from the previous session)
- **`LJ00001`** — Adelaide job, Harbour customer, still `ready_for_delivery`. Remedy is
  cancellation, which is terminal; the owner's call.
- **`service_agreements` and `audit_logs` are `for all … using is_member(tenant_id)`**, so any
  operational login reads every contract header and the whole activity log. Neither exposes a
  price or an amount. Wants a decision, not a quiet narrowing.
- **§23 sweep:** ~345 of 451 `.from(...)` reads still rely on RLS alone; correct for eleven of
  twelve roles, but a platform admin's session spans two laundries.
- **Nothing has talked to Xero yet** (`XERO_CLIENT_ID`/`SECRET` unset by the owner's decision).
- **This deployment cannot send any auth email** — custom SMTP still unconfigured, which is what
  blocks linking a login to Adelaide's boards.
- Database: **0001–0033 applied to `laundrymart-syd`.** Nothing pending, and this branch adds none.

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
