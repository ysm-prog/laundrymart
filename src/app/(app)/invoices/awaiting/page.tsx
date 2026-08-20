import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { money } from "@/lib/format";
import {
  BILLING_METHOD_LABELS, BILLING_STATUS_LABELS, isBillingMethod,
} from "@/lib/domain/billing";
import { loadChargesForJobs } from "@/lib/orders/job-billing";
import { jobChargeSubtotal } from "@/lib/domain/job-pricing";
import { Badge, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { BillingQueue, type QueueRow } from "./billing-queue";

export const dynamic = "force-dynamic";

export const metadata = { title: "Awaiting invoice" };

/**
 * The billing queue: every job whose work is done and whose money is not.
 *
 * Two groups, because they are two different decisions and each has its own
 * bulk action:
 *
 *   **Awaiting review** — the charges need checking. `Select → Approve Selected`.
 *   **Approved**        — the price is frozen. `Select → Generate Selected`.
 *
 * Generating does not send. An invoice raised from here lands as a draft in the
 * register, and the customer hears nothing until somebody sends it — which is a
 * separate screen, a separate action and a separate capability.
 *
 * Gated on `billing.read`, and the tables behind it are gated independently:
 * `job_charge_snapshots` is readable only through `can_read_billing()`, so an
 * operational role reaching this URL sees the auth gate first and would read no
 * money even if they got past it.
 */
export default async function AwaitingInvoicePage() {
  const session = await requireCapability("billing.read");
  const supabase = await createClient();

  const { data: jobs } = await supabase
    .from("laundry_orders")
    .select(
      "id, order_number, customer_id, status, billing_status, completed_at, due_date, " +
      "customers(id, business_name, billing_method, rate_card_agreement_id)",
    )
    // Named rather than left to RLS (§23). Every id on this screen is posted
    // back into a write — pricing, approving, generating — and each of those is
    // filtered to the laundry the person is working in, so a list that spans two
    // (which it does for a platform admin, since `is_member()` is true of every
    // laundry for them) offers ticks that can only fail.
    .eq("tenant_id", session.tenantId)
    .in("billing_status", ["awaiting_review", "approved"])
    .order("completed_at", { ascending: true })
    .limit(500)
    .returns<Array<{
      id: string; order_number: string; customer_id: string; status: string;
      billing_status: string; completed_at: string | null; due_date: string | null;
      customers: {
        id: string; business_name: string; billing_method: string;
        rate_card_agreement_id: string | null;
      } | null;
    }>>();

  const rows = jobs ?? [];
  // One query for every job's charges rather than one per row — the queue is a
  // list of up to 500 and a per-row read would be 500 round trips.
  const chargesByJob = await loadChargesForJobs(supabase, rows.map((row) => row.id));

  const toRow = (row: (typeof rows)[number]): QueueRow => {
    const method = row.customers?.billing_method ?? "";
    const charges = chargesByJob.get(row.id) ?? [];
    return {
      id: row.id,
      orderNumber: row.order_number,
      customerId: row.customer_id,
      customerName: row.customers?.business_name ?? "Unknown customer",
      billingMethod: isBillingMethod(method) ? BILLING_METHOD_LABELS[method] : "—",
      completedAt: row.completed_at,
      chargeCount: charges.length,
      subtotal: jobChargeSubtotal(charges),
      hasRateCard: Boolean(row.customers?.rate_card_agreement_id),
    };
  };

  const awaiting = rows.filter((row) => row.billing_status === "awaiting_review").map(toRow);
  const approved = rows.filter((row) => row.billing_status === "approved").map(toRow);

  const approvedValue = approved.reduce((sum, row) => sum + row.subtotal, 0);
  const unpriced = awaiting.filter((row) => row.chargeCount === 0).length;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Billing"
        title="Awaiting invoice"
        description="Work that is finished and not yet billed. Completing a job never raises an invoice on its own."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Awaiting review" value={String(awaiting.length)}
              hint={unpriced > 0 ? `${unpriced} not priced yet` : "All priced"} />
        <Stat label="Approved" value={String(approved.length)} hint="Ready to invoice" />
        <Stat label="Approved value" value={money(approvedValue)} hint="Before GST" />
      </div>

      <Card
        title="Awaiting review"
        description="Price the jobs that need it, check the charges, then approve them. Approving freezes the price."
      >
        {awaiting.length === 0 ? (
          <EmptyState
            title="Nothing waiting on a review"
            description="Completed jobs land here for their charges to be priced and checked."
          />
        ) : (
          <BillingQueue
            rows={awaiting}
            mode="approve"
            canAct={can(session.role, "invoices.approve") && can(session.role, "invoices.bulk")}
            canPrice={can(session.role, "billing.write") && can(session.role, "invoices.bulk")}
          />
        )}
      </Card>

      <Card
        title="Approved — ready to invoice"
        description="Generating creates draft invoices. Nothing is sent to a customer until you send it."
      >
        {approved.length === 0 ? (
          <EmptyState
            title="Nothing approved yet"
            description="Approve a job above and it appears here, ready to become an invoice."
            action={<Link href="/invoices" className="text-sm text-primary hover:underline">Open the invoice register</Link>}
          />
        ) : (
          <BillingQueue
            rows={approved}
            mode="generate"
            canAct={can(session.role, "invoices.write") && can(session.role, "invoices.bulk")}
          />
        )}
      </Card>

      <p className="text-sm text-muted-foreground">
        A customer&rsquo;s billing method decides the shape of what is generated:{" "}
        <Badge tone="neutral">{BILLING_STATUS_LABELS.approved}</Badge> jobs for a per-job customer
        each become their own invoice, and a consolidated customer&rsquo;s jobs are rolled onto one.
        Set it on the customer&rsquo;s Billing &amp; pricing section.
      </p>
    </div>
  );
}
