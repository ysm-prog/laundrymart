import { Checkbox, Field, FormActions, Input, Select, SubmitButton, Textarea } from "@/components/form";
import { ButtonLink, Card } from "@/components/ui";
import { HOLIDAY_RULE_LABELS, HOLIDAY_RULES, parsePattern } from "@/lib/domain/service-calendar";
import type { CustomerLocation, Depot, ServiceAgreement } from "@/lib/db/types";
import { PatternFields } from "./pattern-fields";

const REGIONS = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]
  .map((value) => ({ value, label: value }));

export function AgreementForm({
  action, agreement, customers, locations, depots, defaultCustomerId, cancelHref, submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  agreement?: ServiceAgreement;
  customers: Array<{ id: string; business_name: string; customer_number: string }>;
  locations: Pick<CustomerLocation, "id" | "name" | "customer_id">[];
  depots: Pick<Depot, "id" | "name">[];
  defaultCustomerId?: string;
  cancelHref: string;
  submitLabel: string;
}) {
  return (
    <form action={action} className="space-y-4">
      {agreement ? <input type="hidden" name="id" value={agreement.id} /> : null}

      <Card title="Parties and term">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer" name="customer_id" required>
            <Select
              name="customer_id" required placeholder="Choose a customer"
              defaultValue={agreement?.customer_id ?? defaultCustomerId}
              options={customers.map((customer) => ({
                value: customer.id,
                label: `${customer.business_name} (${customer.customer_number})`,
              }))}
            />
          </Field>
          <Field label="Site" name="location_id" hint="Leave blank to cover every site">
            <Select
              name="location_id" placeholder="All sites"
              defaultValue={agreement?.location_id}
              options={locations.map((location) => ({ value: location.id, label: location.name }))}
            />
          </Field>
          <Field label="Depot" name="depot_id">
            <Select name="depot_id" placeholder="Unassigned"
                    options={depots.map((depot) => ({ value: depot.id, label: depot.name }))} />
          </Field>
          <Field label="Linen ownership" name="linen_ownership">
            <Select name="linen_ownership" defaultValue={agreement?.linen_ownership ?? "rental"} options={[
              { value: "rental", label: "Rental (laundry owned)" },
              { value: "customer_owned", label: "Customer owned" },
              { value: "mixed", label: "Mixed" },
            ]} />
          </Field>
          <Field label="Start date" name="start_date" required>
            <Input name="start_date" type="date" required defaultValue={agreement?.start_date} />
          </Field>
          <Field label="End date" name="end_date" hint="Leave blank for an open-ended contract">
            <Input name="end_date" type="date" defaultValue={agreement?.end_date} />
          </Field>
        </div>
      </Card>

      <Card title="Service pattern"
            description="Drives both route generation and what gets billed, so it has to match reality.">
        <div className="grid gap-4 lg:grid-cols-2">
          <PatternFields prefix="pickup" legend="Pickup days"
                         value={agreement ? parsePattern(agreement.pickup_pattern) : undefined} />
          <PatternFields prefix="delivery" legend="Delivery days"
                         value={agreement ? parsePattern(agreement.delivery_pattern) : undefined} />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Collections per visit" name="collections_per_visit">
            <Input name="collections_per_visit" type="number" min={1}
                   defaultValue={agreement?.collections_per_visit ?? 1} />
          </Field>
          <Field label="Public holiday rule" name="holiday_rule">
            <Select name="holiday_rule" defaultValue={agreement?.holiday_rule ?? "next_business_day"}
                    options={HOLIDAY_RULES.map((value) => ({ value, label: HOLIDAY_RULE_LABELS[value] }))} />
          </Field>
          <Field label="Holiday region" name="holiday_region">
            <Select name="holiday_region" options={REGIONS} defaultValue={agreement?.holiday_region ?? "NSW"} />
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox name="emergency_service" label="Emergency service available"
                      defaultChecked={agreement?.emergency_service} />
          </div>
        </div>
      </Card>

      <Card title="Commercial terms">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Minimum charge" name="minimum_charge"
                 hint="Tops the period up when service falls short">
            <Input name="minimum_charge" type="number" step="0.01" min={0}
                   defaultValue={agreement?.minimum_charge ?? 0} />
          </Field>
          <Field label="Fuel levy %" name="fuel_levy_pct">
            <Input name="fuel_levy_pct" type="number" step="0.01" min={0} max={100}
                   defaultValue={agreement?.fuel_levy_pct ?? 0} />
          </Field>
          <Field label="Weekend surcharge %" name="weekend_surcharge_pct">
            <Input name="weekend_surcharge_pct" type="number" step="0.01" min={0} max={100}
                   defaultValue={agreement?.weekend_surcharge_pct ?? 0} />
          </Field>
          <Field label="Holiday surcharge %" name="holiday_surcharge_pct">
            <Input name="holiday_surcharge_pct" type="number" step="0.01" min={0} max={100}
                   defaultValue={agreement?.holiday_surcharge_pct ?? 0} />
          </Field>
          <Field label="Billing frequency" name="billing_frequency">
            <Select name="billing_frequency" defaultValue={agreement?.billing_frequency ?? "monthly"} options={[
              { value: "per_service", label: "Per service" },
              { value: "weekly", label: "Weekly" },
              { value: "fortnightly", label: "Fortnightly" },
              { value: "monthly", label: "Monthly" },
            ]} />
          </Field>
          <Field label="Payment terms (days)" name="payment_terms_days">
            <Input name="payment_terms_days" type="number" min={0}
                   defaultValue={agreement?.payment_terms_days ?? 14} />
          </Field>
          <Field label="Purchase order number" name="purchase_order_number">
            <Input name="purchase_order_number" defaultValue={agreement?.purchase_order_number} />
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Notes" name="notes">
            <Textarea name="notes" defaultValue={agreement?.notes} />
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
