"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, firstIssue, toObject } from "@/lib/actions";
import { emailIsConfigured, sendEmail } from "@/lib/email/send";
import { NOTIFICATION_KINDS, type NotificationKind } from "@/lib/notifications/kinds";
import {
  defaultSettings, parseSettings, serialiseSettings, DEFAULT_OVERDUE_REMINDER,
} from "@/lib/notifications/settings";

const BACK = "/admin/notifications";

/**
 * The reminder schedule is bounded here as well as in `parseSettings()`. The
 * form is the honest path in and Zod guards it; the parser guards the column,
 * which a future import or a hand-edit could also write to.
 */
const schema = z.object({
  delivery_confirmation: z.preprocess((v) => v === "on", z.boolean()),
  overdue_reminder: z.preprocess((v) => v === "on", z.boolean()),
  first_after_days: z.coerce.number().int()
    .min(0, "Use 0 or more days")
    .max(180, "180 days is the most this will wait"),
  repeat_every_days: z.coerce.number().int()
    .min(1, "Reminders cannot repeat more than once a day")
    .max(90, "90 days is the longest gap this will allow"),
  max_reminders: z.coerce.number().int()
    .min(1, "Send at least one reminder")
    .max(10, "Ten reminders is the most this will send"),
});

export async function saveNotificationSettings(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = schema.safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const supabase = await createClient();

  // Read-modify-write on one jsonb column. `settings` is shared with Phase D's
  // `ui_mode`, so the existing blob is merged rather than replaced — saving this
  // form must not silently reset a preference it does not show.
  const { data: tenant, error: readError } = await supabase
    .from("tenants").select("settings").eq("id", session.tenantId)
    .maybeSingle<{ settings: unknown }>();
  if (readError) return fail(BACK, describeDbError(readError));

  const settings = defaultSettings();
  const current = parseSettings(tenant?.settings);
  settings.inApp = current.inApp;

  // An unchecked checkbox posts nothing at all, so every kind is read from the
  // form explicitly rather than by iterating what arrived.
  for (const kind of NOTIFICATION_KINDS) {
    settings.inApp[kind as NotificationKind] = formData.get(`in_app_${kind}`) === "on";
  }

  settings.customerEmail = {
    deliveryConfirmation: parsed.data.delivery_confirmation,
    overdueReminder: {
      enabled: parsed.data.overdue_reminder,
      firstAfterDays: parsed.data.first_after_days,
      repeatEveryDays: parsed.data.repeat_every_days,
      maxReminders: parsed.data.max_reminders,
    },
  };

  const { error } = await supabase
    .from("tenants")
    .update({ settings: serialiseSettings(settings, tenant?.settings) })
    .eq("id", session.tenantId);
  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId, action: "update",
    summary: "notification settings updated",
    metadata: { notifications: settings },
  });

  revalidatePath(BACK);
  return done(BACK, "Notification settings saved.");
}

/**
 * Prove the mail provider works, from the deployment that will actually use it
 * (roadmap C0).
 *
 * The Resend path had never been exercised against the provider — and it cannot
 * be from a development container, whose network policy refuses
 * `api.resend.com` outright. So the check ships as something an administrator
 * runs from the running app: one real send, to their own address, through the
 * same `sendEmail()` the invoice and reminder paths use.
 *
 * It sends to the signed-in user and nowhere else. An arbitrary "to" field here
 * would make the app a small open relay for anyone holding an admin login.
 */
export async function sendTestEmail(): Promise<void> {
  const session = await assertCapability("admin.write");

  if (!session.email) {
    return fail(BACK, "Your login has no email address, so there is nowhere to send the test.");
  }
  if (!emailIsConfigured()) {
    return fail(
      BACK,
      "No email provider is configured for this deployment, so nothing can be sent yet.",
    );
  }

  const result = await sendEmail({
    to: session.email,
    subject: `${session.tenantName} — email delivery test`,
    html: "<p>This is a test from LaundryMart. If you are reading it, invoice emails, "
      + "delivery confirmations and overdue reminders can reach your customers.</p>",
    text: "This is a test from LaundryMart. If you are reading it, invoice emails, "
      + "delivery confirmations and overdue reminders can reach your customers.",
  });

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId,
    action: result.ok ? "send" : "send_failed",
    summary: result.ok ? `test email sent to ${session.email}` : `test email failed: ${result.error}`,
  });

  if (!result.ok) return fail(BACK, `The test could not be sent. ${result.error}`);
  return done(BACK, `Test email sent to ${session.email}. Check your inbox.`);
}

/** Back to the shipped defaults, including the owner's reminder schedule. */
export async function resetNotificationSettings(): Promise<void> {
  const session = await assertCapability("admin.write");
  const supabase = await createClient();

  const { data: tenant } = await supabase
    .from("tenants").select("settings").eq("id", session.tenantId)
    .maybeSingle<{ settings: unknown }>();

  const settings = defaultSettings();
  settings.customerEmail.overdueReminder = { ...DEFAULT_OVERDUE_REMINDER };

  const { error } = await supabase
    .from("tenants")
    .update({ settings: serialiseSettings(settings, tenant?.settings) })
    .eq("id", session.tenantId);
  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId, action: "update",
    summary: "notification settings reset to defaults",
  });

  revalidatePath(BACK);
  return done(BACK, "Back to the default settings — customer emails are off again.");
}
