import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { Card, FormSection, PageHeader } from "@/components/ui";
import { Checkbox, Field, Input, Select, SubmitButton } from "@/components/form";
import {
  TURNAROUND_MAX, TURNAROUND_MIN, WORKFLOWS, WORKFLOW_LABELS, parseOperations,
} from "@/lib/domain/operations-settings";
import { saveOperationsSettings } from "./actions";

export const metadata = { title: "How you work" };

/**
 * Three answers about how this laundry runs: whether a new job walks the whole
 * delivery process or is finished on save (change request 3), when a job is
 * promised back if the customer has no round (brief 3.4), and whether the plant
 * screens are shown at all (brief 3.9).
 */
export default async function OperationsSettingsPage() {
  const session = await requireCapability("admin.write");
  const supabase = await createClient();
  const { data: tenant } = await supabase
    .from("tenants").select("settings").eq("id", session.tenantId)
    .maybeSingle<{ settings: unknown }>();
  const operations = parseOperations(tenant?.settings);

  return (
    <div className="space-y-6">
      <PageHeader title="How you work"
                  description="How a job reaches invoicing, when laundry is promised back, and which parts of the app you use." />
      <Card>
        <form action={saveOperationsSettings} className="space-y-6">
          <FormSection title="Workflow"
                       description="How a laundry job gets from being taken in to being ready to invoice. Changing this never moves a job you already have, and nothing about rounds, drivers or delivery is removed — switch back to Full when you start running deliveries through the app.">
            <Field label="When a job is saved" name="workflow"
                   hint="Simplified: the job is completed and goes straight to Awaiting invoice. You still create and send the invoice yourself.">
              <Select name="workflow" defaultValue={operations.workflow}
                      options={WORKFLOWS.map((value) => ({ value, label: WORKFLOW_LABELS[value] }))} />
            </Field>
          </FormSection>
          <FormSection title="Taking laundry in"
                       description="A customer on a round gets their round's next delivery day. Everyone else gets this.">
            <Field label="Days until it is back" name="defaultTurnaroundDays"
                   hint={`A whole number, ${TURNAROUND_MIN} to ${TURNAROUND_MAX}. Sundays and public holidays are skipped.`}>
              <Input name="defaultTurnaroundDays" type="number" inputMode="numeric"
                     min={TURNAROUND_MIN} max={TURNAROUND_MAX}
                     defaultValue={String(operations.defaultTurnaroundDays)} />
            </Field>
          </FormSection>
          <FormSection title="The plant"
                       description="Batches through washing, drying, folding and packing. Leave this off until you record batches — the screens are empty until you do.">
            <Checkbox name="plantStages" defaultChecked={operations.plantStages}
                      label="Show the plant screens, and the plant figures on Today" />
          </FormSection>
          <SubmitButton variant="secondary" size="md" pendingLabel="Saving…">Save</SubmitButton>
        </form>
      </Card>
    </div>
  );
}
