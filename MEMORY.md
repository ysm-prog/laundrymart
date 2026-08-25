# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

## Latest: account codes on an invoice line
2026-08-25, branch `claude/invoice-item-code-selection-vlwwb4`. CLAUDE.md §3, §7, **§27** and the
newest changelog entry have it. One migration (`0036_invoice_account_codes`) — **no new table, no
new role, no new capability, nothing dropped, no row changed**.

The client sent their MYOB chart of accounts (268 accounts, 24 income) and asked for an invoice
line added **by item or by code**, with anything in neither list written as free text.

**Three ways to fill one line, not three kinds of line.** Whichever route is taken the row is the
same shape, so there is no `line_kind` column and a month-end line is indistinguishable from a
typed one. `items.income_account_id` is the bridge (MYOB's "Income Account for Tracking Sales");
`invoice_lines.gl_account_id` + `account_code` carry it — the link for joins, the text for history,
kept coherent by `sync_invoice_line_account()`, which **derives the code and never accepts one**.
An uncoded line is legal and **counted on the invoice**, never refused: the free-text line is what
the client explicitly asked for.

**Xero has been ready since 0026 and was never fed.** `buildInvoicePayload` has mapped
`account_code` → `AccountCode` from the day it was written and nothing selected the column, so
**every line this app has pushed landed in Xero's default sales account**. One word in one select.

**The migration's first part is a security fix, and it is why it shipped with the feature.** All
six payable tables (`gl_accounts`, `suppliers`, `supplier_bills`, `purchase_orders`,
`supplier_payments`, `import_activation_state`) carried one permissive `for all … using
is_member(tenant_id)` policy from `apply_tenant_policy`. Probed live as one of Adelaide's own
**board** logins: **268 accounts** (owner's equity, drawings, every vehicle loan), **192 suppliers**,
**1,515 bills** worth $65,724 — and an UPDATE renaming `4-1600 Laundry` **succeeded**. A delivery
round could rewrite the chart of accounts. Same shape as 0006/`invoices`, 0018/`laundry_prices`:
**the third time**, hidden because the demo tenant has none of this data so the 2026-08-20 board
sweep read 0. **An empty table is not a proof.** Now `can_read_purchases()`/`can_write_purchases()`,
`for all` **replaced** (its USING half grants SELECT — the 0033 trap).

### Where it stands
- 765 unit tests (was 739), **382 pgTAP assertions** (was 368), `verify` green, all 36 migrations
  applied to a fresh Postgres 16 with the suite and the seed. All 14 new assertions **confirmed to
  fail without 0036**, the write hole included.
- Gallery: composer in three states, 24 combinations measured — 0 console errors, 0 overflow inside
  it, 0 targets under 36px. Document overflow byte-identical to the recorded baseline. 26
  interaction assertions drive every route.

### Next, and it needs a real project
1. **`0036` is NOT applied to `laundrymart-syd`** — the ledger's last entry is still
   `0035_audit_log_read`. Apply it, then re-probe as `board1@ats.example.com`: the six counts above
   should all become 0 and the rename should touch nothing.
2. Set an income account on some items, add a line each way on a draft, read the PDF, push to Xero
   and check `AccountCode` arrives.
3. **Adelaide holds 268 accounts and zero items**, so the composer opens on the account code there.
   The item master is still waiting on the MYOB import (§25).

### Two traps this session re-learned
- A gallery measurement reported a **clean sweep vacuously**: `next start` failed with
  `EADDRINUSE`, the old build kept serving, `getElementById` returned null and the loop
  `continue`d. Check the element exists before trusting a zero.
- `searchAccounts` first ranked revenue *within* a tier, so `5-1000 Towel Purchases` (name starts
  with "towel") beat `4-1000 Sales of Towels` (merely contains it) — the wrong side of the books
  answering a sales question. Revenue is a whole tier ahead now; an exact code still wins outright.

---

## Previous: usable by somebody who has been shown it once
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

## Then four questions the owner answered, same day
Asked rather than assumed — each was theirs, and three could not be done safely in `src/` alone.
CLAUDE.md §3, §7, §11, §22, §24, §26 and the newest changelog entry have it. **Two migrations
(`0034`, `0035`)**, no new table/column/function/capability, no row changed by either.

- **The counter takes laundry in again** (§26, now closed). `customer_service` holds
  `orders.read/write/status` again — the alternative was making a counter hand an **Office
  manager**: 31 screens to do the one job their role is named for. Now ~11.
  **`roles.ts` alone would have been a silent bug**: 0025's *restrictive* write policies are the
  real boundary, so the capability without the policy is Save writing **zero rows with no error**
  — the failure 0025 hit for the driver and 0031 for the board, `lives_ok` passing both times.
  `0034` widens three tables (`laundry_orders` + items + activity) and **only** those three;
  billing and the price list are untouched and the migration asserts that by name. No
  `orders.manage`, and no DELETE on the job — only on its items, which
  `save_laundry_order_items()` (SECURITY INVOKER) needs to replace the child set.
  `main_flow_scope.test.sql` 18 → 29 assertions, each checking the write **landed**.
- **The activity log narrowed** (`0035`). `audit_logs` was 0001's `for all … using is_member`, so
  a driver, a board and the counter read the whole tenant's trail. SELECT → the four `admin.read`
  roles (auditor among them — that is why it is a role list, not `admin.write`). **INSERT stays
  open to every member**: `recordAudit()` runs on the caller's own client, so narrowing it would
  stop the log recording the people it exists to record; `actor_id` is pinned to `auth.uid()`.
  **No UPDATE/DELETE policy at all** → append-only. The `for all` is *dropped*, not supplemented,
  because its USING half grants SELECT (the 0033 trap). New `audit_log_scope.test.sql`, 11
  assertions, all by outcome.
- **§22 said something the database does not do.** It claimed the agreement header is readable
  "to `agreements.read`"; `service_agreements` is `for all … using is_member`, so any member reads
  every header. The decision is sound (a header carries no price) — the **wording** was corrected,
  the policy deliberately not narrowed.
- **Adelaide's four boards have logins.** `board1@`…`board4@ats.example.com`, written by SQL in
  GoTrue's shape (§3a) because this deployment still cannot send an invitation. Boards linked
  **1 of 5 → 5 of 5**, so `LJ00003`/`LJ00004` are no longer on rounds nobody can sign in as.
  Password is a bootstrap, in **no committed file**, and wants replacing once SMTP works.

700 unit tests (was 698), **368 pgTAP assertions (was 348)**, `verify` green, all 35 migrations
against a fresh Postgres 16. Both new proofs were confirmed to **fail without their migration**.

## Then: auth emails moved onto Resend, so no SMTP is needed
The owner's instruction, and it closes the longest-standing open item in the file. CLAUDE.md §10,
§10c, §24 and the newest changelog entry have it. **No migration; no schema, RLS, capability,
policy or workflow change** — one sender replaces another.

**The project had never sent a single auth email and had been saying otherwise.** Invitations used
`inviteUserByEmail`, sign-in links used `signInWithOtp`; both ask **Supabase's built-in mailer**,
which needs custom SMTP nobody configured. Baseline read off the live database first: **0
`auth.one_time_tokens`, 0 `auth.flow_state`, `confirmation_sent_at`/`recovery_sent_at`/`invited_at`
NULL on all 18 logins, 15 of 18 never signed in.** Meanwhile invoices and customer mail have gone
through **Resend** the whole time — a working sender and a broken one, with the auth mail on the
broken one.

- **`generateLink()` is the seam.** It mints a link and **sends nothing**; the app then posts the
  email through `sendEmail()`. That is `ysm-hub`'s arrangement — everything it sends goes through
  `resend.emails.send()` and Supabase delivers none of it.
- **The link points at this app** (`<origin>/auth/invite?token_hash=…`), not at Supabase's
  `/auth/v1/verify`. That removes the §10c deployment step: the project no longer has to list this
  origin under its allowed redirect URLs, so a preview deployment works with zero configuration.
- **A sign-in link is a `recovery` link.** It is the one type that signs a person in *and* lets
  them set a password — what "No password, or forgotten it?" already promised — and it cannot
  create an account, so a typo still cannot mint an orphan login.
- **A refused send deletes the login it just made.** Minting an invite link *creates* the user, and
  leaving a half-made one would make the retry answer "they already have a login" — the one thing
  that stops the admin sending the mail that never went. Provider is checked *before* the mint too.
- **"Email sign-in link" is new on every People row** — the missing rung between changing a role
  and removing access. It is how the four board logins stop sharing one bootstrap password.
- **The anti-enumeration rule is unchanged**, only its vocabulary moved. `classifyLinkError`
  **defaults to "about this address"**, so an unrecognised refusal is hidden rather than becoming
  an oracle; `inviteFailureMessage` is the admin-facing half that is allowed to say more.
- `INVOICE_FROM_EMAIL` is the sender for auth mail too and was deliberately **not** renamed —
  a rename takes a live deployment's mail down on redeploy, for tidiness.

739 unit tests (was 700), `verify` green. Both callers derive the origin from `Host` via one
tested rule — the sign-in form used to read the optional `Origin` header, which would have failed
confusingly the first time somebody asked for a link. `/auth/invite` and `/login` are outside the auth gate so
they could actually be rendered: **72 combinations** (2 themes × 3 text sizes × 4 widths × 3 pages)
with **0 overflow and 0 sub-36px targets**, headings confirmed as "You have been invited" and
"Choose a new password". The 48 console errors are all `ERR_TUNNEL_CONNECTION_FAILED` from the
invite screen calling the *placeholder* Supabase URL the local build uses — `/login` has none.

**Every live login can be sent one today** — checked, not assumed: all 18 are confirmed, unbanned,
not soft-deleted, non-SSO and have a real address, so `generateLink({type:"recovery"})` has a user
to work with for all of them (the four boards included).

**Nothing has been sent yet.** No Resend key and no service key here. **Before trusting it: invite
one real address on `ats.coreit.com.au`, follow the link, then check the counters moved** —
`auth.one_time_tokens` should stop being 0. **Merged to `Dev` and `Prod` (`abbeafa`), CI green on
all three jobs for both.**

## Verified against the live project (2026-08-24)
The accessibility and tidy-up work added **no migration**; the four fixes above added two, both
now applied (§11). Checked at the first pass: advisors **18** (unchanged — no function added), **0** `anon` table grants, **0**
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
- **The month-end run was rehearsed read-only, and that is the finding.** It works — and pressing
  "last month's invoices" *today* answers **nothing to invoice**, because the default period is the
  previous month (1–31 July) and `LJ00002` completed on **20 August**. That reads as *everything is
  billed*, not as *wrong month*. **Set the period to August, or run it in September.** The default
  is right for the ordinary case; the trap is that the first real run is mid-month against a job
  from the current one.
- **Adelaide's four boards now have logins** (fixed, §24) — but it still has **no member who is not
  a platform admin**, and its price list is still empty, so `LJ00002` was priced by hand.

## Do these next
- **Open it with real rows in it.** This container has no Supabase credentials, so no
  authenticated screen was rendered. Sign in as `owner@roles.example.com`, press each card on the
  home screen, and set the text to Biggest on a phone.
- **Change the board password.** `board1@`…`board4@ats.example.com` share one bootstrap password
  (in no committed file — it was reported in chat). **You can now do this**: press *Email sign-in
  link* beside each board on `/admin/users` and let each round set its own.
- **Set `RESEND_API_KEY` and `INVOICE_FROM_EMAIL` on the deployment if they are not already.**
  Every auth email now depends on them; without them each action says so by name rather than
  claiming a success that did not happen.
- **Sign in as the counter and take a job in.** `customer_service` got `orders.*` back and 0034
  widened the policy; the write was proved to land against live rows, but no *screen* has been
  opened as that role.
- Still from the previous session: run the month for Adelaide (**period = August**); invite a real
  person into Adelaide; enter Adelaide's own prices.

## Still open (unchanged from the previous session)
- **`LJ00001`** — Adelaide job, Harbour customer, still `ready_for_delivery`. Remedy is
  cancellation, which is terminal; the owner's call.
- **`service_agreements` is `for all … using is_member(tenant_id)`**, so any operational login
  reads every contract header. Decided 2026-08-24: **left as it is** — a header carries no price,
  and only §22's wording was wrong. `audit_logs` was the other half of that finding and **was**
  narrowed (0035).
- **§23 sweep:** ~345 of 451 `.from(...)` reads still rely on RLS alone; correct for eleven of
  twelve roles, but a platform admin's session spans two laundries.
- **Nothing has talked to Xero yet** (`XERO_CLIENT_ID`/`SECRET` unset by the owner's decision).
- **Auth email now goes through Resend, not Supabase** (2026-08-24), so no SMTP is needed — but
  **it has not been exercised against the provider yet**, and it needs `RESEND_API_KEY` +
  `INVOICE_FROM_EMAIL` on the deployment. Until one real invitation has been followed end to end,
  treat this as built rather than proven.
- Database: **0001–0035 applied to `laundrymart-syd`.** Nothing pending.

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
