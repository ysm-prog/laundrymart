import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, money, relativeDays, today } from "@/lib/format";
import {
  Card, DataTable, EmptyState, FlashMessages, PageHeader, SkeletonRows,
  SkeletonStats, Stat, StatusBadge,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";
import { createManualInvoice, generateInvoices } from "./actions";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

type Search = { q?: string; status?: string; customer?: string; page?: string; error?: string; ok?: string };

type Row = {
  id: string;
  invoice_number: string;
  invoice_type: string;
  status: string;
  issue_date: string;
  due_date: string | null;
  total: number;
  balance: number;
  customers: { business_name: string } | null;
};

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireCapability("invoices.read");
  const writable = can(session.role, "invoices.write");

  return (
    <div className="space-y-6">
      <FlashMessages error={params.error} ok={params.ok} />
      <PageHeader
        title="Invoices"
        description="Recurring invoices come from service agreements and completed work; manual and credit invoices sit alongside them."
      />

      <Suspense fallback={<SkeletonStats count={3} />}>
        <Aging />
      </Suspense>

      <ListControls
        action="/invoices"
        q={params.q}
        filters={[{
          name: "status", label: "Status", value: params.status,
          options: [
            { value: "draft", label: "Draft" },
            { value: "issued", label: "Issued" },
            { value: "part_paid", label: "Part paid" },
            { value: "paid", label: "Paid" },
            { value: "overdue", label: "Overdue" },
            { value: "void", label: "Void" },
          ],
        }]}
      />

      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={8} />}>
        <InvoiceList params={params} />
      </Suspense>

      {writable ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Generate recurring invoices"
                description="Bills every active agreement for the period. Already-billed periods are skipped.">
            <form action={generateInvoices} className="grid gap-3 sm:grid-cols-2">
              <Field label="Period start" name="period_start" required>
                <Input name="period_start" type="date" required defaultValue={`${today().slice(0, 7)}-01`} />
              </Field>
              <Field label="Period end" name="period_end" required>
                <Input name="period_end" type="date" required defaultValue={today()} />
              </Field>
              <div className="sm:col-span-2">
                <SubmitButton pendingLabel="Generating…">Generate</SubmitButton>
              </div>
            </form>
          </Card>

          <Suspense fallback={null}>
            <ManualInvoiceForm />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}

async function Aging() {
  const supabase = await createClient();
  const now = today();
  const { data } = await supabase
    .from("invoices")
    .select("balance, due_date, status")
    .in("status", ["issued", "part_paid", "overdue"])
    .returns<Array<{ balance: number; due_date: string | null; status: string }>>();

  const buckets = { current: 0, "1-30": 0, "31-60": 0, "60+": 0 };
  for (const invoice of data ?? []) {
    const overdueDays = invoice.due_date ? relativeDays(invoice.due_date, now) : 0;
    const amount = Number(invoice.balance ?? 0);
    if (overdueDays <= 0) buckets.current += amount;
    else if (overdueDays <= 30) buckets["1-30"] += amount;
    else if (overdueDays <= 60) buckets["31-60"] += amount;
    else buckets["60+"] += amount;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Current" value={money(buckets.current)} />
      <Stat label="1–30 days" value={money(buckets["1-30"])} tone={buckets["1-30"] > 0 ? "warning" : "default"} />
      <Stat label="31–60 days" value={money(buckets["31-60"])} tone={buckets["31-60"] > 0 ? "warning" : "default"} />
      <Stat label="60+ days" value={money(buckets["60+"])} tone={buckets["60+"] > 0 ? "danger" : "default"} />
    </div>
  );
}

async function InvoiceList({ params }: { params: Search }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);

  let query = supabase
    .from("invoices")
    .select("id, invoice_number, invoice_type, status, issue_date, due_date, total, balance, customers(business_name)",
            { count: "exact" })
    .is("deleted_at", null)
    .order("issue_date", { ascending: false })
    .range(from, to);

  if (params.status) query = query.eq("status", params.status);
  if (params.customer) query = query.eq("customer_id", params.customer);
  if (params.q) query = query.ilike("invoice_number", `%${params.q}%`);

  const { data, count } = await query.returns<Row[]>();

  return (
    <>
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/invoices/${row.id}`}
        empty={<EmptyState title="No invoices yet"
                           description="Generate a period from your active agreements, or raise a manual invoice." />}
        columns={[
          { header: "Invoice", cell: (row) => row.invoice_number },
          { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
          { header: "Issued", cell: (row) => date(row.issue_date), hideBelow: "sm" },
          { header: "Due", cell: (row) => date(row.due_date), hideBelow: "md" },
          { header: "Total", cell: (row) => money(row.total), align: "right" },
          { header: "Balance", cell: (row) => money(row.balance), align: "right", hideBelow: "sm" },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/invoices" />
    </>
  );
}

async function ManualInvoiceForm() {
  const supabase = await createClient();
  const { data: customers } = await supabase
    .from("customers").select("id, business_name, customer_number")
    .is("deleted_at", null).neq("status", "archived").order("business_name");

  return (
    <Card title="Manual invoice" description="For one-off charges outside the agreement.">
      <form action={createManualInvoice} className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer" name="customer_id" required>
          <Select name="customer_id" required placeholder="Choose a customer"
                  options={(customers ?? []).map((customer) => ({
                    value: customer.id,
                    label: `${customer.business_name} (${customer.customer_number})`,
                  }))} />
        </Field>
        <Field label="Issue date" name="issue_date" required>
          <Input name="issue_date" type="date" required defaultValue={today()} />
        </Field>
        <Field label="Payment terms (days)" name="payment_terms_days">
          <Input name="payment_terms_days" type="number" min={0} defaultValue="14" />
        </Field>
        <Field label="PO number" name="purchase_order_number">
          <Input name="purchase_order_number" />
        </Field>
        <div className="sm:col-span-2">
          <SubmitButton>Create draft invoice</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
