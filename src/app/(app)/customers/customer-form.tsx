import { Field, FormActions, Input, Select, SubmitButton, Textarea } from "@/components/form";
import { ButtonLink, Card } from "@/components/ui";
import type { Customer, Depot } from "@/lib/db/types";

const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]
  .map((state) => ({ value: state, label: state }));

const STATUSES = [
  { value: "prospect", label: "Prospect" },
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On hold" },
  { value: "inactive", label: "Inactive" },
];

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

      <Card title="Business">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name" name="business_name" required className="sm:col-span-2">
            <Input name="business_name" required defaultValue={customer?.business_name} />
          </Field>
          <Field label="Trading name" name="trading_name" hint="Only if it differs from the business name">
            <Input name="trading_name" defaultValue={customer?.trading_name} />
          </Field>
          <Field label="ABN" name="abn" hint="11 digits — validated before saving">
            <Input name="abn" defaultValue={customer?.abn} placeholder="51 824 753 556" />
          </Field>
          <Field label="Servicing site" name="depot_id" hint="Which of your sites collects and delivers for them">
            <Select
              name="depot_id" placeholder="Unassigned"
              defaultValue={customer?.depot_id}
              options={depots.map((depot) => ({ value: depot.id, label: depot.name }))}
            />
          </Field>
          <Field label="Status" name="status" hint="Doesn't block anything — service is driven by their contract">
            <Select name="status" options={STATUSES} defaultValue={customer?.status ?? "prospect"} />
          </Field>
        </div>
      </Card>

      <Card title="Billing">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Address" name="billing_address_line1" className="sm:col-span-2">
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
          <Field label="Billing email" name="billing_email" hint="Where their invoices are emailed">
            <Input name="billing_email" type="email" defaultValue={customer?.billing_email} />
          </Field>
          <Field label="Phone" name="phone">
            <Input name="phone" type="tel" defaultValue={customer?.phone} />
          </Field>
          <Field label="Payment terms (days)" name="payment_terms_days">
            <Input name="payment_terms_days" type="number" min={0} defaultValue={customer?.payment_terms_days ?? 14} />
          </Field>
          <Field label="Purchase order number" name="purchase_order_number"
                 hint="Printed on their invoices, if their accounts team needs one">
            <Input name="purchase_order_number" defaultValue={customer?.purchase_order_number} />
          </Field>
        </div>
      </Card>

      <Card title="Operational notes">
        <div className="grid gap-4">
          <Field label="Special instructions" name="special_instructions"
                 hint="Shown to drivers on every stop for this customer">
            <Textarea name="special_instructions" defaultValue={customer?.special_instructions} />
          </Field>
          <Field label="Internal notes" name="notes">
            <Textarea name="notes" defaultValue={customer?.notes} />
          </Field>
        </div>
      </Card>

      <FormActions>
        <SubmitButton>{submitLabel}</SubmitButton>
        <ButtonLink href={cancelHref}>Cancel</ButtonLink>
      </FormActions>
    </form>
  );
}
