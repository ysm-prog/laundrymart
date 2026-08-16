/**
 * The swept check: notifications for things that happen by the passage of time
 * rather than by somebody doing something (AD-4, roadmap C2/C3).
 *
 * Two events no server action can raise, because nobody is there when they
 * occur — an invoice passing its terms, and a run still sitting at the depot
 * past its start window — plus the overdue-chase email that rides the same
 * schedule.
 *
 * Shape of the thing:
 * - **No session.** Vercel Cron is not a user. Authorisation is a shared secret
 *   in the `Authorization` header, and the route refuses everything when that
 *   secret is unset — an open cron endpoint that enumerates every tenant's
 *   overdue invoices is a far worse failure than a cron that never runs.
 * - **Service-role client, so RLS is not watching.** Every query filters
 *   `tenant_id` from the row being iterated. The tenant list comes from the
 *   database, never from the request: there is no tenant parameter to abuse.
 * - **Idempotent.** Notification rows collide on
 *   `(tenant_id, kind, subject_id, occurred_on)` and are dropped, and
 *   `occurred_on` is the day the *event* belongs to (the invoice's due date,
 *   the run's date) rather than the day the sweep ran. So running twice, or
 *   running late, or replaying by hand, produces exactly one notification per
 *   thing — not one per day it stayed broken.
 * - **One tenant's failure does not stop the rest.** Each tenant is wrapped.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { today } from "@/lib/format";
import { notifyTenant } from "@/lib/notifications/notify";
import { parseSettings, reminderDue, type NotificationSettings } from "@/lib/notifications/settings";
import {
  CHASEABLE_STATUSES, NOT_STARTED_STATUSES,
  daysBetween, minutesOfDayIn, runIsLate,
} from "@/lib/notifications/sweep-rules";
import { sendEmail, emailIsConfigured } from "@/lib/email/send";
import { buildOverdueEmail } from "@/lib/email/overdue-email";

/** Never prerendered, never cached: it is a scheduled side effect. */
export const dynamic = "force-dynamic";

type AdminClient = ReturnType<typeof createAdminClient>;

type Tenant = { id: string; name: string; settings: unknown };

type OverdueInvoice = {
  id: string;
  invoice_number: string;
  due_date: string;
  balance: number | string;
  currency: string | null;
  customers: { business_name: string; billing_email: string | null } | null;
};

type PendingRoute = {
  id: string;
  code: string;
  name: string;
  route_date: string;
  driver_id: string | null;
  route_templates: { planned_start_time: string | null } | null;
};

type Tally = { notifications: number; emails: number; emailFailures: number };

function authorised(request: NextRequest): boolean {
  const secret = env.CRON_SECRET;
  // Closed by default. A missing secret means "not configured", and an
  // unconfigured cron endpoint must not be a public one.
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/* ------------------------------------------------------------ invoices --- */

async function sweepOverdueInvoices(
  admin: AdminClient,
  tenant: Tenant,
  settings: NotificationSettings,
  businessDay: string,
  tally: Tally,
): Promise<void> {
  // `invoices` has one FK to `customers`, so this embed is unambiguous.
  const { data, error } = await admin
    .from("invoices")
    .select("id, invoice_number, due_date, balance, currency, customers(business_name, billing_email)")
    .eq("tenant_id", tenant.id)
    .in("status", CHASEABLE_STATUSES)
    .is("deleted_at", null)
    // The archive (0017) hides rows with a *policy*, and this route runs on the
    // service-role client, which is the one client policies do not apply to. So
    // the filter that every other reader gets for free has to be written here,
    // or a tenant that hid its records would still be chased about them — and
    // the notification would link to an invoice nobody can open.
    .is("archived_at", null)
    .not("due_date", "is", null)
    .lt("due_date", businessDay)
    .gt("balance", 0)
    .order("due_date", { ascending: true })
    .limit(500)
    .returns<OverdueInvoice[]>();

  if (error || !data || data.length === 0) return;

  for (const invoice of data) {
    // `occurred_on` is the due date, so an invoice raises its notification once
    // and not once a day for as long as it stays unpaid.
    await notifyTenant(admin, tenant.id, settings, {
      kind: "invoice_overdue",
      subjectId: invoice.id,
      occurredOn: invoice.due_date,
      title: `Invoice ${invoice.invoice_number} for `
        + `${invoice.customers?.business_name ?? "a customer"} has passed its payment terms.`,
      href: `/invoices?selected=${invoice.id}`,
    });
    tally.notifications += 1;
  }

  await chaseOverdueInvoices(admin, tenant, settings, businessDay, data, tally);
}

/**
 * The customer-facing half: the reminder email, on the owner's schedule.
 *
 * Guarded against a double send by the audit trail rather than by the
 * notifications table, because a reminder is not a notification — it recurs,
 * and each occurrence is a distinct thing that either did or did not leave the
 * building. The audit row is written for both outcomes anyway (C3: "every send
 * audited"), so reading it back costs one indexed query per tenant.
 */
async function chaseOverdueInvoices(
  admin: AdminClient,
  tenant: Tenant,
  settings: NotificationSettings,
  businessDay: string,
  invoices: OverdueInvoice[],
  tally: Tally,
): Promise<void> {
  const reminder = settings.customerEmail.overdueReminder;
  if (!reminder.enabled || !emailIsConfigured()) return;

  // Which reminder, if any, falls due for each invoice today.
  const candidates = invoices
    .map((invoice) => ({
      invoice,
      daysOverdue: daysBetween(invoice.due_date, businessDay),
    }))
    .map((entry) => ({ ...entry, sequence: reminderDue(entry.daysOverdue, reminder) }))
    .filter((entry): entry is typeof entry & { sequence: number } => entry.sequence !== null);

  if (candidates.length === 0) return;

  // One read to find what has already gone out, rather than one per invoice.
  const { data: sent } = await admin
    .from("audit_logs")
    .select("entity_id, metadata")
    .eq("tenant_id", tenant.id)
    .eq("entity", "invoice")
    .eq("action", "send")
    .in("entity_id", candidates.map((entry) => entry.invoice.id))
    .returns<{ entity_id: string; metadata: Record<string, unknown> | null }[]>();

  const alreadySent = new Set(
    (sent ?? [])
      .filter((row) => typeof row.metadata?.reminder === "number")
      .map((row) => `${row.entity_id}:${row.metadata?.reminder}`),
  );

  for (const { invoice, daysOverdue, sequence } of candidates) {
    if (alreadySent.has(`${invoice.id}:${sequence}`)) continue;

    const recipient = invoice.customers?.billing_email;
    if (!recipient) continue;

    const { subject, html, text } = buildOverdueEmail({
      tenantName: tenant.name,
      customerName: invoice.customers?.business_name ?? "there",
      invoiceNumber: invoice.invoice_number,
      balance: Number(invoice.balance ?? 0),
      currency: invoice.currency ?? "AUD",
      dueDate: invoice.due_date,
      daysOverdue,
      sequence,
    });

    const result = await sendEmail({ to: recipient, subject, html, text });

    // No session here, so `recordAudit()` (which needs one) is not the tool;
    // the row is written directly with a null actor — nobody did this, a clock did.
    await admin.from("audit_logs").insert({
      tenant_id: tenant.id,
      actor_id: null,
      entity: "invoice",
      entity_id: invoice.id,
      action: result.ok ? "send" : "send_failed",
      summary: result.ok
        ? `overdue reminder ${sequence} sent to ${recipient}`
        : `overdue reminder ${sequence} to ${recipient} failed: ${result.error}`,
      // `reminder` is the idempotency marker the next sweep reads back. It is
      // only written on success, so a bounced reminder is retried tomorrow
      // rather than silently counted as delivered.
      metadata: result.ok ? { reminder: sequence, providerId: result.id } : { attempted: sequence },
    });

    if (result.ok) tally.emails += 1;
    else tally.emailFailures += 1;
  }
}

/* -------------------------------------------------------------- routes --- */

async function sweepLateRuns(
  admin: AdminClient,
  tenant: Tenant,
  settings: NotificationSettings,
  businessDay: string,
  nowMinutes: number,
  tally: Tally,
): Promise<void> {
  // `daily_routes` has one FK to `route_templates`, so this embed needs no
  // constraint name — unlike its two FKs to `vehicles` (CLAUDE.md §10b).
  const { data, error } = await admin
    .from("daily_routes")
    .select("id, code, name, route_date, driver_id, route_templates(planned_start_time)")
    .eq("tenant_id", tenant.id)
    .eq("route_date", businessDay)
    .in("status", NOT_STARTED_STATUSES)
    .is("deleted_at", null)
    .limit(500)
    .returns<PendingRoute[]>();

  if (error || !data) return;

  for (const route of data) {
    if (!runIsLate(route.route_templates?.planned_start_time, nowMinutes)) continue;

    await notifyTenant(admin, tenant.id, settings, {
      kind: "run_not_started",
      subjectId: route.id,
      occurredOn: route.route_date,
      // Said without the run code, and pointed at the driver's day rather than
      // at the run record: the office no longer opens runs, and a notification
      // is a poor place to reintroduce a vocabulary the app has dropped.
      title: route.driver_id
        ? "A driver has not left the depot and is past their start time."
        : "Deliveries for today have not left the depot and are past the start time.",
      href: route.driver_id
        ? `/my-runs?date=${route.route_date}&driver=${route.driver_id}`
        : `/orders?assigned=${route.route_date}&run=assigned`,
    });
    tally.notifications += 1;
  }
}

/* --------------------------------------------------------------- entry --- */

export async function GET(request: NextRequest) {
  if (!authorised(request)) {
    // Deliberately identical whether the secret is unset or simply wrong: the
    // response should not tell a prober which it was.
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  const admin = createAdminClient();
  const businessDay = today();
  const nowMinutes = minutesOfDayIn(new Date());

  const { data: tenants, error } = await admin
    .from("tenants")
    .select("id, name, settings")
    .returns<Tenant[]>();

  if (error) {
    console.error("notification sweep could not list tenants", error.message);
    return NextResponse.json({ error: "Sweep failed." }, { status: 500 });
  }

  const tally: Tally = { notifications: 0, emails: 0, emailFailures: 0 };
  let swept = 0;

  for (const tenant of tenants ?? []) {
    try {
      const settings = parseSettings(tenant.settings);
      await sweepOverdueInvoices(admin, tenant, settings, businessDay, tally);
      await sweepLateRuns(admin, tenant, settings, businessDay, nowMinutes, tally);
      swept += 1;
    } catch (cause) {
      // One tenant's bad data must not cost every other tenant their sweep.
      console.error("notification sweep failed for a tenant", { tenantId: tenant.id, cause });
    }
  }

  return NextResponse.json({ tenants: swept, day: businessDay, ...tally }, { status: 200 });
}
