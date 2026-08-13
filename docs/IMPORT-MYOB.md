# Importing a MYOB export

How the Adelaide Towel Service books were carried into the app, and how to do it
again — for a re-import, a second tenant, or a fresh environment.

## What the export contains

Five CSVs, downloaded from MYOB. The importer matches them by filename suffix,
so the download's hashed prefix does not matter:

| File | Rows | Lands in |
|---|---|---|
| `…customers_contacts.csv` | 635 | `customers` (447 customers) + `suppliers` (188) |
| `…bills.csv` | 1,515 | `supplier_bills` |
| `…purchase_orders.csv` | 1 | `purchase_orders` |
| `…sale_returns_and_credits.csv` | 46 | `invoices`, `invoice_type = 'credit'` |
| `…categories_chart_of_accounts.csv` | 268 | `gl_accounts` |

**The CSVs are not in this repository, and should not be.** They are a real
customer and supplier list with contact details; a git history is a bad place
for one, and the app is the right home for the data. Keep the export wherever
the business keeps its accounting downloads and point the script at it.

## Running it

```bash
python3 scripts/import/myob-import.py <export-dir> <tenant-uuid> > import.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f import.sql
```

The tenant must already exist, along with a membership for whoever will look at
the data — the import writes rows, not access:

```sql
insert into public.tenants (id, name, timezone)
values ('<tenant-uuid>', 'Adelaide Towel Service', 'Australia/Adelaide');
insert into public.memberships (user_id, tenant_id, role)
values ('<auth-user-uuid>', '<tenant-uuid>', 'super_admin');
```

Two flags matter when the database can only be reached through a tool that caps
a single statement — a Supabase project behind an egress policy, for one:

* `--compact` emits each batch as a pipe-separated blob the server splits,
  rather than a VALUES list. About a third smaller.
* `--max-bytes N` closes a batch on size instead of row count, so no single
  statement exceeds the cap. `--max-bytes 11000` yields statements under 11 KB.

Re-running is safe. Parties upsert on a name-derived id and documents on their
own number, so the same export always addresses the same rows. The one caveat
is in the script's docstring: customer and supplier *numbers* are positional, so
a re-run of a **grown** export stops on the unique index rather than renumbering
silently.

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

| Chart of accounts | Should equal |
|---|---|
| `2-1200` Trade Creditors — 65,724.25 | `sum(balance_due)` over `supplier_bills` |
| `1-1200` Trade Debtors — 131,061.74 | `sum(opening_balance)` over `customers` |

The first ties exactly. **The second does not**: the contact export's customer
balances total 125,595.68, which is 5,466.06 short of the ledger. The difference
is in the source data, not the import — the contact list and the GL disagree, as
they commonly do when credits and unallocated receipts sit in between. It is
recorded here rather than reconciled away, because guessing an adjustment would
put a number in the books that nobody in the business decided on.
