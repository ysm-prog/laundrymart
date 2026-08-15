import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, money } from "@/lib/format";
import { Card, DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { Checkbox, SubmitButton } from "@/components/form";
import { approveCompletedJob, generateJobInvoice } from "@/lib/billing/job-billing";

export const metadata = { title: "Awaiting Invoice" };
export const dynamic = "force-dynamic";

type JobRow = {
  id: string;
  order_number: string;
  completed_at: string | null;
  billing_status: string;
  customers: { business_name: string } | null;
};

type ChargeRow = { job_id: string; amount: number };

export default async function AwaitingInvoicePage() {
  const session = await requireCapability("invoices.read");
  const financial = can(session.role, "invoices.read");
  const writable = can(session.role, "invoices.write");

  const supabase = await createClient();
  const { data } = await supabase.from("laundry_orders")
    .select("id, order_number, completed_at, billing_status, customers(business_name)")
    .eq("status", "completed")
    .in("billing_status", ["awaiting_review", "approved", "invoice_generated"])
    .order("completed_at", { ascending: true })
    .returns<JobRow[]>();
  const rows = data ?? [];

  const charges = rows.length
    ? (await supabase.from("job_charge_snapshots").select("job_id, amount").in("job_id", rows.map((row) => row.id)).returns<ChargeRow[]>()).data ?? []
    : [];
  const amountByJob = new Map<string, number>();
  for (const charge of charges) amountByJob.set(charge.job_id, (amountByJob.get(charge.job_id) ?? 0) + Number(charge.amount ?? 0));

  return (
    <div className="space-y-4">
      <PageHeader title="Awaiting Invoice" description="Jobs that finished operationally and are waiting for financial processing." />
      {rows.length === 0 ? (
        <Card title="Completed jobs">
          <EmptyState title="Nothing awaiting invoice" description="Completed jobs will appear here after delivery or collection." />
        </Card>
      ) : (
        <Card title="Completed jobs" description={`${rows.length} job(s)`}>
          <DataTable
            rows={rows}
            columns={[
              {
                header: "Select",
                cell: (row) => financial ? <Checkbox name="job" value={row.id} aria-label={`Select ${row.order_number}`} /> : null,
              },
              { header: "Job", cell: (row) => row.order_number },
              { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
              { header: "Completed", cell: (row) => row.completed_at ? date(row.completed_at.slice(0, 10)) : "—" },
              { header: "Amount", cell: (row) => financial && amountByJob.has(row.id) ? money(amountByJob.get(row.id) ?? 0) : "—" },
              { header: "Status", cell: (row) => <StatusBadge status={row.billing_status} /> },
              {
                header: "Action",
                cell: (row) => writable ? (
                  <div className="flex flex-wrap gap-2">
                    {row.billing_status === "awaiting_review" ? (
                      <form action={approveCompletedJob}>
                        <input type="hidden" name="job_id" value={row.id} />
                        <SubmitButton variant="secondary">Approve</SubmitButton>
                      </form>
                    ) : null}
                    {row.billing_status === "approved" ? (
                      <form action={generateJobInvoice}>
                        <input type="hidden" name="job_id" value={row.id} />
                        <SubmitButton>Generate Invoice</SubmitButton>
                      </form>
                    ) : null}
                    {row.billing_status === "invoice_generated" ? <span className="text-xs text-muted-foreground">Invoice generated</span> : null}
                  </div>
                ) : null,
              },
            ]}
          />
        </Card>
      )}
      <Card title="Billing flow" description="Generate and send are separate actions. Consolidated billing can use the same invoice source relationship later without changing completed-job workflow." />
    </div>
  );
}
