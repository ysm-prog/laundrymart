# Importing a MYOB export

How the Adelaide Towel Service books were carried into the app, and how to do it
again — for a re-import, a second tenant, or a fresh environment.

## What the export contains

Eight files across two rounds, matched by filename suffix so the download's
hashed prefix does not matter. The first five came together; the last three
arrived afterwards and are opt-in via `--sections`.

| File | Rows | Lands in |
|---|---|---|
| `…customers_contacts.csv` | 635 | `customers` (447 customers) + `suppliers` (188) |
| `…bills.csv` | 1,515 | `supplier_bills` |
| `…purchase_orders.csv` | 1 | `purchase_orders` |
| `…sale_returns_and_credits.csv` | 46 | `invoices`, `invoice_type = 'credit'` |
| `…categories_chart_of_accounts.csv` | 268 | `gl_accounts` |
| `…ContactsReport.xlsx` | 315 | statuses and authoritative balances on `customers` / `suppliers` |
| `…invoices.csv` | 17,183 | `invoices` (646 outstanding loaded; see below) |
| `…remittance_advice.csv` | 62 | `supplier_payments` |

Two further files add nothing: `…purchase_returns_and_debits.csv` is 12 rows
already present in `bills.csv`, and `…SalesRegisterReport.xlsx` is 24 rows
already present in `invoices.csv`. Both were checked row by row rather than
assumed.

**The CSVs are not in this repository, and should not be.** They are a real
customer and supplier list with contact details; a git history is a bad place
for one, and the app is the right home for the data. Keep the export wherever
the business keeps its accounting downloads and point the script at it.

## Running it: from the app

**Settings → Bring in your books** (`/admin/import`, `admin.write`). Upload the
files, read the summary, press the button. That is the whole procedure, and it
is the one to use.

It works in two steps on purpose. The plan is built, counted and shown before
anything is written, because this import's failure mode is a number that is
wrong but entirely plausible — see the dropped column below. The preview and the
write are the *same* code (`buildPlan` in `src/lib/domain/myob/plan.ts`), so the
summary cannot describe a different import from the one that runs.

Two things it does that the script cannot:

* **Party numbers come from the database.** A customer already here keeps the
  number they have; only genuinely new ones are numbered, from the highest in
  use. That retires the script's one silent trap (below).
* **A party the upload only *names* is never overwritten.** Upload `invoices.csv`
  on its own and the customers it references are matched, not rewritten — an
  existing customer will not be flipped to inactive with their balance wiped.

Upload as much as fits in 4 MB at a time; a request larger than that never
reaches the app. Splitting is safe and the order does not matter, because every
row is matched on its own natural key rather than appended.

## Running it: from the command line

Still here, unchanged, for a deployment with no app in front of it or a database
reachable only through a statement-capped tool. It is the path the original load
used.

```bash
python3 scripts/import/myob-import.py <export-dir> <tenant-uuid> > import.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f import.sql
```

**The two implementations must agree.** `src/lib/domain/myob` is a port of the
script and is now the living one: it has the unit tests, and `myob.test.ts` pins
its identity function against four ids the hosted database actually holds, so an
upload updates the rows the script created rather than making a second copy. If
a rule changes, change the TypeScript; treat the script as the record of how the
first load was produced.

The tenant must already exist, along with a membership for whoever will look at
the data — the import writes rows, not access:

```sql
insert into public.tenants (id, name, timezone)
values ('<tenant-uuid>', 'Adelaide Towel Service', 'Australia/Adelaide');
insert into public.memberships (user_id, tenant_id, role)
values ('<auth-user-uuid>', '<tenant-uuid>', 'super_admin');
```

`--sections` picks what to emit: the six the first round filled (the default),
or any of `contacts`, `invoices`, `payments` from the second. `--invoices`
takes `outstanding` (the default — the 646 that still carry a balance) or
`all` (every one of the 17,183, which is roughly 825 KB of SQL).

Two flags matter when the database can only be reached through a tool that caps
a single statement — a Supabase project behind an egress policy, for one:

* `--compact` emits each batch as a pipe-separated blob the server splits,
  rather than a VALUES list. About a third smaller.
* `--max-bytes N` closes a batch on size instead of row count, so no single
  statement exceeds the cap. `--max-bytes 11000` yields statements under 11 KB.

Re-running is safe. Parties upsert on a name-derived id and documents on their
own number, so the same export always addresses the same rows. The one caveat
applies **to the script only**: customer and supplier *numbers* are positional
there, so a re-run of a **grown** export stops on the unique index rather than
renumbering silently. The app's importer reads the numbers back from the
database instead, and has no such limit.

## What the export gets wrong, and what the importer does about it

* **The bills file silently loses a column.** When "Supplier Invoice No" is
  blank MYOB omits the field instead of emitting an empty one, so every later
  value shifts one place left — 667 of the 1,515 rows. Detected by Status being
  empty and repaired. Unrepaired, those rows import a *date* into the amount
  column and every one of them is wrong in a way that still looks plausible.
* **Money is legitimately negative.** A supplier debit note is money owed back
  to the business; a customer credit is a negative balance. Nothing is clamped,
  and `purchases_scope.test.sql` asserts a negative balance survives — an
  "amounts are positive" check would have dropped 10 real bills.
* **Documents name parties the contact list no longer carries.** Four suppliers
  and 12 customers exist only in document history. They are created `inactive`
  with a note saying so, rather than dropping the documents that reference them.
* **A credit has no lines, only a total.** So `subtotal` and `total` carry the
  MYOB figure and `tax_amount` stays zero rather than being back-computed from a
  GST rate the export never states. Running `recalculate_invoice()` over one of
  these would zero it, since that function derives totals from lines.

## Reconciling afterwards

Two figures in the chart of accounts are the check on the rest:

| Chart of accounts | Ties to |
|---|---|
| `2-1200` Trade Creditors — 65,724.25 | `sum(balance_due)` over `supplier_bills` — **exact** |
| `1-1200` Trade Debtors — 131,061.74 | `sum(total - amount_paid)` over `invoices` — **50c out** |

The remaining fifty cents is one customer, Price Attack - Colonnades, whose
contact balance is 50c more than their own invoices add up to. It is in the
source, not the import, and it is left alone: guessing an adjustment puts a
number in the books that nobody in the business decided on.

### A correction to what this file used to say

An earlier version of this document recorded a 5,466.06 gap on the receivable
side and attributed it to the source data. That was wrong, and the second round
of exports is what showed it. `customers_contacts.csv` is not the balance-bearing
list — it omits 60 customers, nearly all closed accounts that still owe money,
and those 60 account for 5,464.06 of the 5,466.06. `ContactsReport.xlsx` is the
list that ties to the ledger, and the invoices tie to it in turn. The lesson is
worth keeping: an export that looks complete because it is the longest one is
not thereby the authoritative one.

### The whitespace duplicates

Two parties are written with a doubled space in one export and a single space in
another — `Salute Better Solutions P/L  - Pak-Rite` and `Barber Boys x Anthony
Pty Ltd`. A party's identity here is its name, so unrepaired they import as two
records: one holding the documents, the other holding the balance those
documents are supposed to explain. The importer collapses runs of whitespace in
every cell it reads, which is why the residual openings come out at zero
instead of at 3,668.57 and 78.00.

### Opening balances are not a running total

`customers.opening_balance` and `suppliers.opening_balance` hold what a party
arrived with **that no imported document accounts for**. Once the invoice or
bill carrying that money is imported, the opening goes to zero — otherwise any
query that added the two would count the same debt twice. `0015` does this for
what is already loaded and the importer repeats it after every later run. In
this tenant both totals are now zero, because every outstanding document is in.
