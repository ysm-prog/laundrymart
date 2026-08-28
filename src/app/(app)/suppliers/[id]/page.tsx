import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { money, date, counted } from "@/lib/format";
import { formatAbn } from "@/lib/domain/abn";
import type { Supplier } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, PageContainer, PageHeader, StatusBadge,
} from "@/components/ui";
import { SUPPLIER_COLUMNS } from "../columns";

export const dynamic = "force-dynamic";
export const metadata = { title: "Supplier" };

/**
 * One supplier's contact card, and what the laundry has bought from them.
 *
 * Read-only on purpose. Everything on it arrived from the MYOB contact export
 * and MYOB is still where a supplier is maintained, so an edit form here would
 * be a second place to change one fact — the duplication this project argues
 * against everywhere else. What the page exists for is the question the list
 * cannot answer: *who* do we ring, *where* do we send it, and *which account*
 * do their bills post to.
 */
type BillRow = {
  id: string;
  bill_number: string;
  supplier_invoice_no: string | null;
  issue_date: string;
  amount: number;
  balance_due: number;
  status: string;
  gl_accounts: { code: string; name: string } | null;
};

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireCapability("purchases.read");
  const supabase = await createClient();

  // Named rather than left to RLS (§23): a platform admin's session reads every
  // laundry, and this id comes from the address bar.
  const { data: supplier } = await supabase
    .from("suppliers")
    .select(SUPPLIER_COLUMNS)
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle<Supplier>();

  if (!supplier) notFound();

  const [{ data: account }, { data: bills, count }] = await Promise.all([
    supplier.expense_account_id
      ? supabase
          .from("gl_accounts")
          .select("id, code, name")
          .eq("tenant_id", session.tenantId)
          .eq("id", supplier.expense_account_id)
          .maybeSingle<{ id: string; code: string; name: string }>()
      : Promise.resolve({ data: null }),
    supabase
      .from("supplier_bills")
      .select("id, bill_number, supplier_invoice_no, issue_date, amount, balance_due, status, " +
              "gl_accounts(code, name)",
              { count: "exact" })
      .eq("tenant_id", session.tenantId)
      .eq("supplier_id", supplier.id)
      .is("deleted_at", null)
      .order("issue_date", { ascending: false })
      .limit(20)
      .returns<BillRow[]>(),
  ]);

  const address = [
    supplier.address_line1,
    supplier.address_line2,
    [supplier.suburb, supplier.state, supplier.postcode].filter(Boolean).join(" "),
  ].filter((line) => line && line.trim()).join("\n");

  return (
    <PageContainer>
      <PageHeader
        title={supplier.name}
        eyebrow="Money out"
        description={`Supplier ${supplier.supplier_number}`}
        back={{ href: "/suppliers", label: "Suppliers" }}
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="grid gap-4 xl:col-span-2">
          <Card title="Bills" description={counted(count ?? 0, "bill")}>
            <DataTable
              bare
              rows={bills ?? []}
              empty={<EmptyState title="No bills yet" description="Bills from this supplier appear here." />}
              columns={[
                { header: "Bill", cell: (row) => <span className="font-mono">{row.bill_number}</span> },
                {
                  header: "Their invoice",
                  cell: (row) => row.supplier_invoice_no ?? "—",
                  hideBelow: "lg",
                },
                { header: "Issued", cell: (row) => date(row.issue_date), hideBelow: "md" },
                {
                  // The account this bill was actually coded to — not the
                  // supplier's default, which is only what a new bill starts from.
                  header: "Account",
                  cell: (row) => (row.gl_accounts
                    ? <span className="font-mono">{row.gl_accounts.code}</span>
                    : <span className="text-muted-foreground">Not coded</span>),
                  hideBelow: "md",
                },
                { header: "Amount", cell: (row) => money(row.amount), align: "right" },
                {
                  header: "Owing",
                  cell: (row) => (Number(row.balance_due) === 0 ? "—" : money(row.balance_due)),
                  align: "right",
                  hideBelow: "sm",
                },
              ]}
            />
          </Card>
        </div>

        <div className="grid gap-4">
          <Card title="Contact">
            <dl className="grid gap-3 text-sm">
              <Detail label="Status"><StatusBadge status={supplier.status} /></Detail>
              <Detail label="ABN">
                {supplier.abn ? <span className="font-mono">{formatAbn(supplier.abn)}</span> : null}
              </Detail>
              <Detail label="Contact">{supplier.contact_name}</Detail>
              <Detail label="Phone">
                {supplier.phone ? <span className="font-mono">{supplier.phone}</span> : null}
              </Detail>
              <Detail label="Email">
                {supplier.email
                  ? <a className="text-primary underline underline-offset-2" href={`mailto:${supplier.email}`}>
                      {supplier.email}
                    </a>
                  : null}
              </Detail>
              <Detail label="Website">{supplier.website}</Detail>
              <Detail label="Address">
                {address ? <span className="whitespace-pre-line">{address}</span> : null}
              </Detail>
            </dl>
          </Card>

          <Card
            title="Purchases"
            description="Where this supplier's bills post by default."
          >
            <dl className="grid gap-3 text-sm">
              <Detail label="Account">
                {account
                  ? (
                    <Link
                      href={`/accounts/${account.id}`}
                      className="text-primary underline underline-offset-2"
                    >
                      <span className="font-mono">{account.code}</span> — {account.name}
                    </Link>
                  )
                  : null}
              </Detail>
              <Detail label="Opening balance">
                {Number(supplier.opening_balance) === 0 ? null : money(supplier.opening_balance)}
              </Detail>
              <Detail label="Notes">
                {supplier.notes ? <span className="whitespace-pre-line">{supplier.notes}</span> : null}
              </Detail>
            </dl>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}

/**
 * A labelled fact, with an em dash where there is nothing.
 *
 * An empty cell reads as a rendering fault; "—" reads as *we do not hold this*,
 * which is the true and more useful statement for a card most of whose fields
 * MYOB leaves blank.
 */
function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  const empty = children === null || children === undefined || children === "";
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-start gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{empty ? <span className="text-muted-foreground">—</span> : children}</dd>
    </div>
  );
}
