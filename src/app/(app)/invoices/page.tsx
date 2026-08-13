import { Suspense } from "react";
import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, money, relativeDays, today } from "@/lib/format";
import { CHARGE_TYPE_LABELS, type ChargeType } from "@/lib/domain/pricing";
import {
  Button, ButtonLink, Card, EmptyState, Eyebrow, Notice, PageHeader,
  SkeletonRows, SkeletonStats, StatusBadge, cx, humanise,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";
import { emailIsConfigured } from "@/lib/email/send";
import {
  createManualInvoice, emailInvoice, generateInvoices, issueInvoice, recordPayment,
} from "./actions";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

type Search = {
  q?: string; status?: string; customer?: string; page?: string;
  selected?: string; tool?: string; error?: string; ok?: string;
};

/**
 * Billing, as the pack's two-pane (screen 07).
 *
 * The register on the left is a work queue — a chase list, worked top to bottom
 * — and the pane on the right is where the work happens. The point of the split
 * is that issuing an invoice, taking a payment and moving to the next one never
 * loses your place in the list, which is exactly what the old
 * list → detail → back → scroll loop did.
 *
 * The full page at `/invoices/:id` stays: it is the printable record, and it is
 * where line editing and voiding live. The pane deliberately carries only the
 * three things a chase actually needs — issue, send, take payment.
 */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireCapability("invoices.read");
  const writable = can(session.role, "invoices.write");

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Billing"
        title="Invoices"
        description="Most invoices are created from contracts and completed work each month; one-off and credit invoices sit alongside them."
        actions={writable ? (
          <>
            <ButtonLink href={hrefWith(params, { tool: "recurring", selected: undefined })}>
              Create this month&apos;s invoices
            </ButtonLink>
            <ButtonLink href={hrefWith(params, { tool: "manual", selected: undefined })}>
              Manual invoice
            </ButtonLink>
          </>
        ) : null}
      />

      <Suspense fallback={<SkeletonStats count={4} />}>
        <Aging />
      </Suspense>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
        <div>
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
          <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={10} />}>
            <Register params={params} />
          </Suspense>
        </div>

        {/* Sticky only once there is room for two columns; stacked on a phone the
            pane is just the next thing down the page. */}
        <div className="lg:sticky lg:top-4">
          <Suspense key={`${params.selected ?? ""}-${params.tool ?? ""}`} fallback={<SkeletonRows rows={6} />}>
            <WorkPane params={params} writable={writable} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

/** Same screen, different selection — filters and page survive the click. */
function hrefWith(params: Search, patch: Partial<Record<keyof Search, string | undefined>>): string {
  const search = new URLSearchParams();
  const merged = { ...params, ...patch };
  for (const [key, value] of Object.entries(merged)) {
    // Flash messages belong to the redirect that set them, not to the next link.
    if (!value || key === "error" || key === "ok") continue;
    search.set(key, value);
  }
  const query = search.toString();
  return query ? `/invoices?${query}` : "/invoices";
}

/* ------------------------------------------------------------------- aging */

async function Aging() {
  const supabase = await createClient();
  const now = today();
  const { data } = await supabase
    .from("invoices")
    .select("balance, due_date, status")
    .in("status", ["issued", "part_paid", "overdue"])
    .is("deleted_at", null)
    .returns<Array<{ balance: number; due_date: string | null; status: string }>>();

  // Tone classes are written out rather than interpolated: Tailwind only ships
  // the utilities it can see in the source, so `text-${tone}` compiles to nothing.
  const buckets = [
    { label: "Current", total: 0, hint: "" },
    { label: "1–30 days", total: 0, hint: "text-warning" },
    { label: "31–60 days", total: 0, hint: "text-warning" },
    { label: "60+ days", total: 0, hint: "text-danger", figure: "text-danger" },
  ] as Array<{ label: string; total: number; hint: string; figure?: string }>;

  for (const invoice of data ?? []) {
    const overdueDays = invoice.due_date ? relativeDays(invoice.due_date, now) : 0;
    const amount = Number(invoice.balance ?? 0);
    const index = overdueDays <= 0 ? 0 : overdueDays <= 30 ? 1 : overdueDays <= 60 ? 2 : 3;
    buckets[index]!.total += amount;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {buckets.map((bucket) => (
        <div key={bucket.label} className="rounded-xl border bg-surface px-4 py-3 shadow-sm">
          <Eyebrow>{bucket.label}</Eyebrow>
          <div className={cx(
            "mt-1 text-2xl font-semibold tabular-nums tracking-[-0.02em]",
            bucket.total > 0 && bucket.figure,
          )}>
            {money(bucket.total)}
          </div>
          <div className={cx(
            "mt-0.5 text-xs",
            bucket.total > 0 ? (bucket.hint || "text-muted-foreground") : "text-muted-foreground",
          )}>
            {bucket.total > 0 ? "outstanding" : "nothing outstanding"}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- register */

type RegisterRow = {
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

async function Register({ params }: { params: Search }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);
  const now = today();

  let query = supabase
    .from("invoices")
    .select("id, invoice_number, invoice_type, status, issue_date, due_date, total, balance, " +
            "customers(business_name)", { count: "exact" })
    .is("deleted_at", null)
    .order("issue_date", { ascending: false })
    .range(from, to);

  if (params.status) query = query.eq("status", params.status);
  if (params.customer) query = query.eq("customer_id", params.customer);
  if (params.q) query = query.ilike("invoice_number", `%${params.q}%`);

  const { data, count } = await query.returns<RegisterRow[]>();
  const rows = data ?? [];

  if (rows.length === 0) {
    return (
      <Card title="Register">
        <EmptyState
          title="No invoices match"
          description="Bill a period from your active contracts, or raise a one-off invoice."
        />
      </Card>
    );
  }

  return (
    <>
      <Card title="Register" description={`${count ?? rows.length} invoice(s)`} className="[&>div]:p-0">
        <ul>
          {rows.map((row) => {
            const selected = params.selected === row.id;
            const overdueDays = row.due_date ? relativeDays(row.due_date, now) : 0;
            const chasing = overdueDays > 0 && Number(row.balance) > 0
              && !["paid", "void", "draft"].includes(row.status);

            return (
              <li key={row.id} className="border-b last:border-b-0">
                <Link
                  href={hrefWith(params, { selected: row.id })}
                  aria-current={selected ? "true" : undefined}
                  className={cx(
                    "block border-l-[3px] px-3 py-2 transition",
                    selected
                      ? "border-l-primary bg-surface-muted"
                      : chasing ? "border-l-warning hover:bg-surface-muted"
                      : "border-l-transparent hover:bg-surface-muted",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium">{row.invoice_number}</span>
                    <span className="text-sm font-semibold tabular-nums">
                      {money(row.balance)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">
                      {row.customers?.business_name ?? "—"}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      of {money(row.total)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <StatusBadge status={row.status} />
                    <span className={cx(
                      "text-xs",
                      chasing ? "text-warning" : "text-muted-foreground",
                    )}>
                      {row.due_date
                        ? chasing ? `${overdueDays} day(s) past terms` : `due ${date(row.due_date)}`
                        : `issued ${date(row.issue_date)}`}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
      <Pagination page={page} total={count ?? 0} params={params} basePath="/invoices" />
    </>
  );
}

/* ---------------------------------------------------------------- the pane */

async function WorkPane({ params, writable }: { params: Search; writable: boolean }) {
  if (writable && params.tool === "recurring") return <GenerateTool params={params} />;
  if (writable && params.tool === "manual") return <ManualTool params={params} />;
  if (params.selected) return <InvoicePane params={params} writable={writable} />;

  return (
    <Card title="Nothing selected">
      <EmptyState
        title="Pick an invoice from the register"
        description={writable
          ? "Or raise one: bill a period from your active contracts, or start a one-off invoice."
          : "Its lines, payments and status will open here."}
        action={writable ? (
          <div className="flex flex-wrap justify-center gap-1.5">
            <ButtonLink href={hrefWith(params, { tool: "recurring" })} variant="primary">
              Create this month&apos;s invoices
            </ButtonLink>
            <ButtonLink href={hrefWith(params, { tool: "manual" })}>Manual invoice</ButtonLink>
          </div>
        ) : null}
      />
    </Card>
  );
}

type PaneInvoice = {
  id: string; invoice_number: string; customer_id: string; invoice_type: string;
  status: string; issue_date: string; due_date: string | null;
  period_start: string | null; period_end: string | null;
  purchase_order_number: string | null; payment_terms_days: number;
  subtotal: number; tax_amount: number; total: number; amount_paid: number; balance: number;
  void_reason: string | null; emailed_at: string | null; emailed_to: string | null;
  customers: { business_name: string; customer_number: string; billing_email: string | null } | null;
};

async function InvoicePane({ params, writable }: { params: Search; writable: boolean }) {
  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, invoice_number, customer_id, invoice_type, status, issue_date, due_date, " +
            "period_start, period_end, purchase_order_number, payment_terms_days, subtotal, " +
            "tax_amount, total, amount_paid, balance, void_reason, emailed_at, emailed_to, " +
            "customers(business_name, customer_number, billing_email)")
    .eq("id", params.selected!)
    .maybeSingle<PaneInvoice>();

  if (!invoice) {
    return (
      <Card title="Nothing selected">
        <EmptyState
          title="That invoice is no longer available"
          description="It may have been deleted. Pick another from the register."
        />
      </Card>
    );
  }

  const [{ data: lines }, { data: payments }] = await Promise.all([
    supabase.from("invoice_lines")
      .select("id, description, charge_type, quantity, unit_price, amount")
      .eq("invoice_id", invoice.id).order("sequence")
      .returns<Array<{
        id: string; description: string; charge_type: string;
        quantity: number; unit_price: number; amount: number;
      }>>(),
    supabase.from("payments")
      .select("id, paid_on, amount, method, reference")
      .eq("invoice_id", invoice.id).order("paid_on", { ascending: false })
      .returns<Array<{
        id: string; paid_on: string; amount: number; method: string; reference: string | null;
      }>>(),
  ]);

  // Every action in the pane comes back to the pane, filters and page intact.
  const backHere = hrefWith(params, { selected: invoice.id, tool: undefined });
  const overdueDays = invoice.due_date ? relativeDays(invoice.due_date, today()) : 0;
  const chasing = overdueDays > 0 && Number(invoice.balance) > 0
    && !["paid", "void", "draft"].includes(invoice.status);

  return (
    <Card
      title={invoice.invoice_number}
      description={invoice.customers?.business_name ?? "Unknown customer"}
      actions={<StatusBadge status={invoice.status} />}
      className="[&>div]:p-0"
    >
      <div className="space-y-3 p-4">
        {invoice.status === "void" ? (
          <Notice tone="danger" title="This invoice is void">
            {invoice.void_reason ?? "No reason recorded."}
          </Notice>
        ) : chasing ? (
          <Notice tone="warning">
            {overdueDays} day(s) past terms · {money(invoice.balance)} outstanding.
          </Notice>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <PaneFigure label="Total" value={money(invoice.total)} />
          <PaneFigure
            label="Balance" value={money(invoice.balance)}
            tone={Number(invoice.balance) > 0 ? "warning" : "success"}
          />
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          <PaneMeta label="Issued" value={date(invoice.issue_date)} />
          <PaneMeta label="Due" value={date(invoice.due_date)} />
          <PaneMeta label="Type" value={humanise(invoice.invoice_type)} />
          <PaneMeta label="Terms" value={`${invoice.payment_terms_days} days`} />
          {invoice.period_start ? (
            <PaneMeta
              label="Period"
              value={`${date(invoice.period_start)} – ${date(invoice.period_end)}`}
              wide
            />
          ) : null}
          {invoice.purchase_order_number ? (
            <PaneMeta label="PO" value={invoice.purchase_order_number} wide />
          ) : null}
        </dl>
      </div>

      <PaneSection title={`Lines · ${lines?.length ?? 0}`}>
        {lines?.length ? (
          <ul className="divide-y">
            {lines.map((line) => (
              <li key={line.id} className="flex items-baseline justify-between gap-3 px-4 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{line.description}</span>
                  <Eyebrow>
                    {CHARGE_TYPE_LABELS[line.charge_type as ChargeType] ?? humanise(line.charge_type)}
                    {" · "}{line.quantity} × {money(line.unit_price)}
                  </Eyebrow>
                </span>
                <span className="shrink-0 text-sm tabular-nums">{money(line.amount)}</span>
              </li>
            ))}
            <li className="rounded-lg flex items-baseline justify-between gap-3 bg-surface-muted px-4 py-1.5">
              <Eyebrow>Subtotal · GST {money(invoice.tax_amount)}</Eyebrow>
              <span className="text-sm font-semibold tabular-nums">
                {money(invoice.subtotal)}
              </span>
            </li>
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No lines yet. Add them on the full invoice.
          </p>
        )}
      </PaneSection>

      {payments?.length ? (
        <PaneSection title={`Payments · ${money(invoice.amount_paid)}`}>
          <ul className="divide-y">
            {payments.map((payment) => (
              <li key={payment.id} className="flex items-baseline justify-between gap-3 px-4 py-1.5">
                <span className="min-w-0">
                  <span className="block text-xs">{date(payment.paid_on)}</span>
                  <Eyebrow>{humanise(payment.method)}{payment.reference ? ` · ${payment.reference}` : ""}</Eyebrow>
                </span>
                <span className="shrink-0 text-sm tabular-nums">{money(payment.amount)}</span>
              </li>
            ))}
          </ul>
        </PaneSection>
      ) : null}

      {writable && invoice.status !== "void" ? (
        <PaneSection title="Do next">
          <div className="space-y-3 px-4 py-3">
            {invoice.status === "draft" ? (
              <form action={issueInvoice} className="flex items-center gap-2">
                <input type="hidden" name="id" value={invoice.id} />
                <input type="hidden" name="return_to" value={backHere} />
                <Button variant="primary">Issue invoice</Button>
                <span className="text-xs text-muted-foreground">
                  Lines are frozen once issued.
                </span>
              </form>
            ) : emailIsConfigured() ? (
              <form action={emailInvoice}>
                <input type="hidden" name="id" value={invoice.id} />
                <input type="hidden" name="return_to" value={backHere} />
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Email to" name="to" className="min-w-[12rem] flex-1">
                    <Input name="to" type="email"
                           placeholder={invoice.customers?.billing_email ?? "accounts@customer.com.au"} />
                  </Field>
                  <SubmitButton pendingLabel="Sending…">Send</SubmitButton>
                </div>
                {/* Outside the field so the hint cannot drag the button off the
                    input's baseline. */}
                <p className="mt-1 text-xs text-muted-foreground">
                  {invoice.emailed_at
                    ? `Last sent ${date(invoice.emailed_at)} to ${invoice.emailed_to ?? "the customer"}.`
                    : "Blank uses the customer's billing email."}
                </p>
              </form>
            ) : (
              <Notice tone="warning" title="No email provider configured">
                Set <code>RESEND_API_KEY</code> and <code>INVOICE_FROM_EMAIL</code> to send from the
                app. The PDF can still be downloaded from the full invoice.
              </Notice>
            )}

            {invoice.status !== "draft" && Number(invoice.balance) > 0 ? (
              <form action={recordPayment} className="grid gap-2 border-t pt-3 sm:grid-cols-2">
                <input type="hidden" name="invoice_id" value={invoice.id} />
                <input type="hidden" name="customer_id" value={invoice.customer_id} />
                <input type="hidden" name="return_to" value={backHere} />
                <Field label="Paid on" name="paid_on" required>
                  <Input name="paid_on" type="date" required defaultValue={today()} />
                </Field>
                <Field label="Amount" name="amount" required>
                  <Input name="amount" type="number" step="0.01" min={0} required
                         defaultValue={String(invoice.balance)} />
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
                <div className="sm:col-span-2">
                  <SubmitButton>Record payment</SubmitButton>
                </div>
              </form>
            ) : null}
          </div>
        </PaneSection>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t px-4 py-2.5">
        <Link href={`/invoices/${invoice.id}`} className="text-sm font-medium text-primary hover:underline">
          Open full invoice →
        </Link>
        <a href={`/api/invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer"
           className="text-sm font-medium text-primary hover:underline">
          Download PDF
        </a>
      </div>
    </Card>
  );
}

function PaneFigure({
  label, value, tone = "default",
}: { label: string; value: string; tone?: "default" | "warning" | "success" }) {
  return (
    <div className="rounded-lg border bg-surface px-3 py-2">
      <Eyebrow>{label}</Eyebrow>
      <div className={cx(
        "mt-0.5 text-[17px] font-semibold tabular-nums",
        tone === "warning" && "text-warning",
      )}>
        {value}
      </div>
    </div>
  );
}

function PaneMeta({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <dt><Eyebrow>{label}</Eyebrow></dt>
      <dd className="text-xs">{value}</dd>
    </div>
  );
}

function PaneSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t">
      <h3 className="rounded-lg bg-surface-muted px-4 py-1.5 text-xs font-semibold text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/* ----------------------------------------------------------------- the tools */

function GenerateTool({ params }: { params: Search }) {
  return (
    <Card
      title="Create this month's invoices"
      description="One invoice per customer, covering every contract they hold for the period below. Anything already billed is skipped, so it is safe to run twice."
      actions={<ButtonLink href={hrefWith(params, { tool: undefined })}>Close</ButtonLink>}
    >
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
  );
}

async function ManualTool({ params }: { params: Search }) {
  const supabase = await createClient();
  const { data: customers } = await supabase
    .from("customers").select("id, business_name, customer_number")
    .is("deleted_at", null).neq("status", "archived").order("business_name");

  return (
    <Card
      title="Manual invoice"
      description="For one-off charges outside the agreement."
      actions={<ButtonLink href={hrefWith(params, { tool: undefined })}>Close</ButtonLink>}
    >
      <form action={createManualInvoice} className="grid gap-3 sm:grid-cols-2">
        {/* Tells the action to open the new draft in this pane. */}
        <input type="hidden" name="pane" value="1" />
        <Field label="Customer" name="customer_id" required className="sm:col-span-2">
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
        <Field label="PO number" name="purchase_order_number" className="sm:col-span-2">
          <Input name="purchase_order_number" />
        </Field>
        <div className="sm:col-span-2">
          <SubmitButton>Create draft invoice</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
