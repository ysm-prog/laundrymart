import type { ReactNode } from "react";
import { Field, FormActions, Input, Select, SubmitButton, Textarea } from "@/components/form";
import { ButtonLink, Card } from "@/components/ui";
import type { Customer, Depot } from "@/lib/db/types";

const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]
  .map((state) => ({ value: state, label: state }));

const STATUSES = [
  { value: "active", label: "Active" },
  { value: "prospect", label: "Prospect" },
  { value: "on_hold", label: "On hold" },
  { value: "inactive", label: "Inactive" },
];

/**
 * A collapsed section of a form (design spec P-4): the fields inside still post
 * with the form — a <details> hides them from the eye, not from the submit.
 */
export function FormDisclosure({
  summary, hint, children, defaultOpen,
}: { summary: string; hint?: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group border bg-surface" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-baseline gap-2 border-border px-4 py-2.5 group-open:border-b [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-2xs text-muted-foreground group-open:hidden">+</span>
        <span aria-hidden className="hidden text-2xs text-muted-foreground group-open:inline">−</span>
        <span className="text-[13px] font-semibold">{summary}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </summary>
      <div className="p-4">{children}</div>
    </details>
  );
}

/**
 * The four fields that create a customer (design spec P-4). Everything else is
 * a default behind a disclosure. Also embedded in the contract wizard's step 1
 * — `formId` associates the fields with a form element rendered elsewhere, so
 * the quick-create can live inside another form's markup without nesting.
 */
export function CustomerEssentials({
  customer, formId, withSite = true,
}: { customer?: Customer; formId?: string; withSite?: boolean }) {
  // The four fields are required at creation (P-4); an existing customer with
  // gaps can still be edited without being forced to fill them first.
  const required = !customer;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Business name" name="business_name" required className="sm:col-span-2">
        <Input name="business_name" required defaultValue={customer?.business_name} formId={formId} />
      </Field>
      <Field label="Phone" name="phone" required={required}>
        <Input name="phone" type="tel" required={required} defaultValue={customer?.phone} formId={formId} />
      </Field>
      <Field label="Billing email" name="billing_email" required={required} hint="Where their invoices are emailed">
        <Input name="billing_email" type="email" required={required} defaultValue={customer?.billing_email} formId={formId} />
      </Field>
      {withSite ? (
        <Field label="Site address" name="site_address" required className="sm:col-span-2"
               hint="Where the driver collects and delivers — saved as their first site">
          <Input name="site_address" required placeholder="12 Wharf Road, Balmain" formId={formId} />
        </Field>
      ) : null}
    </div>
  );
}

export function CustomerForm({
  action, customer, depots, cancelHref, submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  customer?: Customer;
  depots: Pick<Depot, "id" | "name">[];
  cancelHref: string;
  submitLabel: string;
}) {
  return (
    <form action={action} className="space-y-4">
      {customer ? <input type="hidden" name="id" value={customer.id} /> : null}
      {/* Collapsed fields all carry defaults, so an untouched disclosure still posts a valid customer. */}

      <Card title="The essentials"
            description={customer ? undefined : "These four fields are all it takes — everything below has a sensible default."}>
        <CustomerEssentials customer={customer} withSite={!customer} />
      </Card>

      <FormDisclosure summary="Billing details" hint="ABN, billing address, payment terms">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ABN" name="abn" hint="11 digits — validated before saving, optional">
            <Input name="abn" defaultValue={customer?.abn} placeholder="51 824 753 556" />
          </Field>
          <Field label="Trading name" name="trading_name" hint="Only if it differs from the business name">
            <Input name="trading_name" defaultValue={customer?.trading_name} />
          </Field>
          <Field label="Billing address" name="billing_address_line1" className="sm:col-span-2"
                 hint="Only if invoices go somewhere other than the site">
            <Input name="billing_address_line1" defaultValue={customer?.billing_address_line1} />
          </Field>
          <Field label="Suburb" name="billing_suburb">
            <Input name="billing_suburb" defaultValue={customer?.billing_suburb} />
          </Field>
          <Field label="State" name="billing_state">
            <Select name="billing_state" placeholder="—" options={AU_STATES} defaultValue={customer?.billing_state} />
          </Field>
          <Field label="Postcode" name="billing_postcode">
            <Input name="billing_postcode" defaultValue={customer?.billing_postcode} />
          </Field>
          <Field label="Payment terms (days)" name="payment_terms_days" hint="Days from invoice to due date">
            <Input name="payment_terms_days" type="number" min={0} defaultValue={customer?.payment_terms_days ?? 14} />
          </Field>
          <Field label="Purchase order number" name="purchase_order_number"
                 hint="Printed on their invoices, if their accounts team needs one">
            <Input name="purchase_order_number" defaultValue={customer?.purchase_order_number} />
          </Field>
        </div>
      </FormDisclosure>

      <FormDisclosure summary="More" hint="Status, servicing site, notes">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status" name="status" hint="Doesn't block anything — service is driven by their contract">
            <Select name="status" options={STATUSES} defaultValue={customer?.status ?? "active"} />
          </Field>
          <Field label="Servicing site" name="depot_id" hint="Which of your sites collects and delivers for them">
            <Select
              name="depot_id" placeholder="Unassigned"
              defaultValue={customer?.depot_id}
              options={depots.map((depot) => ({ value: depot.id, label: depot.name }))}
            />
          </Field>
          <Field label="Special instructions" name="special_instructions" className="sm:col-span-2"
                 hint="Shown to drivers on every stop for this customer">
            <Textarea name="special_instructions" defaultValue={customer?.special_instructions} />
          </Field>
          <Field label="Internal notes" name="notes" className="sm:col-span-2">
            <Textarea name="notes" defaultValue={customer?.notes} />
          </Field>
        </div>
      </FormDisclosure>

      <FormActions>
        <SubmitButton>{submitLabel}</SubmitButton>
        <ButtonLink href={cancelHref}>Cancel</ButtonLink>
      </FormActions>
    </form>
  );
}
