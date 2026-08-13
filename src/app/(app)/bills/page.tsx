import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { date, money, today } from "@/lib/format";
import type { SupplierBill, SupplierPayment } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, PageHeader, SkeletonRows, SkeletonStats, Stat, StatusBadge,
} from "@/components/ui";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";

export const metadata = { title: "Bills" };
export const dynamic = "force-dynamic";

type Search = { q?: string; status?: string; outstanding?: string; page?: string };

export default async function BillsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  await requireCapability("purchases.read");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bills" eyebrow="Money out"
        description="What your suppliers have invoiced you, what is still owed, and what is already past due."
      />

      <Suspense fallback={<SkeletonStats />}>
        <Owed />
      </Suspense>

      <ListControls
        action="/bills"
        q={params.q}
        filters={[
          {
            name: "outstanding", label: "Show", value: params.outstanding,
            options: [
              { value: "unpaid", label: "Still owed" },
              { value: "overdue", label: "Past due" },
            ],
          },
          {
            name: "status", label: "Status", value: params.status,
            options: [
              { value: "open", label: "Open" },
              { value: "closed", label: "Closed" },
              { value: "debit", label: "Debit note" },
            ],
          },
        ]}
      />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={8} />}>
        <BillList params={params} />
      </Suspense>

      <Suspense fallback={<SkeletonRows rows={4} />}>
        <RecentPayments />
      </Suspense>
    </div>
  );
}

/**
 * What has actually gone out, newest first.
 *
 * Deliberately not shown as an allocation against particular bills: the
 * remittance advices these come from name a supplier, a date and an amount, and
 * nothing about which bills were settled. Presenting them beside the bills as a
 * separate list says exactly what is known — money left, to whom, on what day —
 * without implying a reconciliation nobody performed.
 */
async function RecentPayments() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("supplier_payments")
    .select("id, supplier_id, reference, paid_on, amount, remittance_email, suppliers(name)")
    .is("deleted_at", null)
    .order("paid_on", { ascending: false })
    .limit(12)
    .returns<SupplierPayment[]>();

  const rows = data ?? [];
  if (rows.length === 0) return null;

  return (
    <Card
      title="Recent payments"
      description="Money already sent, from the remittance advices. Not matched to individual bills — the advice does not say which."
    >
      <DataTable
        rows={rows}
        label="Recent supplier payments"
        empty={<EmptyState title="No payments recorded" description="" />}
        columns={[
          { header: "Supplier", cell: (row) => row.suppliers?.name ?? "—" },
          { header: "Paid", cell: (row) => date(row.paid_on), hideBelow: "sm" },
          {
            header: "Reference",
            cell: (row) => <span className="font-mono">{row.reference}</span>,
            hideBelow: "md",
          },
          { header: "Sent to", cell: (row) => row.remittance_email ?? "—", hideBelow: "lg" },
          { header: "Amount", cell: (row) => money(row.amount), align: "right" },
        ]}
      />
    </Card>
  );
}

/**
 * What is owed right now.
 *
 * Counted on the balance rather than the status, because a bill imported from
 * the previous books keeps whatever status it was closed with there — the
 * balance is the only field that says whether anyone still has to pay it.
 */
async function Owed() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("supplier_bills")
    .select("amount, balance_due, due_date")
    .neq("balance_due", 0)
    .is("deleted_at", null)
    .returns<Array<Pick<SupplierBill, "amount" | "balance_due" | "due_date">>>();

  const rows = data ?? [];
  const now = today();
  // A debit note is money owed back to us. Netting it into "owed" would
  // understate the bill run without ever showing why, so the two are separate.
  const owed = rows.filter((r) => r.balance_due > 0);
  const credits = rows.filter((r) => r.balance_due < 0);
  const overdue = owed.filter((r) => r.due_date && r.due_date < now);
  const total = (list: typeof rows) => list.reduce((sum, r) => sum + Number(r.balance_due), 0);

  return (
    <div className="grid grid-cols-2 divide-x divide-border border border-border lg:grid-cols-4">
      <Stat flush label="Still owed" value={money(total(owed))} hint={`${owed.length} bills`} />
      <Stat
        flush label="Past due" value={money(total(overdue))} hint={`${overdue.length} bills`}
        tone={overdue.length ? "danger" : "default"}
      />
      <Stat
        flush label="Owed back to you" value={money(Math.abs(total(credits)))}
        hint={`${credits.length} debit notes`}
      />
      <Stat flush label="Outstanding documents" value={rows.length} hint="Excludes settled bills" />
    </div>
  );
}

async function BillList({ params }: { params: Search }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);

  let query = supabase
    .from("supplier_bills")
    .select(
      "id, supplier_id, bill_number, supplier_invoice_no, issue_date, due_date, amount, " +
      "balance_due, status, suppliers(name)",
      { count: "exact" },
    )
    .is("deleted_at", null)
    .order("issue_date", { ascending: false })
    .range(from, to);

  if (params.status) query = query.eq("status", params.status);
  if (params.outstanding === "unpaid") query = query.neq("balance_due", 0);
  if (params.outstanding === "overdue") query = query.gt("balance_due", 0).lt("due_date", today());
  if (params.q) {
    const term = `%${params.q}%`;
    query = query.or(`bill_number.ilike.${term},supplier_invoice_no.ilike.${term}`);
  }

  const { data, count, error } = await query.returns<SupplierBill[]>();
  if (error) throw new Error(error.message);

  const filtered = Boolean(params.q || params.status || params.outstanding);
  const now = today();

  return (
    <Card>
      <DataTable
        rows={data ?? []}
        empty={
          <EmptyState
            title={filtered ? "No bills match those filters" : "No bills yet"}
            description={filtered
              ? "Try a broader search."
              : "Supplier bills appear here once they are entered or imported."}
          />
        }
        columns={[
          { header: "Supplier", cell: (row) => row.suppliers?.name ?? "—" },
          { header: "Bill", cell: (row) => <span className="font-mono">{row.bill_number}</span>, hideBelow: "sm" },
          {
            header: "Their invoice no.",
            cell: (row) => <span className="font-mono">{row.supplier_invoice_no ?? "—"}</span>,
            hideBelow: "lg",
          },
          { header: "Issued", cell: (row) => date(row.issue_date), hideBelow: "md" },
          {
            header: "Due",
            cell: (row) => {
              if (!row.due_date) return "—";
              const late = Number(row.balance_due) > 0 && row.due_date < now;
              return (
                <span className={late ? "text-danger" : undefined}>
                  {date(row.due_date)}{late ? " · late" : ""}
                </span>
              );
            },
            hideBelow: "md",
          },
          { header: "Amount", cell: (row) => money(row.amount), align: "right" },
          {
            header: "Owing",
            cell: (row) => (Number(row.balance_due) === 0 ? "—" : money(row.balance_due)),
            align: "right",
          },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/bills" />
    </Card>
  );
}
