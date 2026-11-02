import { canTakePayment, creditRefusal, voidRefusal } from "@/lib/domain/payment-gate";
import {
  invoiceProfileGaps, issueBlockedReason, issueGaps, parseInvoiceProfile,
} from "@/lib/domain/invoice-profile";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { GST_RATE_FALLBACK, tenantGstRate } from "@/lib/gst";
import { createClient } from "@/lib/supabase/server";
import { attachListPrices } from "@/lib/items/list-prices";
import { can } from "@/lib/roles";
import { counted, date, money, today } from "@/lib/format";
import { CHARGE_TYPE_LABELS, type ChargeType } from "@/lib/domain/pricing";
import { formatIso } from "@/lib/domain/dates";
import { uncodedLineCount } from "@/lib/domain/accounts";
import { loadInvoiceBreakdown } from "@/lib/invoices/breakdown";
import { describePeriod } from "@/lib/domain/billing-period";
import { loadInvoiceSourceJobs } from "@/lib/invoices/open-draft";
import { voidRebillQuestion } from "@/lib/domain/confirmations";
import { jobStatusOnInvoice, issueDateText } from "@/lib/domain/billing";
import type { Invoice, InvoiceLine, Payment } from "@/lib/db/types";
import {
  Button, ButtonLink, Card, DataTable, EmptyState, Notice,
  PageHeader, SkeletonRows, Stat, StatusBadge, humanise,
} from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Checkbox, Field, Input, Select, SubmitButton } from "@/components/form";
import { InvoiceLineForm, type LineFormAccount, type LineFormItem } from "./line-form";
import { IssueControl } from "../issue-control";
import { LineCode, LineCoding } from "./line-coding";
import { PrintButton } from "@/components/print-button";
import { emailIsConfigured } from "@/lib/email/send";
import { smsIsConfigured } from "@/lib/sms/send";
import { loadCustomerMobile } from "@/lib/invoices/send";
import { displayMobile } from "@/lib/domain/sms";
import {
  addInvoiceLine, createCreditNote, emailInvoice, issueInvoice, recordPayment,
  removeInvoiceLine, removeJobFromInvoice, retryXeroPush, reversePayment, setInvoiceLineAccount, voidInvoice,
} from "../actions";

export const dynamic = "force-dynamic";

type InvoiceDetail = Invoice & {
  void_reason: string | null;
  amount_credited: number;
  /** What Xero said when it refused this invoice (0026); null once accepted. */
  xero_push_error: string | null;
  xero_pushed_at: string | null;
  /** `app` or `import` (0055). */
  source: string | null;
  customers: {
    business_name: string; customer_number: string; abn: string | null;
    billing_address_line1: string | null; billing_suburb: string | null;
    billing_state: string | null; billing_postcode: string | null; billing_email: string | null;
  } | null;
};

/** What has already gone to the customer, by each channel it can go by. */
function sentSummary(
  invoice: InvoiceDetail,
  texted: { sms_sent_at: string | null; sms_sent_to: string | null } | null,
): string {
  const sent = [
    invoice.emailed_at
      ? `Last emailed ${date(invoice.emailed_at)} to ${invoice.emailed_to ?? "the customer"}.` : null,
    texted?.sms_sent_at
      ? `Last texted ${date(texted.sms_sent_at)} to ${texted.sms_sent_to ? displayMobile(texted.sms_sent_to) : "the customer"}.` : null,
  ].filter(Boolean);
  return sent.length ? sent.join(" ") : "Emails the PDF as an attachment, or texts a private link to it.";
}

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
            "tax_amount, total, amount_paid, amount_credited, balance, notes, void_reason, emailed_at, emailed_to, " +
            "xero_push_error, xero_pushed_at, source, " +
            "customers(business_name, customer_number, abn, billing_address_line1, billing_suburb, " +
            "billing_state, billing_postcode, billing_email)")
    .eq("id", id)
    .maybeSingle<InvoiceDetail>();

  if (!invoice) notFound();

  const editable = writable && invoice.status === "draft";

  // What stands between this invoice and being voided (0052), and what the
  // tax invoice is missing about the business that issues it.
  const [{ count: paymentCount }, { count: creditNoteCount }, { data: tenantRow }, { data: sourceRows }] = await Promise.all([
    supabase.from("payments").select("id", { count: "exact", head: true })
      .eq("invoice_id", id).eq("tenant_id", session.tenantId),
    supabase.from("credit_notes").select("id", { count: "exact", head: true })
      .eq("invoice_id", id).eq("tenant_id", session.tenantId).in("status", ["issued", "applied"]),
    supabase.from("tenants").select("abn, settings").eq("id", session.tenantId)
      .maybeSingle<{ abn: string | null; settings: unknown }>(),
    // The jobs a void would release — named in its question (brief 1.6).
    supabase.from("invoice_source_jobs").select("order_id")
      .eq("invoice_id", id).eq("tenant_id", session.tenantId)
      .returns<Array<{ order_id: string }>>(),
  ]);
  const sourceIds = (sourceRows ?? []).map((row) => row.order_id);
  const { data: sourceJobs } = sourceIds.length === 0
    ? { data: [] as Array<{ order_number: string }> }
    : await supabase.from("laundry_orders").select("order_number")
        .in("id", sourceIds).eq("tenant_id", session.tenantId).order("order_number")
        .returns<Array<{ order_number: string }>>();
  const rebillQuestion = voidRebillQuestion((sourceJobs ?? []).map((job) => job.order_number));
  const voidBlocked = voidRefusal({
    status: invoice.status, amountPaid: Number(invoice.amount_paid),
    paymentCount: paymentCount ?? 0, creditNoteCount: creditNoteCount ?? 0,
  });
  const profile = parseInvoiceProfile(tenantRow?.settings);
  const profileGaps = invoiceProfileGaps(tenantRow?.abn ?? null, profile);
  // Brief 1.1: a draft cannot be issued until the laundry's ABN, address and bank
  // details are set. The same rule `issueOneInvoice` and 0053's guard apply.
  const mayEditSettings = can(session.role, "admin.write");
  const issueBlocked = issueBlockedReason(issueGaps(tenantRow?.abn ?? null, profile), mayEditSettings);
  const creditableNow = Math.max(0, Math.round(
    (Number(invoice.total) - Number(invoice.amount_paid) - Number(invoice.amount_credited ?? 0)) * 100) / 100);
  const emailConfigured = emailIsConfigured();
  const textConfigured = smsIsConfigured();
  // Read apart from the invoice, and any error ignored: this line is a courtesy,
  // and a database that has not had 0061 must still draw the invoice.
  const { data: texted } = await supabase
    .from("invoices").select("sms_sent_at, sms_sent_to")
    .eq("tenant_id", session.tenantId).eq("id", id)
    .maybeSingle<{ sms_sent_at: string | null; sms_sent_to: string | null }>();
  const mobile = writable
    ? await loadCustomerMobile(supabase, session.tenantId, invoice.customer_id)
    : null;

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
        title={`${documentTitle(invoice)} ${invoice.invoice_number}`}
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

      {/* A draft says it cannot be issued yet (brief 1.1); a document already
          issued — an imported MYOB header, say — says what its print lacks. */}
      {profileGaps.length > 0 && invoice.invoice_type !== "credit" ? (
        <Notice tone="warning"
                title={invoice.status === "draft"
                  ? "This invoice cannot be issued yet"
                  : "The printed invoice is missing details"}>
          {invoice.status === "draft" ? "A tax invoice needs" : "It does not yet show"}{" "}
          {profileGaps.join(", ")}.{" "}
          {mayEditSettings
            ? <a className="underline" href="/admin/invoicing">Add them in Settings › Invoicing.</a>
            : "Ask the owner to add them in Settings › Invoicing."}
        </Notice>
      ) : null}

      {invoice.status === "void" ? (
        <Notice tone="danger" title="This invoice is void">
          {invoice.void_reason ?? "No reason recorded."}
        </Notice>
      ) : null}

      {/* Brief 1.2: a Xero refusal is shown on the invoice it belongs to, with the
          retry beside it — issuing never waits on Xero, so this is where it is found. */}
      {invoice.xero_push_error ? (
        <Notice tone="warning" title="Xero did not accept this invoice">
          <span className="block">{invoice.xero_push_error}</span>
          {writable ? (
            <form action={retryXeroPush} className="mt-2">
              <input type="hidden" name="id" value={id} />
              <SubmitButton variant="secondary" size="md" pendingLabel="Retrying…">Retry sending to Xero</SubmitButton>
            </form>
          ) : null}
        </Notice>
      ) : null}

      {invoice.source === "import" ? (
        <p className="text-sm text-muted-foreground">
          Brought in from MYOB. Its history went into Xero separately, so it is never sent from here.
        </p>
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

      {/* Line amounts include GST (0043), so "Subtotal / GST / Total" printed
          the same figure twice with the tax between them — a sum that reads as
          wrong. The total leads and the GST is stated as part of it. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Total (inc GST)" value={money(invoice.total)}
              hint={`Includes GST of ${money(invoice.tax_amount)}`} />
        <Stat label="Paid" value={money(invoice.amount_paid)} />
        <Stat label="Credited" value={money(invoice.amount_credited ?? 0)} />
        <Stat label="Balance" value={money(invoice.balance)}
              tone={Number(invoice.balance) > 0 ? "warning" : "success"} />
        <Stat label="Ex GST" value={money(Number(invoice.total) - Number(invoice.tax_amount))} />
      </div>

      {/* **Two columns from `xl`, not one long scroll (§10b).** An invoice is
          read as "what is on it" beside "what do I do with it", and stacking the
          lines, the breakdown, the payments, the credit notes and five action
          cards into a single column made a page nobody reaches the bottom of.
          Below `xl` it stacks in exactly the order it did before. */}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Suspense fallback={<SkeletonRows rows={5} />}>
            <Lines invoiceId={id} editable={editable} tenantId={session.tenantId}
                   customerId={invoice.customer_id} />
            <ServiceBreakdown invoiceId={id} tenantId={session.tenantId} />
          </Suspense>

          <Suspense fallback={<SkeletonRows rows={3} />}>
            <Payments invoice={invoice} writable={writable} tenantId={session.tenantId} />
          </Suspense>

          <Suspense fallback={null}>
            <CreditNotes invoiceId={id} tenantId={session.tenantId} />
          </Suspense>
        </div>

        <div className="space-y-6">
          <Card title="Details">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-1">
              <Meta label="Bill to" value={invoice.customers?.business_name ?? "—"} />
              <Meta label="ABN" value={invoice.customers?.abn ?? "—"} />
              <Meta label="Issued" value={issueDateText(invoice.status, invoice.issue_date, date)} />
              <Meta label="Due" value={invoice.status === "draft" ? "Set from the terms when issued" : date(invoice.due_date)} />
              <Meta label="Period" value={period
                ?? (invoice.period_start
                  ? `${date(invoice.period_start)} – ${date(invoice.period_end)}` : "—")} />
              <Meta label="PO number" value={invoice.purchase_order_number ?? "—"} />
              <Meta label="Terms" value={`${invoice.payment_terms_days} days`} />
              <Meta label="Email" value={invoice.customers?.billing_email ?? "—"} />
            </dl>
          </Card>

          <Suspense fallback={null}>
            <SourceJobs invoiceId={id} tenantId={session.tenantId} editable={editable}
                        invoiceStatus={invoice.status} />
          </Suspense>

          {writable ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 print:hidden">
              <Card
                title="Send to customer"
                description={sentSummary(invoice, texted)}
              >
                {invoice.status === "draft" ? (
                  <Notice tone="info">Issue the invoice before sending — a draft can still change.</Notice>
                ) : invoice.status === "void" ? (
                  <Notice tone="warning">A void invoice cannot be sent.</Notice>
                ) : !emailConfigured && !textConfigured ? (
                  <Notice tone="warning" title="No email provider configured">
                    Set <code>RESEND_API_KEY</code> and <code>INVOICE_FROM_EMAIL</code> to send from
                    the app. The PDF can still be downloaded and attached by hand.
                  </Notice>
                ) : (
                  <form action={emailInvoice} className="space-y-3">
                    <input type="hidden" name="id" value={id} />
                    <Field label="Send by" name="channel"
                           hint={textConfigured
                             ? "A text carries a private link to the PDF."
                             : "Text messages are not set up yet. Choosing one will say so, and nothing is sent."}>
                      <Select name="channel" defaultValue="email" options={[
                        { value: "email", label: "Email" },
                        { value: "sms", label: textConfigured ? "Text message" : "Text message (not set up)" },
                        { value: "both", label: textConfigured ? "Email and text" : "Email and text (not set up)" },
                      ]} />
                    </Field>
                    <Field label="Email to" name="to"
                           hint={invoice.customers?.billing_email
                             ? "Leave blank to use the customer's billing email."
                             : "This customer has no billing email on file."}>
                      <Input name="to" type="email"
                             placeholder={invoice.customers?.billing_email ?? "accounts@customer.com.au"} />
                    </Field>
                    <Field label="Text to" name="mobile"
                           hint={mobile
                             ? "Leave blank to use the mobile on the customer's record."
                             : "No mobile on file. Most customer numbers are landlines, so type one to text."}>
                      <Input name="mobile" type="tel" inputMode="tel"
                             placeholder={mobile ? displayMobile(mobile) : "0412 345 678"} />
                    </Field>
                    {/* It leaves at once (brief 1.6 — the Help page promised a
                        confirmation here before there was one). */}
                    <ConfirmSubmit
                      label="Send invoice"
                      variant="primary"
                      eyebrow="It leaves straight away"
                      consequence={`Send ${invoice.invoice_number} the way you chose above${invoice.customers?.billing_email
                        ? `, to ${invoice.customers.billing_email} unless you typed another address`
                        : ""}? Once it has gone it cannot be called back.`}
                      cancelLabel="Not yet"
                      pendingLabel="Sending…"
                    />
                  </form>
                )}
              </Card>

              <Card title="Issue and void">
                <div className="flex flex-wrap gap-2">
                  {invoice.status === "draft" ? (
                    <IssueControl invoiceId={id} invoiceNumber={invoice.invoice_number}
                                  total={Number(invoice.total)} action={issueInvoice}
                                  blocked={issueBlocked}
                                  settingsHref={mayEditSettings ? "/admin/invoicing" : null} />
                  ) : null}
            </div>
            {invoice.status !== "void" && voidBlocked ? (
              <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">{voidBlocked}</p>
            ) : null}
            {invoice.status !== "void" && !voidBlocked ? (
              <form action={voidInvoice} className="mt-4 border-t pt-4">
                <input type="hidden" name="id" value={id} />
                <ConfirmSubmit
                  label="Void invoice"
                  consequence={`Voiding cancels ${invoice.invoice_number} permanently. The number is kept for the audit trail and a replacement gets a new one.`}
                  reasonName="void_reason"
                  reasonLabel="Why is it being voided?"
                  pendingLabel="Voiding…"
                  choice={rebillQuestion ? {
                    name: "rebill",
                    legend: rebillQuestion,
                    options: [
                      { value: "yes", label: "Yes — bill the work again" },
                      { value: "no", label: "No — it should not be billed" },
                    ],
                  } : undefined}
                />
              </form>
            ) : null}
          </Card>

          {creditable(invoice) && creditableNow <= 0.005 ? (
          <Card title="Credit note">
            <p className="text-sm text-muted-foreground">
              {creditRefusal({
                status: invoice.status, invoiceType: invoice.invoice_type, total: Number(invoice.total),
                amountPaid: Number(invoice.amount_paid),
                alreadyCredited: Number(invoice.amount_credited ?? 0), amount: 0.01,
              })}
            </p>
          </Card>
          ) : null}
          {creditable(invoice) && creditableNow > 0.005 ? (
          <Card title="Credit note" description="Always references this invoice.">
            <form action={createCreditNote} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="invoice_id" value={id} />
              <input type="hidden" name="customer_id" value={invoice.customer_id} />
              {/*
                * GST-inclusive, like the invoice line it offsets. It said
                * "(ex GST)" until 0046 and that was true of the old arithmetic —
                * the action added 10% on top — which meant offsetting a $72.70
                * line took $66.09 typed here. Now the figure entered is the
                * figure credited, and the GST is found inside it.
                */}
              <Field
                label="Amount (inc GST)"
                name="amount"
                hint={`What the customer is credited, at most ${money(creditableNow)} — what is still owed after payments and earlier credits.`}
                required
              >
                <Input name="amount" type="number" step="0.01" min={0} max={creditableNow} required />
              </Field>
              <Field label="Reason" name="reason" required>
                <Input name="reason" required placeholder="Short delivery on 12 March" />
              </Field>
              {/*
                * Ticked by default, which is what this form always did in
                * effect — the line defaulted to taxable and the header was
                * always taxed. Worth asking now rather than assuming: under the
                * inclusive model this decides whether a eleventh of the amount
                * already typed is GST, so crediting a GST-free line with it on
                * overstates the customer's GST.
                */}
              <Checkbox id="credit-note-taxable" name="taxable" label="GST applies" defaultChecked />
              <div className="sm:col-span-2">
                <SubmitButton variant="secondary">Issue credit note</SubmitButton>
              </div>
            </form>
          </Card>
          ) : null}
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
  invoiceId, tenantId, editable, invoiceStatus,
}: {
  invoiceId: string; tenantId: string; editable: boolean; invoiceStatus: string;
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
                {jobStatusOnInvoice(job.billingStatus, invoiceStatus)}
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
  invoiceId, editable, tenantId, customerId,
}: {
  invoiceId: string;
  editable: boolean;
  /**
   * Whose prices to offer. A picked item's rate is this customer's own listed
   * price where they have one and the laundry's usual price otherwise, so the
   * composer bills what the price screens say — see `attachListPrices`.
   */
  customerId: string | null;
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
    editable ? loadItemCatalogue(tenantId, customerId) : Promise.resolve([]),
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
async function loadItemCatalogue(
  tenantId: string, customerId: string | null,
): Promise<LineFormItem[]> {
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
  // The laundry price list in front of `items.sell_price`, so re-rating a code
  // on Billing › Laundry prices changes what the next line composed for it costs.
  return attachListPrices(supabase, tenantId, customerId, data ?? []);
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

async function Payments({ invoice, writable, tenantId }: {
  invoice: InvoiceDetail; writable: boolean; tenantId: string;
}) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("payments")
    .select("id, invoice_id, customer_id, paid_on, amount, method, reference")
    .eq("invoice_id", invoice.id).eq("tenant_id", tenantId).order("paid_on", { ascending: false })
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
          ...(writable ? [{
            header: "",
            cell: (row: Payment) => (
              <form action={reversePayment} className="print:hidden">
                <input type="hidden" name="payment_id" value={row.id} />
                <input type="hidden" name="invoice_id" value={invoice.id} />
                <ConfirmSubmit
                  label="Reverse"
                  eyebrow="Changes the balance"
                  consequence={`Reversing takes this ${money(row.amount)} payment off ${invoice.invoice_number} and puts it back on the balance owed. The payment is kept in the activity log.`}
                  reasonName="reason"
                  reasonLabel="Why is it being reversed?"
                  pendingLabel="Reversing…"
                />
              </form>
            ),
          }] : []),
        ]}
      />

      {paidBeforeApp(invoice, data ?? []) > 0.005 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {money(paidBeforeApp(invoice, data ?? []))} was recorded as paid before this invoice
          came into the app (imported from MYOB), so it has no payment rows here.
        </p>
      ) : null}

      {writable && canTakePayment(invoice) ? (
        <form action={recordPayment} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-5 print:hidden">
          <input type="hidden" name="invoice_id" value={invoice.id} />
          <input type="hidden" name="customer_id" value={invoice.customer_id} />
          <Field label="Paid on" name="paid_on" required>
            <Input name="paid_on" type="date" required defaultValue={today()} max={today()} />
          </Field>
          <Field label="Amount" name="amount" required>
            <Input name="amount" type="number" step="0.01" min={0.01} required
                   max={Number(invoice.balance)}
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

async function CreditNotes({ invoiceId, tenantId }: { invoiceId: string; tenantId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("credit_notes")
    .select("id, credit_note_number, status, issue_date, reason, total")
    .eq("invoice_id", invoiceId).eq("tenant_id", tenantId).order("issue_date", { ascending: false })
    .returns<Array<{ id: string; credit_note_number: string; status: string; issue_date: string; reason: string | null; total: number }>>();

  if (!data?.length) return null;

  return (
    <Card title="Credit notes">
      <DataTable
        rows={data}
        empty={<EmptyState title="No credit notes" />}
        columns={[
          {
            header: "Credit note",
            // A route handler, so a plain anchor rather than a client link.
            cell: (row) => (
              <a className="font-medium underline" href={`/api/credit-notes/${row.id}/pdf`}
                 target="_blank" rel="noreferrer">
                {row.credit_note_number}
              </a>
            ),
          },
          { header: "Issued", cell: (row) => date(row.issue_date) },
          { header: "Reason", cell: (row) => row.reason ?? "—", hideBelow: "sm" },
          { header: "Total", cell: (row) => money(row.total), align: "right" },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
    </Card>
  );
}

/** What the document is, for its heading — a credit is not a tax invoice. */
function documentTitle(invoice: { invoice_type: string; status: string; total: number; tax_amount: number }): string {
  if (invoice.invoice_type === "credit" || Number(invoice.total) < 0) return "Credit";
  if (invoice.status === "draft") return "Draft invoice";
  // Matches the PDF: "Tax invoice" only when GST is actually charged.
  return Number(invoice.tax_amount) > 0 ? "Tax invoice" : "Invoice";
}

/** A credit note offsets an invoice the customer has been sent. */
function creditable(invoice: { invoice_type: string; status: string; total: number }): boolean {
  return invoice.invoice_type !== "credit"
    && Number(invoice.total) > 0
    && ["issued", "part_paid", "overdue", "paid"].includes(invoice.status);
}

/** Paid-to-date that has no payment rows behind it — MYOB's figure on an import. */
function paidBeforeApp(invoice: { amount_paid: number }, payments: Array<{ amount: number }>): number {
  const rows = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  return Math.round((Number(invoice.amount_paid) - rows) * 100) / 100;
}
