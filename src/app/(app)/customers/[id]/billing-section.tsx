import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { money } from "@/lib/format";
import {
  BILLING_METHODS, BILLING_METHOD_BLURBS, BILLING_METHOD_LABELS, isBillingMethod,
} from "@/lib/domain/billing";
import { CHARGE_TYPE_LABELS, type ChargeType } from "@/lib/domain/pricing";
import { ITEM_TYPE_LABELS, type ItemType } from "@/lib/domain/laundry-orders";
import { Badge, Card, DataTable, EmptyState, Notice } from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { updateCustomerBilling } from "../billing-actions";

/**
 * Billing & Pricing for one customer.
 *
 * Six answers, in the order somebody setting a customer up would give them:
 * which rate card prices them, how their work turns into invoices, where the
 * invoice goes, when it falls due, what they are called in Xero, and — read-only
 * underneath — the customer-specific rates the rate card actually carries.
 *
 * **This whole section is `billing.read`, and that is enforced in the database
 * too.** `service_agreement_lines` is where a customer's negotiated prices live,
 * and migration 0017 narrows its read policy to `can_read_pricing()`. So the
 * rates table below is not merely hidden from a dispatcher — their session reads
 * zero rows from it, and the section is not rendered for them at all.
 *
 * The one thing this screen deliberately cannot do is change a price that has
 * already been charged. Rate cards are versions of a service agreement, so a new
 * price is a new version; every job approved before today keeps the frozen
 * snapshot it was approved with.
 */
export async function BillingAndPricing({
  customerId, writable,
}: { customerId: string; writable: boolean }) {
  const supabase = await createClient();

  const { data: customer } = await supabase
    .from("customers")
    .select("id, billing_method, rate_card_agreement_id, billing_email, payment_terms_days, " +
            "xero_contact_id, xero_contact_name")
    .eq("id", customerId)
    .maybeSingle<{
      id: string; billing_method: string; rate_card_agreement_id: string | null;
      billing_email: string | null; payment_terms_days: number;
      xero_contact_id: string | null; xero_contact_name: string | null;
    }>();
  if (!customer) return null;

  // Every agreement version this customer holds is a candidate rate card. Newest
  // first, because the current price is the one being looked for.
  const { data: agreements } = await supabase
    .from("service_agreements")
    .select("id, agreement_number, version, status, start_date")
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("start_date", { ascending: false })
    .returns<Array<{
      id: string; agreement_number: string; version: number; status: string; start_date: string;
    }>>();

  const rateCard = (agreements ?? []).find((row) => row.id === customer.rate_card_agreement_id);

  const { data: rates } = customer.rate_card_agreement_id
    ? await supabase
        .from("service_agreement_lines")
        .select("id, charge_type, pricing_model, unit_price, percentage, included_quantity, " +
                "taxable, laundry_item_type, items(name, sku)")
        .eq("agreement_id", customer.rate_card_agreement_id)
        .returns<Array<{
          id: string; charge_type: string; pricing_model: string; unit_price: number;
          percentage: number | null; included_quantity: number; taxable: boolean;
          laundry_item_type: string | null; items: { name: string; sku: string } | null;
        }>>()
    : { data: [] };

  const method = isBillingMethod(customer.billing_method) ? customer.billing_method : "manual";

  return (
    <Card
      title={"Billing & pricing"}
      description="What this customer is charged, and how that becomes an invoice."
    >
      {writable ? (
        <form action={updateCustomerBilling} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="id" value={customerId} />

          <Field
            label="Rate card"
            name="rate_card_agreement_id"
            hint="The agreement version whose rates price this customer's jobs. Changing it never alters an invoice already raised."
          >
            <Select
              name="rate_card_agreement_id"
              defaultValue={customer.rate_card_agreement_id}
              placeholder="No rate card — price each job by hand"
              options={(agreements ?? []).map((row) => ({
                value: row.id,
                label: `${row.agreement_number} v${row.version} · ${row.status}`,
              }))}
            />
          </Field>

          <Field
            label="Billing method"
            name="billing_method"
            hint={BILLING_METHOD_BLURBS[method]}
          >
            <Select
              name="billing_method"
              defaultValue={method}
              options={BILLING_METHODS.map((value) => ({
                value, label: BILLING_METHOD_LABELS[value],
              }))}
            />
          </Field>

          <Field
            label="Invoice email"
            name="billing_email"
            hint="Where invoices are emailed. The address used is stamped on each invoice as it is sent."
          >
            <Input name="billing_email" type="email" defaultValue={customer.billing_email} />
          </Field>

          <Field label="Payment terms" name="payment_terms_days" hint="Days from issue until the invoice falls due.">
            <Input name="payment_terms_days" type="number" min={0} inputMode="numeric"
                   defaultValue={customer.payment_terms_days} />
          </Field>

          <Field
            label="Xero customer"
            name="xero_contact_name"
            hint="Filled in automatically the first time one of their bills reaches Xero. You only need to type it if you are matching up a customer who is already there."
          >
            <Input name="xero_contact_name" defaultValue={customer.xero_contact_name}
                   placeholder="Contact name as it reads in Xero" />
          </Field>

          <Field label="Xero contact ID" name="xero_contact_id">
            <Input name="xero_contact_id" defaultValue={customer.xero_contact_id}
                   placeholder="00000000-0000-0000-0000-000000000000" />
          </Field>

          <div className="sm:col-span-2">
            <SubmitButton size="md">Save billing settings</SubmitButton>
          </div>
        </form>
      ) : (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <ReadRow label="Rate card"
                   value={rateCard ? `${rateCard.agreement_number} v${rateCard.version}` : "None"} />
          <ReadRow label="Billing method" value={BILLING_METHOD_LABELS[method]} />
          <ReadRow label="Invoice email" value={customer.billing_email ?? "—"} />
          <ReadRow label="Payment terms" value={`${customer.payment_terms_days} days`} />
          <ReadRow label="Xero customer" value={customer.xero_contact_name ?? "Not linked"} />
        </dl>
      )}

      <div className="mt-6 border-t pt-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold">Customer-specific rates</h3>
            <p className="text-sm text-muted-foreground">
              {rateCard
                ? <>The priced lines on {rateCard.agreement_number} v{rateCard.version}.</>
                : "Set a rate card above to price this customer's jobs automatically."}
            </p>
          </div>
          {rateCard ? (
            <Link href={`/agreements/${rateCard.id}`} className="text-sm text-primary hover:underline">
              Open the contract
            </Link>
          ) : null}
        </div>

        <DataTable
          bare
          label="Customer-specific rates"
          rows={rates ?? []}
          empty={
            <EmptyState
              title={rateCard ? "This rate card has no priced lines" : "No rate card"}
              description={
                rateCard
                  ? "Jobs for this customer will arrive at review with nothing priced."
                  : "Without one, every completed job is priced by hand before it can be approved."
              }
            />
          }
          columns={[
            {
              header: "Applies to",
              cell: (row) => (
                <span className="flex flex-wrap items-center gap-1.5">
                  {row.laundry_item_type
                    ? <>{ITEM_TYPE_LABELS[row.laundry_item_type as ItemType] ?? row.laundry_item_type}</>
                    : <>{row.items?.name ?? "Agreement charge"}</>}
                  {/* A line with no laundry item type prices the laundry's own
                      linen on rental, and never a bag at the counter — worth
                      saying, because "why wasn't this job priced?" is otherwise
                      a puzzle with the answer sitting in this column. */}
                  {row.laundry_item_type
                    ? null
                    : <Badge tone="neutral">Not counter laundry</Badge>}
                </span>
              ),
            },
            {
              header: "Charge",
              cell: (row) => CHARGE_TYPE_LABELS[row.charge_type as ChargeType] ?? row.charge_type,
              hideBelow: "sm",
            },
            { header: "Basis", cell: (row) => row.pricing_model.replace(/_/g, " "), hideBelow: "md" },
            {
              header: "Included",
              cell: (row) => (Number(row.included_quantity) > 0 ? row.included_quantity : "—"),
              align: "right",
              hideBelow: "lg",
            },
            {
              header: "Rate",
              cell: (row) => (row.pricing_model === "percentage"
                ? `${row.percentage ?? 0}%`
                : money(row.unit_price)),
              align: "right",
            },
          ]}
        />
      </div>

      {customer.xero_contact_id || customer.xero_contact_name ? (
        <div className="mt-5">
          <Notice tone="info">
            This is how this customer is matched up in Xero. Bills raised here are sent across
            on their own once your laundry is connected to Xero, so in most cases there is
            nothing to fill in.
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
