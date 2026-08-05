import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, money, today } from "@/lib/format";
import { CHARGE_TYPE_LABELS, type ChargeType } from "@/lib/domain/pricing";
import type { Invoice, InvoiceLine, Payment } from "@/lib/db/types";
import {
  Button, ButtonLink, Card, DataTable, EmptyState, Notice,
  PageHeader, SkeletonRows, Stat, StatusBadge, humanise,
} from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Checkbox, Field, Input, Select, SubmitButton } from "@/components/form";
import { PrintButton } from "@/components/print-button";
import { emailIsConfigured } from "@/lib/email/send";
import {
  addInvoiceLine, createCreditNote, emailInvoice, issueInvoice, recordPayment,
  removeInvoiceLine, voidInvoice,
} from "../actions";

export const dynamic = "force-dynamic";

type InvoiceDetail = Invoice & {
  void_reason: string | null;
  customers: {
    business_name: string; customer_number: string; abn: string | null;
    billing_address_line1: string | null; billing_suburb: string | null;
    billing_state: string | null; billing_postcode: string | null; billing_email: string | null;
  } | null;
};

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireCapability("invoices.read");
  const writable = can(session.role, "invoices.write");

  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, invoice_number, customer_id, invoice_type, status, issue_date, due_date, " +
            "period_start, period_end, purchase_order_number, payment_terms_days, subtotal, " +
            "tax_amount, total, amount_paid, balance, notes, void_reason, emailed_at, emailed_to, " +
            "customers(business_name, customer_number, abn, billing_address_line1, billing_suburb, " +
            "billing_state, billing_postcode, billing_email)")
    .eq("id", id)
    .maybeSingle<InvoiceDetail>();

  if (!invoice) notFound();

  const editable = writable && invoice.status === "draft";
  const emailConfigured = emailIsConfigured();

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Tax invoice ${invoice.invoice_number}`}
        description={`${invoice.customers?.business_name ?? "Unknown customer"} · ${humanise(invoice.invoice_type)}`}
        actions={
          <>
            <StatusBadge status={invoice.status} />
            {/* A route handler, not a page — plain anchor so the browser
                downloads it rather than client-navigating to a PDF. */}
            <a href={`/api/invoices/${id}/pdf`} target="_blank" rel="noreferrer"
               className="inline-flex items-center justify-center rounded-md border px-3 py-2
                          text-sm font-medium transition hover:bg-surface-muted print:hidden">
              Download PDF
            </a>
            <PrintButton label="Print" />
            <ButtonLink href="/invoices">All invoices</ButtonLink>
          </>
        }
      />

      {invoice.status === "void" ? (
        <Notice tone="danger" title="This invoice is void">
          {invoice.void_reason ?? "No reason recorded."}
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Subtotal" value={money(invoice.subtotal)} />
        <Stat label="GST" value={money(invoice.tax_amount)} />
        <Stat label="Total" value={money(invoice.total)} />
        <Stat label="Balance" value={money(invoice.balance)}
              tone={Number(invoice.balance) > 0 ? "warning" : "success"} />
      </div>

      <Card title="Details">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Meta label="Bill to" value={invoice.customers?.business_name ?? "—"} />
          <Meta label="ABN" value={invoice.customers?.abn ?? "—"} />
          <Meta label="Issued" value={date(invoice.issue_date)} />
          <Meta label="Due" value={date(invoice.due_date)} />
          <Meta label="Period" value={invoice.period_start
            ? `${date(invoice.period_start)} – ${date(invoice.period_end)}` : "—"} />
          <Meta label="PO number" value={invoice.purchase_order_number ?? "—"} />
          <Meta label="Terms" value={`${invoice.payment_terms_days} days`} />
          <Meta label="Email" value={invoice.customers?.billing_email ?? "—"} />
        </dl>
      </Card>

      <Suspense fallback={<SkeletonRows rows={5} />}>
        <Lines invoiceId={id} editable={editable} />
      </Suspense>

      <Suspense fallback={<SkeletonRows rows={3} />}>
        <Payments invoice={invoice} writable={writable} />
      </Suspense>

      {writable ? (
        <div className="grid gap-4 lg:grid-cols-2 print:hidden">
          <Card
            title="Send to customer"
            description={invoice.emailed_at
              ? `Last sent ${date(invoice.emailed_at)} to ${invoice.emailed_to ?? "the customer"}.`
              : "Emails the PDF as an attachment."}
          >
            {invoice.status === "draft" ? (
              <Notice tone="info">Issue the invoice before sending — a draft can still change.</Notice>
            ) : invoice.status === "void" ? (
              <Notice tone="warning">A void invoice cannot be sent.</Notice>
            ) : !emailConfigured ? (
              <Notice tone="warning" title="No email provider configured">
                Set <code>RESEND_API_KEY</code> and <code>INVOICE_FROM_EMAIL</code> to send from
                the app. The PDF can still be downloaded and attached by hand.
              </Notice>
            ) : (
              <form action={emailInvoice} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="id" value={id} />
                <Field label="Send to" name="to"
                       hint={invoice.customers?.billing_email
                         ? "Leave blank to use the customer's billing email."
                         : "This customer has no billing email on file."}>
                  <Input name="to" type="email"
                         placeholder={invoice.customers?.billing_email ?? "accounts@customer.com.au"} />
                </Field>
                <SubmitButton>Email invoice</SubmitButton>
              </form>
            )}
          </Card>

          <Card title="Issue and void">
            <div className="flex flex-wrap gap-2">
              {invoice.status === "draft" ? (
                <form action={issueInvoice}>
                  <input type="hidden" name="id" value={id} />
                  <Button variant="primary">Issue invoice</Button>
                </form>
              ) : null}
            </div>
            {invoice.status !== "void" ? (
              <form action={voidInvoice} className="mt-4 border-t pt-4">
                <input type="hidden" name="id" value={id} />
                <ConfirmSubmit
                  label="Void invoice"
                  consequence={`Voiding cancels ${invoice.invoice_number} permanently. The number is kept for the audit trail and a replacement gets a new one.`}
                  reasonName="void_reason"
                  reasonLabel="Why is it being voided?"
                  pendingLabel="Voiding…"
                />
              </form>
            ) : null}
          </Card>

          <Card title="Credit note" description="Always references this invoice.">
            <form action={createCreditNote} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="invoice_id" value={id} />
              <input type="hidden" name="customer_id" value={invoice.customer_id} />
              <Field label="Amount (ex GST)" name="amount" required>
                <Input name="amount" type="number" step="0.01" min={0} required />
              </Field>
              <Field label="Reason" name="reason" required>
                <Input name="reason" required placeholder="Short delivery on 12 March" />
              </Field>
              <div className="sm:col-span-2">
                <SubmitButton variant="secondary">Issue credit note</SubmitButton>
              </div>
            </form>
          </Card>
        </div>
      ) : null}

      <Suspense fallback={null}>
        <CreditNotes invoiceId={id} />
      </Suspense>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

async function Lines({ invoiceId, editable }: { invoiceId: string; editable: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("invoice_lines")
    .select("id, invoice_id, description, charge_type, quantity, unit_price, amount, taxable, sequence")
    .eq("invoice_id", invoiceId).order("sequence")
    .returns<InvoiceLine[]>();

  return (
    <Card title="Lines">
      <DataTable
        rows={data ?? []}
        empty={<EmptyState title="No lines on this invoice yet" />}
        columns={[
          { header: "Description", cell: (row) => row.description },
          {
            header: "Charge",
            cell: (row) => CHARGE_TYPE_LABELS[row.charge_type as ChargeType] ?? humanise(row.charge_type),
            hideBelow: "md",
          },
          { header: "Qty", cell: (row) => row.quantity, align: "right", hideBelow: "sm" },
          { header: "Unit", cell: (row) => money(row.unit_price), align: "right", hideBelow: "sm" },
          { header: "Amount", cell: (row) => money(row.amount), align: "right" },
          { header: "GST", cell: (row) => (row.taxable ? "Yes" : "No"), hideBelow: "lg" },
          {
            header: "",
            align: "right",
            cell: (row) => (editable ? (
              <form action={removeInvoiceLine}>
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="invoice_id" value={invoiceId} />
                <button type="submit" className="text-xs text-danger hover:underline">Remove</button>
              </form>
            ) : null),
          },
        ]}
      />

      {editable ? (
        <form action={addInvoiceLine} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-5 print:hidden">
          <input type="hidden" name="invoice_id" value={invoiceId} />
          <Field label="Description" name="description" required className="lg:col-span-2">
            <Input name="description" required />
          </Field>
          <Field label="Charge type" name="charge_type">
            <Select name="charge_type" defaultValue="other"
                    options={Object.entries(CHARGE_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
          </Field>
          <Field label="Quantity" name="quantity">
            <Input name="quantity" type="number" step="0.01" min={0} defaultValue="1" />
          </Field>
          <Field label="Unit price" name="unit_price">
            <Input name="unit_price" type="number" step="0.01" min={0} defaultValue="0" />
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox name="taxable" label="GST applies" defaultChecked />
          </div>
          <div className="flex items-end">
            <SubmitButton variant="secondary">Add line</SubmitButton>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

async function Payments({ invoice, writable }: { invoice: InvoiceDetail; writable: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("payments")
    .select("id, invoice_id, customer_id, paid_on, amount, method, reference")
    .eq("invoice_id", invoice.id).order("paid_on", { ascending: false })
    .returns<Payment[]>();

  return (
    <Card title="Payments">
      <DataTable
        rows={data ?? []}
        empty={<EmptyState title="No payments recorded" />}
        columns={[
          { header: "Date", cell: (row) => date(row.paid_on) },
          { header: "Amount", cell: (row) => money(row.amount), align: "right" },
          { header: "Method", cell: (row) => humanise(row.method), hideBelow: "sm" },
          { header: "Reference", cell: (row) => row.reference ?? "—", hideBelow: "md" },
        ]}
      />

      {writable && invoice.status !== "void" ? (
        <form action={recordPayment} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-5 print:hidden">
          <input type="hidden" name="invoice_id" value={invoice.id} />
          <input type="hidden" name="customer_id" value={invoice.customer_id} />
          <Field label="Paid on" name="paid_on" required>
            <Input name="paid_on" type="date" required defaultValue={today()} />
          </Field>
          <Field label="Amount" name="amount" required>
            <Input name="amount" type="number" step="0.01" min={0} required
                   defaultValue={Number(invoice.balance) > 0 ? String(invoice.balance) : undefined} />
          </Field>
          <Field label="Method" name="method">
            <Select name="method" defaultValue="bank_transfer" options={[
              { value: "bank_transfer", label: "Bank transfer" },
              { value: "credit_card", label: "Credit card" },
              { value: "direct_debit", label: "Direct debit" },
              { value: "cash", label: "Cash" },
              { value: "cheque", label: "Cheque" },
              { value: "other", label: "Other" },
            ]} />
          </Field>
          <Field label="Reference" name="reference">
            <Input name="reference" />
          </Field>
          <div className="flex items-end">
            <SubmitButton>Record payment</SubmitButton>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

async function CreditNotes({ invoiceId }: { invoiceId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("credit_notes")
    .select("id, credit_note_number, status, issue_date, reason, total")
    .eq("invoice_id", invoiceId).order("issue_date", { ascending: false })
    .returns<Array<{ id: string; credit_note_number: string; status: string; issue_date: string; reason: string | null; total: number }>>();

  if (!data?.length) return null;

  return (
    <Card title="Credit notes">
      <DataTable
        rows={data}
        empty={<EmptyState title="No credit notes" />}
        columns={[
          { header: "Credit note", cell: (row) => row.credit_note_number },
          { header: "Issued", cell: (row) => date(row.issue_date) },
          { header: "Reason", cell: (row) => row.reason ?? "—", hideBelow: "sm" },
          { header: "Total", cell: (row) => money(row.total), align: "right" },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
    </Card>
  );
}
