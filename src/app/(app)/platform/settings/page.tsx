import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { Card, PageHeader } from "@/components/ui";
import { Checkbox, Field, Input, Select, SubmitButton, FormActions } from "@/components/form";
import { savePlatformSettings } from "../actions";
import { readPlatformSettings } from "../settings-shape";

export const metadata = { title: "Platform settings" };
export const dynamic = "force-dynamic";

const TIMEZONES = [
  // Adelaide leads because that is where this business is; the rest follow in
  // population order. The list is the same set either way — only the default
  // and the first thing an owner sees have moved.
  "Australia/Adelaide", "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
  "Australia/Perth", "Australia/Hobart", "Australia/Darwin",
].map((value) => ({ value, label: value.replace("Australia/", "") }));

export default async function PlatformSettingsPage() {
  await requireCapability("platform.write");

  const supabase = await createClient();
  const { data } = await supabase
    .from("platform_settings").select("settings").eq("id", true).maybeSingle();
  const settings = readPlatformSettings(data?.settings);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="How this deployment is set up, and the defaults a new laundry starts with. Each laundry can change its own afterwards — nothing here overrides a choice an owner has already made."
      />

      <form action={savePlatformSettings} className="space-y-6">
        {/* First, because it is the only switch here that changes what this
            deployment *is* rather than what a new laundry starts with. */}
        <Card
          title="This deployment"
          description="Whether the system runs one business or several."
        >
          <Checkbox
            name="single_laundry"
            label="Run one laundry only — refuse a second"
            defaultChecked={settings.single_laundry}
          />
          {/* Deliberately state-neutral: this sentence has to stay true whether
              the box is ticked or not, so it says what the switch does rather
              than what it is currently set to. */}
          <p className="mt-2 text-xs text-muted-foreground">
            While this is on, a second laundry is refused in the database as well as on the
            Laundries screen, so one cannot be added by any route. Turning it off restores the
            Add&nbsp;a&nbsp;laundry form and changes nothing else — records belonging to
            different laundries are kept apart by the same rules either way.
          </p>
        </Card>

        <Card
          title="New laundry defaults"
          description="Applied when you add a laundry on the Laundries screen. Existing ones are untouched."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Timezone" name="default_timezone"
                   hint="What their invoice periods and receipt times are composed in.">
              <Select name="default_timezone" defaultValue={settings.default_timezone}
                      options={TIMEZONES} />
            </Field>
            <Field label="GST rate" name="default_gst_rate"
                   hint="0.1 is the Australian 10%.">
              <Input name="default_gst_rate" type="number" step="0.0001" min="0" max="1"
                     defaultValue={settings.default_gst_rate} />
            </Field>
          </div>
        </Card>

        <Card
          title="Switches"
          description="What a new laundry has switched on the day it is created."
        >
          <Checkbox
            name="new_tenant_customer_emails"
            label="Email customers automatically — delivery confirmations and overdue reminders"
            defaultChecked={settings.new_tenant_customer_emails}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Off by default. Each laundry keeps its own switch under its own Settings, and
            changing this never touches a laundry that already exists.
          </p>
        </Card>

        <FormActions>
          <SubmitButton pendingLabel="Saving…">Save settings</SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
