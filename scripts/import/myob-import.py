#!/usr/bin/env python3
"""Turn a MYOB export into SQL for one tenant.

    python3 scripts/import/myob-import.py <export-dir> <tenant-uuid> > import.sql

The export directory holds the five CSVs MYOB produces, matched by suffix so the
download's hashed filename prefix does not matter:

    …customers_contacts.csv          customers *and* suppliers, with balances
    …bills.csv                       accounts payable
    …purchase_orders.csv             open orders
    …sale_returns_and_credits.csv    customer credit balances
    …categories_chart_of_accounts.csv

The CSVs themselves are deliberately **not** in this repository: they are a real
customer and supplier list with contact details, and a git history is the wrong
place for it. This script is the reproducible part; the export is handed to it.

Two things about the export are load-bearing:

*   **The bills file loses a column.** When "Supplier Invoice No" is blank MYOB
    omits the field rather than emitting an empty one, so every later value
    shifts one place left and the row ends with a stray empty field. 667 of the
    1515 rows are like this. Detected by Status being empty and repaired below —
    unrepaired, every one of those rows would have imported a date as its
    amount.
*   **Money is legitimately negative.** A supplier debit note is money owed back
    to us, and a customer credit is a negative balance on an invoice. Nothing
    here clamps to zero.

The output is one transaction: re-running it replaces the imported rows for that
tenant rather than doubling them. Every id is a uuid5 of tenant + table + the
row's natural key, so the same export always addresses the same rows and the
`on conflict (id) do update` clauses refresh them in place. Rows the app has
created since are untouched.

One limit of that, stated because it is silent otherwise: customer and supplier
numbers are assigned by position in the name-sorted export, so re-running a
*grown* export can hand an existing number to a new party and the import will
stop on the unique index rather than corrupt anything. Re-run a changed export
into a tenant that has no earlier import, or renumber first.
"""
from __future__ import annotations

import csv
import glob
import os
import re
import sys
import uuid

DATE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")
# Deterministic ids, so a re-run updates the same rows instead of inserting new
# ones. The namespace is arbitrary but fixed; the name is tenant + table + key.
NS = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")


def die(message: str) -> None:
    sys.exit(f"myob-import: {message}")


def find(directory: str, suffix: str) -> str:
    matches = glob.glob(os.path.join(directory, f"*{suffix}"))
    if len(matches) != 1:
        die(f"expected exactly one *{suffix} in {directory}, found {len(matches)}")
    return matches[0]


def load(directory: str, suffix: str) -> list[dict[str, str]]:
    with open(find(directory, suffix), encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def money(value: str | None) -> float:
    text = (value or "").strip().replace(",", "").replace("$", "")
    return round(float(text), 2) if text else 0.0


def day(value: str | None) -> str | None:
    match = DATE.match((value or "").strip())
    return f"{match[3]}-{match[2]}-{match[1]}" if match else None


def text(value: str | None) -> str | None:
    return (value or "").strip() or None


def q(value) -> str:
    """SQL literal. Nothing here is parameterised, so quoting is the boundary."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def ident(tenant: str, table: str, key: str) -> str:
    return str(uuid.uuid5(NS, f"{tenant}:{table}:{key}"))


def number(prefix: str, index: int) -> str:
    return f"{prefix}{index:05d}"


class Emitter:
    """Writes one transaction of batched upserts.

    Rows go out as `insert … select <tenant>, v.col::type … from (values …)`
    rather than one statement per row. That is not only shorter: `tenant_id` is
    written once per batch from a single place, so no row can carry a different
    one, and every column is cast explicitly in the select list. The casts are
    load-bearing — a VALUES column that is NULL in every row of a batch has no
    type of its own, and several here legitimately are (a bill whose supplier
    invoice number is blank throughout a batch, for one).
    """

    #: Rows per statement. Small enough that a failure names a findable batch.
    BATCH = 250
    #: In compact mode a batch is closed on bytes instead, since row widths
    #: differ by an order of magnitude between tables and what a channel caps is
    #: the statement, not the row count. `--max-bytes` lowers it.
    MAX_BYTES = 100_000

    def __init__(self, tenant: str, compact: bool = False,
                 batch: int = BATCH, max_bytes: int = MAX_BYTES) -> None:
        self.tenant = tenant
        self.BATCH = batch
        self.MAX_BYTES = max_bytes
        #: Emit each batch as one tab-separated blob parsed by the server rather
        #: than as a VALUES list. A third of the size, which is what makes the
        #: import fit down a narrow channel — the deployment this was written
        #: for could only be reached through a SQL-over-API tool, not psql.
        #: Pipe-separated because a business name may contain a comma or a
        #: quote but never a pipe, so nothing needs escaping — and unlike a tab
        #: the separator stays visible in whatever carries the SQL. The script
        #: refuses to emit a value containing one rather than trusting that.
        self.compact = compact
        self.write = sys.stdout.write
        self.write("-- Generated by scripts/import/myob-import.py. Do not edit by hand.\n")
        self.write(f"-- tenant {tenant}\n\nbegin;\n\n")

    def rows(self, table: str, signature: str, values: list[tuple],
             conflict: str, update: list[str],
             lookup: tuple[str, str, str] | None = None) -> None:
        """Emit `values` as batched upserts into `table`.

        `signature` is "name type, name type, …", one pair per column, in the
        order the tuples carry.

        `lookup` is (parent table, its number column, the FK to fill). When
        given, the row's **first** column holds the parent's number rather than
        its id and the statement joins to resolve it. A bill then quotes an
        eight-character supplier number instead of a 36-character uuid, which
        on this export is a third of the whole import — and the join fails loudly
        if a document names a party that was never inserted.
        """
        if not values:
            return
        pairs = [part.strip().split() for part in signature.split(",")]
        assignments = ", ".join(f"{c} = excluded.{c}" for c in update)

        if lookup:
            parent, parent_number, foreign_key = lookup
            columns = [foreign_key] + [name for name, _ in pairs[1:]]
            join = (f"\njoin public.{parent} p on p.tenant_id = {q(self.tenant)}\n"
                    f"                       and p.{parent_number} = ")
        else:
            columns = [name for name, _ in pairs]
            join = ""

        self.write(f"-- {table}: {len(values)} rows\n")
        for batch in self._batches(values):
            self.write(
                self._compact(table, columns, pairs, batch, conflict, assignments, join)
                if self.compact
                else self._values(table, columns, pairs, batch, conflict, assignments, join))
        self.write("\n")

    def _batches(self, values: list[tuple]):
        """Rows per statement: a count normally, a byte budget when compact."""
        if not self.compact:
            for start in range(0, len(values), self.BATCH):
                yield values[start:start + self.BATCH]
            return
        batch, size = [], 0
        for row in values:
            width = sum(len(str(v)) + 1 for v in row if v is not None) + len(row)
            if batch and (size + width > self.MAX_BYTES or len(batch) >= self.BATCH):
                yield batch
                batch, size = [], 0
            batch.append(row)
            size += width
        if batch:
            yield batch

    def _values(self, table, columns, pairs, batch, conflict, assignments, join) -> str:
        """The readable form: one VALUES row per record."""
        first = pairs[0][0]
        selected = ", ".join(
            (["p.id"] if join else []) + [f"v.{name}::{kind}" for name, kind in
                                          (pairs[1:] if join else pairs)])
        return (
            f"insert into public.{table} (tenant_id, {', '.join(columns)})\n"
            f"select {q(self.tenant)}, {selected}\n"
            "from (values\n"
            + ",\n".join("  (" + ", ".join(q(v) for v in row) + ")" for row in batch)
            + f"\n) as v({', '.join(name for name, _ in pairs)})"
            + (f"{join}v.{first}" if join else "")
            + f"\non conflict {conflict} do update set {assignments};\n")

    def _compact(self, table, columns, pairs, batch, conflict, assignments, join) -> str:
        """The dense form: one tab-separated blob the server splits."""
        def cell(value) -> str:
            if value is None:
                return ""
            if isinstance(value, bool):
                return "t" if value else "f"
            return str(value)

        for row in batch:
            for value in row:
                if isinstance(value, str) and ("|" in value or "\n" in value):
                    die(f"a {table} value contains a pipe or newline: {value!r}")

        blob = "\n".join("|".join(cell(value) for value in row) for row in batch)
        # `nullif(…, '')` restores the NULLs the blank fields stand for; every
        # column is cast from text, exactly as in the readable form.
        selected = ", ".join(
            (["p.id"] if join else [])
            + [f"nullif(f[{i}], '')::{kind}"
               for i, (_name, kind) in enumerate(pairs, start=1) if not (join and i == 1)])
        return (
            f"insert into public.{table} (tenant_id, {', '.join(columns)})\n"
            f"select {q(self.tenant)}, {selected}\n"
            "from (select string_to_array(line, '|') f from\n"
            f"  regexp_split_to_table($import${blob}$import$, e'\\n') line) t"
            + (f"{join}f[1]" if join else "")
            + f"\non conflict {conflict} do update set {assignments};\n")

    def finish(self) -> None:
        self.write("\ncommit;\n")


# ---------------------------------------------------------------- readers ---

def read_contacts(directory):
    out = []
    for row in load(directory, "customers_contacts.csv"):
        name = text(row["Name"])
        if not name:
            continue
        emails = [e.strip() for e in (row["Email"] or "").split(";") if e.strip()]
        out.append({
            "name": name,
            "kind": row["Type"].strip().lower(),
            "phone": text(row["Phone Number"]),
            # MYOB packs several addresses into one cell. The first is the one
            # invoices go to; the rest are kept as a note rather than dropped,
            # since `customers` bills to a single address.
            "email": emails[0] if emails else None,
            "extra_emails": emails[1:],
            "reminders": (row["Automated Reminders"] or "").strip().endswith("on"),
            "balance": money(row["Balance Due"]),
            "overdue": money(row["Overdue"]),
        })
    return out


def read_bills(directory):
    out = []
    for row in load(directory, "bills.csv"):
        if row["Status"] == "":            # the dropped-column case; see above
            issue, num, supplier = row["Issue Date"], row["Bill Number"], row["Supplier"]
            invoice_no = None
            amount, balance = row["Supplier Invoice No"], row["Amount"]
            due, status = row["Balance Due"], row["Due Date"]
        else:
            issue, num, supplier = row["Issue Date"], row["Bill Number"], row["Supplier"]
            invoice_no = text(row["Supplier Invoice No"])
            amount, balance = row["Amount"], row["Balance Due"]
            due, status = row["Due Date"], row["Status"]
        out.append({
            "issue_date": day(issue), "number": text(num), "supplier": text(supplier),
            "invoice_no": invoice_no, "amount": money(amount), "balance": money(balance),
            "due_date": day(due), "status": (text(status) or "open").lower(),
        })
    return out


def read_orders(directory):
    return [{
        "issue_date": day(row["Issue Date"]), "number": text(row["PO Number"]),
        "supplier": text(row["Supplier"]), "invoice_no": text(row["Supplier Invoice No"]),
        "amount": money(row["Amount"]), "balance": money(row["Balance Due"]),
        "promised_date": day(row["Promised Date"]),
    } for row in load(directory, "purchase_orders.csv")]


def read_credits(directory):
    out = []
    for row in load(directory, "sale_returns_and_credits.csv"):
        amount, balance = money(row["Amount"]), money(row["Balance Due"])
        out.append({
            "issue_date": day(row["Issue Date"]), "number": text(row["Invoice Number"]),
            "customer": text(row["Customer"]), "po": text(row["Customer PO No"]),
            "amount": amount, "balance": balance,
            # `invoices.balance` is generated as total - amount_paid, so the
            # credit is expressed by what was paid against it rather than
            # written into the balance directly.
            "paid": round(amount - balance, 2),
        })
    return out


def read_accounts(directory):
    out, seen = [], set()
    for row in load(directory, "categories_chart_of_accounts.csv"):
        name = text(row["Name"])
        if not name:
            continue
        code = text(row["Code"])
        header = code is None
        if header:
            # The six classification rows carry no code. A synthetic one keeps
            # the table's natural key usable without inventing a hierarchy.
            code = "0-" + re.sub(r"[^a-z]+", "", name.lower())[:8].upper()
        if code in seen:
            die(f"duplicate account code {code}")
        seen.add(code)
        out.append({
            "code": code, "name": name, "type": text(row["Type"]) or "Other",
            "tax_code": text(row["Tax Code"]),
            "linked": (row["Linked"] or "").strip().lower() == "linked",
            "header": header, "level": int((row["Level"] or "Level 1").split()[-1]),
            "balance": money(row["Current Balance"]),
        })
    return out


# ------------------------------------------------------------------ emit ---

def main() -> None:
    argv = sys.argv[1:]
    compact = "--compact" in argv
    batch, max_bytes = Emitter.BATCH, Emitter.MAX_BYTES
    for flag, setter in (("--batch", "batch"), ("--max-bytes", "max_bytes")):
        if flag in argv:
            at = argv.index(flag)
            value = int(argv[at + 1])
            batch, max_bytes = (value, max_bytes) if setter == "batch" else (batch, value)
            del argv[at:at + 2]
    args = [a for a in argv if a != "--compact"]
    if len(args) != 2:
        die("usage: myob-import.py [--compact] [--batch N] [--max-bytes N] "
            "<export-dir> <tenant-uuid>")
    directory, tenant = args
    try:
        uuid.UUID(tenant)
    except ValueError:
        die(f"{tenant} is not a uuid")

    contacts = read_contacts(directory)
    bills = read_bills(directory)
    orders = read_orders(directory)
    credits = read_credits(directory)
    accounts = read_accounts(directory)

    known = {c["name"] for c in contacts}
    # A document can name a party the contact export no longer lists — an
    # account closed in MYOB keeps its history. Those parties are created here
    # too, inactive, rather than dropping the documents that reference them.
    lapsed_suppliers = sorted({b["supplier"] for b in bills if b["supplier"] not in known}
                              | {o["supplier"] for o in orders if o["supplier"] not in known})
    lapsed_customers = sorted({c["customer"] for c in credits if c["customer"] not in known})

    customers = [c for c in contacts if c["kind"] == "customer"]
    suppliers = [c for c in contacts if c["kind"] == "supplier"]
    for name in lapsed_customers:
        customers.append({"name": name, "kind": "customer", "phone": None, "email": None,
                          "extra_emails": [], "reminders": False, "balance": 0.0,
                          "overdue": 0.0, "lapsed": True})
    for name in lapsed_suppliers:
        suppliers.append({"name": name, "kind": "supplier", "phone": None, "email": None,
                          "extra_emails": [], "reminders": False, "balance": 0.0,
                          "overdue": 0.0, "lapsed": True})
    customers.sort(key=lambda c: c["name"].lower())
    suppliers.sort(key=lambda c: c["name"].lower())

    customer_id = {c["name"]: ident(tenant, "customers", c["name"]) for c in customers}
    supplier_id = {s["name"]: ident(tenant, "suppliers", s["name"]) for s in suppliers}
    # Documents quote these rather than the uuid; see Emitter.rows(lookup=…).
    supplier_no = {s["name"]: number("SUP", i) for i, s in enumerate(suppliers, start=1)}
    customer_no = {c["name"]: number("CUST", i) for i, c in enumerate(customers, start=1)}

    out = Emitter(tenant, compact=compact, batch=batch, max_bytes=max_bytes)

    def note(party) -> str | None:
        bits = []
        if party.get("lapsed"):
            bits.append("Carried in from MYOB document history; not on the current contact list.")
        if party["extra_emails"]:
            bits.append("Also emails: " + ", ".join(party["extra_emails"]) + ".")
        return " ".join(bits) or None

    # ------------------------------------------------------------ customers ---
    # Parties keep an explicit id, derived from the name, because their natural
    # key is the name and there is no unique index on it to conflict against.
    # Numbers cannot serve: they are positional, so on a grown export the same
    # number would land on a different business.
    out.rows(
        "customers",
        "id uuid, customer_number text, business_name text, billing_email text, phone text, "
        "status text, notes text, opening_balance numeric, opening_balance_overdue numeric, "
        "reminders_enabled boolean",
        [(customer_id[c["name"]], customer_no[c["name"]], c["name"], c["email"], c["phone"],
          "inactive" if c.get("lapsed") else "active", note(c),
          c["balance"], c["overdue"], c["reminders"])
         for c in customers],
        conflict="(id)",
        update=["business_name", "billing_email", "phone", "opening_balance",
                "opening_balance_overdue", "reminders_enabled"],
    )

    # ------------------------------------------------------------ suppliers ---
    out.rows(
        "suppliers",
        "id uuid, supplier_number text, name text, email text, phone text, status text, "
        "notes text, opening_balance numeric",
        [(supplier_id[s["name"]], supplier_no[s["name"]], s["name"], s["email"], s["phone"],
          "inactive" if s.get("lapsed") else "active", note(s), s["balance"])
         for s in suppliers],
        conflict="(id)",
        update=["name", "email", "phone", "opening_balance"],
    )

    # ------------------------------------------------------------- accounts ---
    # From here down every table has a unique index on its own document number,
    # which is a genuinely stable natural key — so no synthetic id is carried.
    out.rows(
        "gl_accounts",
        "code text, name text, account_type text, tax_code text, is_linked boolean, "
        "is_header boolean, level integer, current_balance numeric",
        [(a["code"], a["name"], a["type"], a["tax_code"], a["linked"], a["header"],
          a["level"], a["balance"]) for a in accounts],
        conflict="(tenant_id, code)",
        update=["name", "account_type", "tax_code", "current_balance"],
    )

    # ---------------------------------------------------------------- bills ---
    bill_rows, dropped_dues = [], 0
    for b in bills:
        if b["supplier"] not in supplier_id:
            die(f"bill {b['number']} names unknown supplier {b['supplier']}")
        # MYOB allows a bill to fall due before it was issued on a handful of
        # back-dated rows; the table's check refuses that, so the due date is
        # dropped rather than the bill. Recorded in notes, not swallowed.
        due = b["due_date"]
        dropped = due is not None and b["issue_date"] is not None and due < b["issue_date"]
        if dropped:
            dropped_dues += 1
        bill_rows.append((
            supplier_no[b["supplier"]], b["number"], b["invoice_no"], b["issue_date"],
            None if dropped else due, b["amount"], b["balance"], b["status"],
            f"MYOB due date {due} predates the issue date; not imported." if dropped else None,
        ))
    out.rows(
        "supplier_bills",
        "supplier_number text, bill_number text, supplier_invoice_no text, issue_date date, "
        "due_date date, amount numeric, balance_due numeric, status text, notes text",
        bill_rows,
        conflict="(tenant_id, bill_number)",
        update=["amount", "balance_due", "status", "due_date", "supplier_invoice_no"],
        lookup=("suppliers", "supplier_number", "supplier_id"),
    )

    # ------------------------------------------------------- purchase orders ---
    for o in orders:
        if o["supplier"] not in supplier_id:
            die(f"purchase order {o['number']} names unknown supplier {o['supplier']}")
    out.rows(
        "purchase_orders",
        "supplier_number text, po_number text, supplier_invoice_no text, issue_date date, "
        "promised_date date, amount numeric, balance_due numeric, status text",
        [(supplier_no[o["supplier"]], o["number"], o["invoice_no"], o["issue_date"],
          o["promised_date"], o["amount"], o["balance"],
          "closed" if o["balance"] == 0 else "open") for o in orders],
        conflict="(tenant_id, po_number)",
        update=["amount", "balance_due", "status"],
        lookup=("suppliers", "supplier_number", "supplier_id"),
    )

    # -------------------------------------------------------------- credits ---
    # These are real invoices that ended up in credit, so they land in
    # `invoices` as `credit` rather than in a table of their own — the customer
    # statement has to show them beside everything else they were billed.
    #
    # They arrive with no lines, because the export has none: only a document
    # total. `subtotal` and `total` therefore carry the MYOB figure as-is and
    # `tax_amount` stays zero rather than being back-computed from a GST rate
    # the export never states. Consequence worth knowing: running
    # `recalculate_invoice()` over one of these would zero it, since that
    # function derives totals from lines.
    for c in credits:
        if c["customer"] not in customer_id:
            die(f"credit {c['number']} names unknown customer {c['customer']}")
    out.rows(
        "invoices",
        "customer_number text, invoice_number text, invoice_type text, status text, "
        "issue_date date, purchase_order_number text, subtotal numeric, total numeric, "
        "amount_paid numeric, notes text",
        [(customer_no[c["customer"]], c["number"], "credit",
          "paid" if c["balance"] == 0 else "issued", c["issue_date"], c["po"],
          c["amount"], c["amount"], c["paid"],
          "Imported from the MYOB sale returns and credits export.") for c in credits],
        conflict="(tenant_id, invoice_number)",
        update=["total", "subtotal", "amount_paid", "status"],
        lookup=("customers", "customer_number", "customer_id"),
    )

    # -------------------------------------------------------------- numbers ---
    # Park each sequence past what the import used, so the first number the app
    # issues cannot collide with an imported one.
    out.write("-- number sequences\n")
    for kind, prefix, nxt in (("customer", "CUST", len(customers) + 1),
                              ("supplier", "SUP", len(suppliers) + 1),
                              ("agreement", "SA", 1), ("job", "JOB", 1),
                              ("invoice", "INV", 1), ("credit_note", "CN", 1),
                              ("batch", "BATCH", 1), ("purchase_order", "PO", 1)):
        out.write(
            "insert into public.number_sequences (tenant_id, kind, prefix, next_value) "
            f"values ({q(tenant)}, {q(kind)}, {q(prefix)}, {q(nxt)}) "
            "on conflict (tenant_id, kind) do update set next_value = "
            "greatest(public.number_sequences.next_value, excluded.next_value);\n")

    out.finish()

    print(
        f"-- customers {len(customers)} (lapsed {len(lapsed_customers)}), "
        f"suppliers {len(suppliers)} (lapsed {len(lapsed_suppliers)}), "
        f"accounts {len(accounts)}, bills {len(bills)} ({dropped_dues} with an unusable due "
        f"date), orders {len(orders)}, credits {len(credits)}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
