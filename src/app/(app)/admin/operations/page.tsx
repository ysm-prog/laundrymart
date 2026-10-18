import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { Card, FormSection, PageHeader } from "@/components/ui";
import { Checkbox, Field, Input, SubmitButton } from "@/components/form";
import {
  TURNAROUND_MAX, TURNAROUND_MIN, parseOperations,
} from "@/lib/domain/operations-settings";
import { saveOperationsSettings } from "./actions";

export const metadata = { title: "How you work" };

/**
 * Two answers about how this laundry runs (brief 3.4 and 3.9): when a job is
 * promised back if the customer has no round, and whether the plant screens
 * are shown at all.
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
                  description="When laundry is promised back, and which parts of the app you use." />
      <Card>
        <form action={saveOperationsSettings} className="space-y-6">
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
