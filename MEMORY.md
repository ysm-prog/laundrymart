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

## Latest: no ledger accounts on a job charge
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

## Before it: the item code is typed where the charge is written
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
