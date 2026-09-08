# Runbook — switching on customer email, and connecting Xero

Both are **configuration, not code**. Every screen, action and template already
exists and is tested; what is missing on `ats.coreit.com.au` is a set of values
only somebody with the accounts can supply. This is the ordered list of what to
do, in the order to do it, and how to tell each step worked.

Written 2026-09-08, at the owner's request. `CLAUDE.md` §10d covers the email
design and §20 the Xero design — this is the *doing* half, one followable pass.

Two facts to hold on to before starting:

- **Nothing has ever been sent from this deployment.** 0 invoices carry a sent
  address, 0 one-time tokens exist, 0 recovery mails. The first real send is
  still ahead, so treat every step as unproven until its check passes.
- **Nothing has ever been pushed to Xero.** 0 `xero_connections` rows, and no
  `XERO_CLIENT_ID`. Same rule.

---

## Part 1 — Customer email

### What it switches on

Five things go out through one provider once this is done: the invoice with its
PDF, the delivery confirmation, the overdue chase, the staff invitation, and the
sign-in link. The last two work the moment the provider does — they are how a new
person gets into the app at all, so this is worth doing even if you never email a
customer.

### Step 1 — Add the sending domain in Resend

1. Sign in to [resend.com](https://resend.com) and add your sending domain —
   the one the address in step 2 lives on (`adelaidetowelservice.com.au`, say).
2. Add the DNS records Resend shows you. **SPF and DKIM at minimum.** They go in
   whatever manages that domain's DNS.
3. Wait for Resend to show the domain as **verified**.

> **Do not skip the wait.** Until the domain verifies, the Resend API *accepts*
> your sends and they land in spam or bounce. That looks exactly like the app
> failing, and it is the single most likely way this goes wrong.

Then create an API key in Resend and keep it to hand for step 2.

### Step 2 — Set four variables on Vercel

On the Vercel project, under Settings → Environment Variables. Set them for
**Production _and_ Preview** — a preview deployment with these missing sends
nothing, silently.

| Variable | What it is |
|---|---|
| `RESEND_API_KEY` | The key from step 1. |
| `INVOICE_FROM_EMAIL` | The address customers see it from. Must be on the domain you just verified, or sends bounce. |
| `INVOICE_FROM_NAME` | **The laundry's own name**, not the app's and not Core IT's. An invoice comes from the business; the Core IT credit is a line in the footer. |
| `INVOICE_REPLY_TO` | Where a customer's reply should land. Often the same as the from address. |

The names still say `INVOICE_` because renaming them would take a live
deployment's mail down at the moment it redeployed. They are the sender for
*all* of it, invitations included.

**Redeploy after setting them** — env vars are read at build/boot.

### Step 3 — Prove it reaches an inbox

Sign in as an owner and go to **Settings → Notifications**.

- If the provider is not configured the screen says so. If it still says so after
  a redeploy, the variables are not reaching the running deployment.
- Press **Send a test email**. It goes to *your own* signed-in address and
  nowhere else — deliberately, so an admin login cannot be used to mail
  strangers — and it is written to the audit log either way.

**Check it arrived, and check it did not land in spam.** If it is in spam, go
back to step 1: the DNS is not right yet.

### Step 4 — Only now, consider the customer switches

Same screen. In-app notifications are on by default; **customer email is off**.

- `deliveryConfirmation` — a note to the customer when a delivery is recorded,
  with the proof of service captured at the door.
- `overdueReminder` — the chase: first at 7 days past terms, weekly, three at
  most.

> **Read this before switching the chase on.** A customer is never chased about
> an invoice this app did not send (`chaseBlockedBecause`), and on this
> deployment that means **all 646 imported invoices** — they came out of MYOB as
> headers, and MYOB is where their money was recorded. That guard is what stops
> the first sweep chasing real businesses about amounts this app cannot see a
> settlement for. It is doing real work; do not remove it.

### Step 5 — Send one real invoice

Issue one invoice and send it, to a customer you can ring. That is the only step
that exercises the whole path including the PDF attachment.

---

## Part 2 — Xero

### Before you start

Xero is **per laundry**, not per deployment: `xero_connections` is keyed on
`tenant_id`. Connecting posts this laundry's receivables into the Xero
organisation you authorise, and nobody else's.

### Step 1 — Create a Xero app

1. At [developer.xero.com](https://developer.xero.com), create an app for
   this deployment.
2. Register the redirect URI **exactly**:

   ```
   https://ats.coreit.com.au/api/xero/callback
   ```

   The app derives this from the request origin, so a preview deployment
   connects to itself — but each origin you want to connect from must be
   registered on the Xero app once.
3. The scopes the app requests are fixed in `lib/xero/config.ts`:

   ```
   openid profile email offline_access accounting.transactions accounting.contacts
   ```

   `offline_access` is the one that matters most: without it the connection dies
   in thirty minutes and somebody reconnects by hand.

### Step 2 — Set two variables on Vercel

`XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`, Production and Preview. A **partial**
pair counts as unconfigured — the app treats one-without-the-other as "not set
up" rather than half-working. Redeploy.

### Step 3 — Connect, and pick two accounts

Go to **Money → Xero**.

1. Press connect and authorise the Xero organisation.
2. Pick the **bank account** payments post to. Xero refuses a payment without
   one, and guessing would put real money against the wrong ledger with nothing
   to notice it — so payments are *skipped* until this is chosen, not failed.
3. Pick the **sales account** invoice lines default to. This is the fallback
   under the per-line and per-item coding, and it matters because most invoice
   lines carry no item at all — a fuel levy, a minimum, a consolidated laundry
   charge. Without it those lines arrive uncoded and a bookkeeper re-codes them
   every month.

### Step 4 — Push exactly one invoice, then exactly one payment

Issue one invoice, then open it in Xero and check it line by line. Then take one
payment against it and check that in Xero too.

Two things to look at specifically, because they are what nobody has ever seen
working:

- **The account code on each line.** It travels
  `invoice_lines.gl_account_id` → the item's income account → the connection's
  default sales account, and every tier resolves through
  `gl_accounts.xero_account_code`. **0 of your 268 accounts carry a Xero code
  today**, so unless you fill some in, every line will arrive on the default
  sales account. That is correct behaviour, not a fault — but it is worth
  knowing before you conclude the coding does not work.
- **The totals.** A line amount we send already includes GST and the payload
  says so (`LineAmountTypes: "Inclusive"`). A $72.70 line must read $72.70 in
  Xero, not $79.97.

### Known and deliberately open

Two gaps in the payload, left until a real connection exists to test against —
the owner's decision of 2026-09-08, and §20's own position:

1. **Freight is not sent.** `invoices.freight_amount` / `freight_tax_code`
   (0043) are not in the payload, so an invoice carrying freight would push
   short by that amount. Inert today: nothing in the app writes either column
   and no screen offers them. Closing it means choosing a description and an
   account code for a line Xero has no dedicated field for.
2. **Xero recomputes `Quantity × UnitAmount`; we sum frozen amounts.**
   `consolidateChargeLines` deliberately sums the approved charge amounts so the
   invoice equals its audit trail to the cent, which means a merged line's stored
   amount can sit a cent from its own quantity times its own unit price. Closing
   it means sending `LineAmount` explicitly — which Xero *validates* against the
   other two fields, so a wrong guess fails every push.

**Do the first real push before closing either.** A payload Xero rejects does not
fail one invoice, it fails all of them.

---

## What good looks like, in one query

After both parts, these should have moved off zero:

```sql
select
  (select count(*) from invoices where emailed_to is not null) as invoices_emailed,
  (select count(*) from xero_connections)                     as xero_connections,
  (select count(*) from invoices where xero_invoice_id is not null) as invoices_in_xero;
```

Until they do, neither integration has been proved — however green the app looks.
