import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { emailIsConfigured } from "@/lib/email/send";
import { NOTIFICATION_EVENTS, NOTIFICATION_KINDS } from "@/lib/notifications/kinds";
import { parseSettings } from "@/lib/notifications/settings";
import { Card, Eyebrow, Notice, PageHeader } from "@/components/ui";
import { Checkbox, Field, FormActions, Input, SubmitButton } from "@/components/form";
import { resetNotificationSettings, saveNotificationSettings, sendTestEmail } from "./actions";

export const metadata = { title: "Notification settings" };

/**
 * Tenant-level notification preferences (roadmap C4), stored in the single
 * `tenants.settings` jsonb column added by 0013.
 *
 * Two channels, and they are not the same kind of decision:
 * - **In-app** is for staff, defaults on, and costs a glance.
 * - **Customer email** leaves the building under the tenant's name, defaults
 *   off, and says so.
 *
 * Staff email is deliberately not offered. Sending it would mean resolving every
 * member's address for a capability on each event, and a switch that looks like
 * it sends mail but does not is worse than no switch.
 */
export default async function NotificationSettingsPage() {
  const session = await requireCapability("admin.write");

  const supabase = await createClient();
  const { data: tenant } = await supabase
    .from("tenants").select("settings").eq("id", session.tenantId)
    .maybeSingle<{ settings: unknown }>();

  const settings = parseSettings(tenant?.settings);
  const reminder = settings.customerEmail.overdueReminder;
  const mailReady = emailIsConfigured();

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="What the app tells you"
        description="Choose which events raise a notification, and whether your customers hear from us automatically."
      />

      {!mailReady ? (
        <div className="mb-4">
          <Notice tone="warning" title="No email provider is set up yet">
            The customer emails below can be switched on, but nothing will send until an
            email provider is configured for this deployment. Ask whoever manages the
            deployment to set <code className="font-mono">RESEND_API_KEY</code> and{" "}
            <code className="font-mono">INVOICE_FROM_EMAIL</code>.
          </Notice>
        </div>
      ) : null}

      <form action={saveNotificationSettings} className="space-y-4">
        <Card
          title="Notifications in the app"
          description="These appear in the bell at the top of the screen, for the people who can act on them."
        >
          <ul className="space-y-3">
            {NOTIFICATION_KINDS.map((kind) => {
              const event = NOTIFICATION_EVENTS[kind];
              return (
                <li key={kind} className="border-b pb-3 last:border-0 last:pb-0">
                  <Checkbox
                    name={`in_app_${kind}`}
                    label={event.label}
                    defaultChecked={settings.inApp[kind]}
                  />
                  <p className="mt-1 pl-5.5 text-xs text-muted-foreground">{event.description}</p>
                  <p className="mt-1 pl-5.5">
                    <Eyebrow>Shown to anyone who can {event.audience.replace(".", " ")}</Eyebrow>
                  </p>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card
          title="Emails to your customers"
          description="These go out under your business's name, without anyone pressing send. Both are off until you turn them on."
        >
          <div className="space-y-4">
            <div>
              <Checkbox
                name="delivery_confirmation"
                label="Confirm each delivery to the customer"
                defaultChecked={settings.customerEmail.deliveryConfirmation}
              />
              <p className="mt-1 pl-5.5 text-xs text-muted-foreground">
                When a driver completes a drop-off, the customer gets what was delivered,
                who signed for it, and the photos and signature captured at the stop.
                Sent to the customer&rsquo;s billing email; customers without one are skipped.
              </p>
            </div>

            <div className="border-t pt-4">
              <Checkbox
                name="overdue_reminder"
                label="Remind customers about overdue invoices"
                defaultChecked={reminder.enabled}
              />
              <p className="mt-1 pl-5.5 text-xs text-muted-foreground">
                A friendly nudge naming the invoice, the amount and how late it is —
                no threats, no payment link. Void and paid invoices are never chased.
              </p>

              <div className="mt-3 grid gap-3 pl-5.5 sm:grid-cols-3">
                <Field
                  label="First reminder"
                  name="first_after_days"
                  hint="Days after the due date."
                >
                  <Input name="first_after_days" type="number" min={0} max={180}
                         inputMode="numeric" defaultValue={reminder.firstAfterDays} required />
                </Field>
                <Field label="Then every" name="repeat_every_days" hint="Days between reminders.">
                  <Input name="repeat_every_days" type="number" min={1} max={90}
                         inputMode="numeric" defaultValue={reminder.repeatEveryDays} required />
                </Field>
                <Field
                  label="Stop after"
                  name="max_reminders"
                  hint="Reminders in total, then it&rsquo;s a phone call."
                >
                  <Input name="max_reminders" type="number" min={1} max={10}
                         inputMode="numeric" defaultValue={reminder.maxReminders} required />
                </Field>
              </div>
            </div>
          </div>
        </Card>

        <FormActions>
          <SubmitButton>Save settings</SubmitButton>
        </FormActions>
      </form>

      <div className="mt-4">
        <Card
          title="Check email is working"
          description="Sends one real email to your own address, through the same provider the invoices and reminders use. Do this once before switching the customer emails on."
        >
          <form action={sendTestEmail}>
            <SubmitButton variant="secondary" pendingLabel="Sending…">
              Send a test email to {session.email ?? "me"}
            </SubmitButton>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            A test proves the provider can be reached. To prove the whole path, also
            email one real invoice from its own page — that one carries the PDF.
          </p>
        </Card>
      </div>

      <div className="mt-4">
        <Card
          title="Start again"
          description="Puts every event back on, switches both customer emails off, and restores the default reminder schedule."
        >
          <form action={resetNotificationSettings}>
            <SubmitButton variant="secondary" pendingLabel="Resetting…">
              Reset to defaults
            </SubmitButton>
          </form>
        </Card>
      </div>
    </>
  );
}
