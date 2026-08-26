import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { GST_RATE_FALLBACK, tenantGstRate } from "@/lib/gst";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { counted, date, money, today } from "@/lib/format";
import { CHARGE_TYPE_LABELS, type ChargeType } from "@/lib/domain/pricing";
import { formatIso } from "@/lib/domain/dates";
import { uncodedLineCount } from "@/lib/domain/accounts";
import { loadInvoiceBreakdown } from "@/lib/invoices/breakdown";
import { describePeriod } from "@/lib/domain/billing-period";
import { loadInvoiceSourceJobs } from "@/lib/invoices/open-draft";
import { BILLING_STATUS_LABELS, isBillingStatus } from "@/lib/domain/billing";
import type { Invoice, InvoiceLine, Payment } from "@/lib/db/types";
import {
  Button, ButtonLink, Card, DataTable, EmptyState, Notice,
  PageHeader, SkeletonRows, Stat, StatusBadge, humanise,
} from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { InvoiceLineForm, type LineFormAccount, type LineFormItem } from "./line-form";
import { LineCode, LineCoding } from "./line-coding";
import { PrintButton } from "@/components/print-button";
import { emailIsConfigured } from "@/lib/email/send";
import {
  addInvoiceLine, createCreditNote, emailInvoice, issueInvoice, recordPayment,
  removeInvoiceLine, removeJobFromInvoice, setInvoiceLineAccount, voidInvoice,
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

  // The running draft, told apart from every other draft the same way
  // `uq_invoices_open_draft` tells them apart: a consolidated draft carrying a
  // period is the one approvals are still joining.
  const collecting = invoice.status === "draft"
    && invoice.invoice_type === "consolidated"
    && Boolean(invoice.period_start && invoice.period_end);
  const period = invoice.period_start && invoice.period_end
    ? describePeriod({ start: invoice.period_start, end: invoice.period_end })
    : null;

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

      {/* A running draft says so, because the number on screen is not final and
          the reader has no other way to tell: it looks exactly like an invoice
          that is finished and waiting to be issued. */}
      {collecting ? (
        <Notice tone="info" title="Still collecting">
          Every job {invoice.customers?.business_name ?? "this customer"} has approved
          {period ? ` for ${period}` : ""} is being added to this invoice. Issue it whenever you
          are ready — you do not have to wait for the end of the period, and the invoice will be
          dated the day you issue it.
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Subtotal" value={money(invoice.subtotal)} />
        <Stat label="GST" value={money(invoice.tax_amount)} />
        <Stat label="Total" value={money(invoice.total)} />
        <Stat label="Balance" value={money(invoice.balance)}
              tone={Number(invoice.balance) > 0 ? "warning" : "success"} />
      </div>

      {/* **Two columns from `xl`, not one long scroll (§10b).** An invoice is
          read as "what is on it" beside "what do I do with it", and stacking the
          lines, the breakdown, the payments, the credit notes and five action
          cards into a single column made a page nobody reaches the bottom of.
          Below `xl` it stacks in exactly the order it did before. */}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Suspense fallback={<SkeletonRows rows={5} />}>
            <Lines invoiceId={id} editable={editable} tenantId={session.tenantId} />
            <ServiceBreakdown invoiceId={id} tenantId={session.tenantId} />
          </Suspense>

          <Suspense fallback={<SkeletonRows rows={3} />}>
            <Payments invoice={invoice} writable={writable} />
          </Suspense>

          <Suspense fallback={null}>
            <CreditNotes invoiceId={id} />
          </Suspense>
        </div>

        <div className="space-y-6">
          <Card title="Details">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-1">
              <Meta label="Bill to" value={invoice.customers?.business_name ?? "—"} />
              <Meta label="ABN" value={invoice.customers?.abn ?? "—"} />
              <Meta label="Issued" value={date(invoice.issue_date)} />
              <Meta label="Due" value={date(invoice.due_date)} />
              <Meta label="Period" value={period
                ?? (invoice.period_start
                  ? `${date(invoice.period_start)} – ${date(invoice.period_end)}` : "—")} />
              <Meta label="PO number" value={invoice.purchase_order_number ?? "—"} />
              <Meta label="Terms" value={`${invoice.payment_terms_days} days`} />
              <Meta label="Email" value={invoice.customers?.billing_email ?? "—"} />
            </dl>
          </Card>

          <Suspense fallback={null}>
            <SourceJobs invoiceId={id} tenantId={session.tenantId} editable={editable} />
          </Suspense>

          {writable ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 print:hidden">
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
        </div>
      </div>
    </div>
  );
}

/**
 * The jobs this invoice bills, and the way to take one back off.
 *
 * **The reverse gear a running draft needs.** Voiding is the other way back and
 * it releases *every* job on the invoice — which is fine for a per-job invoice
 * and quite wrong for a draft carrying eleven good jobs and one that should not
 * be there. Removing one puts it back in the billing queue with its charges
 * still frozen, and rebuilds the invoice's lines without it.
 *
 * Shown on every invoice, not just a draft: "which work is this?" is the first
 * question asked of an issued invoice too. The controls are what disappear.
 */
async function SourceJobs({
  invoiceId, tenantId, editable,
}: {
  invoiceId: string; tenantId: string; editable: boolean;
}) {
  const supabase = await createClient();
  const jobs = await loadInvoiceSourceJobs(supabase, tenantId, invoiceId);
  if (jobs.length === 0) return null;

  return (
    <Card title="Jobs on this invoice"
          description={counted(jobs.length, "job")}>
      <ul className="divide-y">
        {jobs.map((job) => (
          <li key={job.orderId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
            <div className="min-w-0 flex-1">
              <ButtonLink href={`/orders/${job.orderId}`} variant="ghost" size="sm">
                {job.orderNumber}
              </ButtonLink>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {job.completedAt ? formatIso(job.completedAt.slice(0, 10)) : "No completion date"}
                {" · "}
                {isBillingStatus(job.billingStatus)
                  ? BILLING_STATUS_LABELS[job.billingStatus]
                  : job.billingStatus}
              </p>
            </div>
            <span className="text-sm font-semibold tabular-nums">{money(job.total)}</span>
            {editable ? (
              <form action={removeJobFromInvoice} className="print:hidden">
                <input type="hidden" name="invoice_id" value={invoiceId} />
                <input type="hidden" name="order_id" value={job.orderId} />
                <input type="hidden" name="return_to" value={`/invoices/${invoiceId}`} />
                <SubmitButton variant="dangerGhost" size="md" pendingLabel="Removing…">
                  Remove
                </SubmitButton>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
          Removing a job puts it back in the billing queue with its charges still frozen. The
          lines above are rebuilt without it.
        </p>
      ) : null}
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/**
 * The per-job detail behind a consolidated invoice.
 *
 * The lines above say what the customer owes; this says what was actually
 * processed and when. Both are read from the same frozen charges, so they cannot
 * disagree — and a per-job invoice renders nothing here, because the lines
 * already are the detail.
 */
async function ServiceBreakdown({ invoiceId, tenantId }: { invoiceId: string; tenantId: string }) {
  const supabase = await createClient();
  const breakdown = await loadInvoiceBreakdown(supabase, tenantId, invoiceId);
  if (breakdown.jobCount < 2) return null;

  return (
    <Card
      title="Service breakdown"
      description={`What was processed on this invoice — ${breakdown.jobCount} jobs, week by week.`}
    >
      <div className="space-y-4">
        {breakdown.weeks.map((week) => (
          <div key={week.weekStart ?? "undated"} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-4 border-b border-border pb-1.5">
              <h3 className="text-sm font-semibold">
                {week.weekStart ? `Week of ${formatIso(week.weekStart)}` : "No completion date"}
              </h3>
              <span className="text-sm tabular-nums text-muted-foreground">{money(week.total)}</span>
            </div>
            {week.jobs.map((job) => (
              <div key={job.jobId} className="pl-1 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-muted-foreground">
                    {job.date ? formatIso(job.date) : "—"} · {job.orderNumber}
                  </span>
                  <span className="tabular-nums">{money(job.total)}</span>
                </div>
                <ul className="pl-4 text-muted-foreground">
                  {job.items.map((item, index) => (
                    <li key={`${job.jobId}-${index}`} className="flex justify-between gap-4">
                      <span>{item.description}</span>
                      <span className="tabular-nums">{item.quantity.toLocaleString("en-AU")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}

        {breakdown.totals.length > 0 ? (
          <div className="space-y-1.5 rounded-lg border border-border bg-surface-muted p-3">
            <h3 className="text-sm font-semibold">Total for the period</h3>
            <ul className="text-sm">
              {breakdown.totals.map((total) => (
                <li key={total.key} className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{total.description}</span>
                  <span className="tabular-nums">{total.quantity.toLocaleString("en-AU")}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

async function Lines({
  invoiceId, editable, tenantId,
}: {
  invoiceId: string;
  editable: boolean;
  /**
   * §23, and it decides money twice over: the GST rate below is read for this
   * laundry, and both pickers offer ids that are posted straight back onto a
   * line. A platform admin reads every laundry, so neither may be left to RLS.
   */
  tenantId: string;
}) {
  const supabase = await createClient();

  /*
   * Four reads, and three of them only when the composer is going to be drawn.
   * A sent invoice is a record, not a form: loading the item list, the whole
   * chart of accounts and the GST rate to render a read-only table would be a
   * few hundred rows fetched for nothing on every view of every historical
   * invoice.
   */
  const [{ data }, catalogue, chart, gstRate] = await Promise.all([
    supabase
      .from("invoice_lines")
      .select("id, invoice_id, description, charge_type, quantity, unit_price, amount, taxable, "
              + "sequence, gl_account_id, account_code")
      .eq("invoice_id", invoiceId).order("sequence")
      .returns<InvoiceLine[]>(),
    editable ? loadItemCatalogue(tenantId) : Promise.resolve([]),
    editable ? loadChartOfAccounts(tenantId) : Promise.resolve([]),
    editable ? tenantGstRate(supabase, tenantId) : Promise.resolve(GST_RATE_FALLBACK),
  ]);

  const lines = data ?? [];
  const uncoded = uncodedLineCount(lines);

  return (
    <Card title="Lines">
      <DataTable
        rows={lines}
        empty={<EmptyState title="No lines on this invoice yet" />}
        columns={[
          { header: "Description", cell: (row) => row.description },
          {
            // The code is what the bookkeeper reads first, so it is a column of
            // its own rather than a suffix on the description. An em dash rather
            // than a blank: "not coded" is an answer, and an empty cell reads as
            // a rendering fault.
            header: "Code",
            cell: (row) => (editable ? (
              <LineCoding
                lineId={row.id} invoiceId={invoiceId} accounts={chart}
                accountId={row.gl_account_id} code={row.account_code}
                description={row.description} action={setInvoiceLineAccount}
              />
            ) : (
              <LineCode accountId={row.gl_account_id} code={row.account_code} />
            )),
            hideBelow: "sm",
          },
          {
            header: "Charge",
            cell: (row) => CHARGE_TYPE_LABELS[row.charge_type as ChargeType] ?? humanise(row.charge_type),
            hideBelow: "lg",
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
                <Button variant="dangerGhost">Remove</Button>
              </form>
            ) : null),
          },
        ]}
      />

      {/*
        Counted and named, never refused. A line with no code is a legitimate
        thing to write — it is the free-text line the client asked for — so the
        app's job is to make the gap visible before the invoice is issued, not to
        block the work. Shown on a sent invoice too: that is when somebody is
        reconciling it and most wants to know.
      */}
      {uncoded > 0 ? (
        <div className="mt-4">
          <Notice tone="info" title={`${counted(uncoded, "line")} not coded to an account`}>
            {editable
              ? "They will reach your books with no account on them. Press the code on a line to "
                + "give it one — or set a default for that kind of charge, and every line like it "
                + "is coded from now on."
              : "They reached your books with no account on them."}
          </Notice>
        </div>
      ) : null}

      {editable ? (
        <InvoiceLineForm invoiceId={invoiceId} items={catalogue} accounts={chart}
                         gstRate={gstRate} action={addInvoiceLine} />
      ) : null}
    </Card>
  );
}

/**
 * The item list the composer searches.
 *
 * Capped, and `sell_price` descending is deliberately *not* the order — items are
 * found by code, so the cap has to bite in code order or the list a search runs
 * over is an arbitrary slice. Inactive items are left out: an invoice is written
 * today, and offering something the laundry has retired is offering a mistake.
 */
async function loadItemCatalogue(tenantId: string): Promise<LineFormItem[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("items")
    .select("id, item_code, name, description, laundry_category, sell_price, tax_code, "
            // 0043's two selling facts, read here for the first time: the unit the
            // rate is per, and whether that rate already contains GST. Both are
            // labels on the composed line — see `line-form.tsx`.
            + "selling_unit, sell_price_basis, income_account_id")
    // §23, as for the chart below: the item picked here carries an account id
    // onto the line, so the read that offers it names its tenant.
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .eq("status", "active")
    // An item the laundry only *buys* is not something a customer is charged
    // for. Inert on the MYOB import — that export carries no sell/buy flag, so
    // every imported row is both (see `myob/inventory.ts`) — but it is the lever
    // an owner has: untick "I sell this" on the drums of detergent and the fan
    // shafts and they stop being offered here, without deleting stock records
    // the plant still needs.
    .eq("is_sell", true)
    .order("item_code", { nullsFirst: false })
    .limit(500)
    .returns<LineFormItem[]>();
  return data ?? [];
}

/**
 * The chart of accounts.
 *
 * Unpaginated for the same reason `/accounts` reads it that way: it is a few
 * hundred rows of reference data that a person scans and a type-ahead ranks, and
 * paging it would mean the search only ever saw the first page.
 *
 * **Returns nothing rather than throwing when the caller cannot read it.** Since
 * 0036 the chart is gated on `purchases.read`, and while everyone holding
 * `invoices.write` also holds that today, a role split tomorrow must degrade to
 * "no codes offered" rather than to a 500 on the invoice screen.
 */
async function loadChartOfAccounts(tenantId: string): Promise<LineFormAccount[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("gl_accounts")
    .select("id, code, name, account_type, tax_code, is_header")
    // §23's standing rule for a read that feeds a write: the id picked here is
    // posted straight back onto an invoice line. `is_member()` is true of every
    // laundry for a platform admin, so an unfiltered read would offer one
    // business's chart while the write is scoped to another's.
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .eq("is_header", false)
    .order("code")
    .limit(1000)
    .returns<LineFormAccount[]>();
  return data ?? [];
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
