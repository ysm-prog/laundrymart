"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  describeDbError, done, fail, firstIssue, optionalText, returnTo, toObject,
} from "@/lib/actions";
import { checkBillingTransition } from "@/lib/domain/billing";
import { jobChargeSubtotal } from "@/lib/domain/job-pricing";
import { money } from "@/lib/format";
import { logOrderActivity } from "@/lib/orders/activity";
import {
  loadJobCharges, loadJobForBilling, priceAndSaveJob, saveJobCharges,
} from "@/lib/orders/job-billing";
import { approveAndPlaceJob } from "@/lib/orders/approve";
import { describePlacementOutcome } from "@/lib/domain/placement";
import { parseJobCharges } from "./job-charges";

/**
 * The money half of a job: price it, review it, approve it — or write it off.
 *
 * Kept apart from `orders/actions.ts` because the capabilities in front of these
 * are different in kind. That file is the counter's and the floor's
 * (`orders.write` / `orders.status`); this one is finance's (`billing.write`,
 * `invoices.approve`), and the roles holding one hold none of the other.
 *
 * Two rules run through everything here:
 *
 * - **Completing a job never bills anybody.** That stamp is made by the
 *   database (`guard_laundry_order_transition`, 0017), which sets
 *   `awaiting_review` and stops. Nothing in this file is reachable from the
 *   operational workflow.
 * - **Approval is the freeze.** Up to that moment the charges are a draft that
 *   can be re-priced or edited; after it, `job_charge_snapshots.frozen_at` is
 *   set and the trigger refuses every write. Correcting an approved job is a
 *   credit note, which is a record of the correction rather than a quiet
 *   overwrite of what the customer was told.
 */

const LIST = "/invoices/awaiting";
const DRAFTS = "/invoices/drafts";

/** Where these actions bounce back to — the job, or the queue they were run from. */
function backTo(formData: FormData, orderId: string): string {
  return returnTo(formData, `/orders/${orderId}`);
}

/* ------------------------------------------------------------- price it --- */

/**
 * (Re-)price a job from its customer's current rates.
 *
 * Deliberately a button rather than something that happens on completion. A job
 * completes when the driver hands it over, which may be days before anybody
 * looks at the money, and pricing at that instant would freeze a rate card
 * nobody had checked. Pricing on demand means the reviewer sees today's rates
 * and can say so.
 *
 * The rules live in `priceAndSaveJob`, shared with Price Selected on the queue.
 * Everything here is the sentence the operator reads back.
 */
export async function priceJobCharges(formData: FormData): Promise<void> {
  const session = await assertCapability("billing.write");
  const parsed = z.object({ id: z.string().uuid() }).safeParse(toObject(formData));
  if (!parsed.success) return fail(LIST, firstIssue(parsed.error));

  const back = backTo(formData, parsed.data.id);
  const supabase = await createClient();

  const priced = await priceAndSaveJob(supabase, session, parsed.data.id);

  // A refusal names the screen that fixes it, and which screen that is depends
  // on which tier is missing: a customer with a rate card that does not cover
  // the laundry is a rate-card problem, and one without a card is a price-list
  // problem. Neither is "add it by hand", though that stays available in the
  // editor above the button.
  if (!priced.ok) {
    const link = priced.card
      ? { href: `/agreements/${priced.card.id}`, label: "Open the rate card" }
      : { href: "/invoices/prices", label: "Set your laundry prices" };
    return fail(back, priced.error, priced.customerId ? link : undefined);
  }

  revalidatePath(`/orders/${parsed.data.id}`);
  revalidatePath(LIST);

  // The gap is said out loud rather than left for the reviewer to notice. It is
  // a success — the rest of the job *was* priced — so it is a `done` with a
  // caveat, not a failure that would have thrown the priced lines away.
  const gap = priced.unpriced > 0
    ? ` ${priced.unpriced} item(s) had no rate on the card or the price list and were not priced.`
    : "";
  return done(back, `Priced ${priced.lines} charge(s) from ${priced.source}.${gap}`);
}

/* -------------------------------------------------------------- edit it --- */

/** Save the reviewer's own edits to the charge lines. */
export async function updateJobCharges(formData: FormData): Promise<void> {
  const session = await assertCapability("billing.write");
  const parsed = z.object({ id: z.string().uuid() }).safeParse(toObject(formData));
  if (!parsed.success) return fail(LIST, firstIssue(parsed.error));

  const back = backTo(formData, parsed.data.id);
  const supabase = await createClient();

  const job = await loadJobForBilling(supabase, parsed.data.id);
  if (!job) return fail(LIST, "That job could not be found.");
  if (job.billing_status !== "awaiting_review") {
    return fail(back, "These charges have been approved and can no longer be changed.");
  }

  // A parse fault says it is a parse fault. Degrading to an empty list here
  // would wipe a job's charges and report success, which is the worst possible
  // outcome of a payload the reader could not understand.
  const charges = parseJobCharges(formData.get("charges"));
  if (!charges.ok) return fail(back, charges.problem);

  const saved = await saveJobCharges(supabase, session.tenantId, job.id, charges.lines);
  if (!saved.ok) return fail(back, saved.error);

  await logOrderActivity(supabase, session, job.id, {
    activity_type: "updated",
    next: {
      billing: "charges edited",
      lines: charges.lines.length,
      subtotal: jobChargeSubtotal(charges.lines),
    },
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: job.id, action: "update",
    summary: `${job.order_number}: charges edited`,
    metadata: { lines: charges.lines.length, subtotal: jobChargeSubtotal(charges.lines) },
  });

  revalidatePath(`/orders/${job.id}`);
  revalidatePath(LIST);
  // "before GST" until 2026-09-01, which was wrong: a charge amount becomes an
  // invoice line amount unchanged, and since 0043 a line amount is GST-inclusive.
  return done(back, `Charges saved — ${money(jobChargeSubtotal(charges.lines))}, GST included.`);
}

/* ----------------------------------------------------------- approve it --- */

/**
 * Approve a job's charges. This is the freeze.
 *
 * Its own capability (`invoices.approve`), separate from `invoices.write`:
 * raising a draft and signing off the price a customer will be held to are
 * different decisions, and the brief asks for exactly that split.
 *
 * **Approving also puts the charges on the customer's invoice**, which is the
 * owner's flow and the step this app did not have: the charge used to be frozen
 * and then sit in a queue waiting for somebody to come back and press Generate.
 * `approveAndPlaceJob` holds both halves and the rule that a failed placement
 * never un-approves the job — see `lib/orders/approve.ts`.
 */
export async function approveJobCharges(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.approve");
  const parsed = z.object({ id: z.string().uuid() }).safeParse(toObject(formData));
  if (!parsed.success) return fail(LIST, firstIssue(parsed.error));

  const back = backTo(formData, parsed.data.id);
  const supabase = await createClient();

  const result = await approveAndPlaceJob(supabase, session, parsed.data.id);
  if (!result.ok) return fail(back, result.error);

  revalidatePath(`/orders/${parsed.data.id}`);
  revalidatePath(LIST);
  revalidatePath(DRAFTS);
  revalidatePath("/invoices");

  const summary = `Job ${result.orderNumber} approved at ${money(result.subtotal)}, GST included.`
    + describePlacementOutcome(result.placement);

  // A placement that did not happen is reported as a failure even though the
  // approval stood, because it is the half nobody can see: the job leaves the
  // review list either way, and an invoice that was never raised looks exactly
  // like one that was.
  if (result.placement.kind === "failed") return fail(back, summary);

  return done(back, summary, result.placement.kind === "placed"
    ? { href: `/invoices/${result.placement.invoiceId}`, label: "Open the invoice" }
    : undefined);
}

/* ------------------------------------------------------- send it back ----- */

/**
 * Put an approved job back in front of the reviewer.
 *
 * The charges stay frozen — `frozen_at` is never cleared, because a number that
 * was once approved is a fact about what somebody signed off. Sending back means
 * "this needs looking at again", and re-pricing then writes fresh rows.
 */
export async function reopenJobCharges(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.approve");
  const parsed = z.object({
    id: z.string().uuid(),
    note: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(LIST, firstIssue(parsed.error));

  const back = backTo(formData, parsed.data.id);
  const supabase = await createClient();

  const job = await loadJobForBilling(supabase, parsed.data.id);
  if (!job) return fail(LIST, "That job could not be found.");

  const charges = await loadJobCharges(supabase, parsed.data.id);
  const allowed = checkBillingTransition(job.billing_status, "awaiting_review", {
    operationalStatus: job.status, chargeCount: charges.length,
  });
  if (!allowed.ok) return fail(back, allowed.reason);

  const { error } = await supabase
    .from("laundry_orders")
    .update({ billing_status: "awaiting_review", billing_approved_at: null, billing_approved_by: null })
    .eq("id", parsed.data.id)
    .eq("tenant_id", session.tenantId)
    .eq("billing_status", "approved");
  if (error) return fail(back, describeDbError(error));

  // The frozen lines are cleared here rather than left in place: the guard
  // refuses to overwrite a frozen row, so leaving them would make the job
  // un-repriceable and stick it in review forever. Deleting them is safe
  // precisely because nothing has been invoiced yet — that is what
  // `approved → awaiting_review` means.
  const { error: clearError } = await supabase
    .from("job_charge_snapshots")
    .delete()
    .eq("order_id", parsed.data.id)
    .eq("tenant_id", session.tenantId);
  if (clearError) return fail(back, describeDbError(clearError));

  await logOrderActivity(supabase, session, parsed.data.id, {
    activity_type: "status_changed",
    previous: { billing_status: "approved" },
    next: { billing_status: "awaiting_review" },
    note: parsed.data.note ?? null,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: parsed.data.id, action: "status_change",
    summary: `${job.order_number}: sent back for review`,
    metadata: { note: parsed.data.note ?? null },
  });

  revalidatePath(`/orders/${parsed.data.id}`);
  revalidatePath(LIST);
  return done(back, `Job ${job.order_number} sent back for review. Price it again to continue.`);
}

/* ---------------------------------------------------------- write it off -- */

/** Take a job out of the billing queue, with a reason on the record. */
export async function markJobNotBillable(formData: FormData): Promise<void> {
  const session = await assertCapability("billing.write");
  const parsed = z.object({
    id: z.string().uuid(),
    billing_exclusion_reason: z.string().trim().min(3, "Say why this job is not billable"),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(LIST, firstIssue(parsed.error));

  const back = backTo(formData, parsed.data.id);
  const supabase = await createClient();

  const job = await loadJobForBilling(supabase, parsed.data.id);
  if (!job) return fail(LIST, "That job could not be found.");

  const charges = await loadJobCharges(supabase, parsed.data.id);
  const allowed = checkBillingTransition(job.billing_status, "not_billable", {
    operationalStatus: job.status, chargeCount: charges.length,
  });
  if (!allowed.ok) return fail(back, allowed.reason);

  const { error } = await supabase
    .from("laundry_orders")
    .update({
      billing_status: "not_billable",
      billing_exclusion_reason: parsed.data.billing_exclusion_reason,
    })
    .eq("id", parsed.data.id)
    .eq("tenant_id", session.tenantId);
  if (error) return fail(back, describeDbError(error));

  await logOrderActivity(supabase, session, parsed.data.id, {
    activity_type: "status_changed",
    previous: { billing_status: job.billing_status },
    next: { billing_status: "not_billable" },
    note: parsed.data.billing_exclusion_reason,
  });
  await recordAudit(session, {
    entity: "laundry_order", entityId: parsed.data.id, action: "status_change",
    summary: `${job.order_number}: not billable`,
    metadata: { reason: parsed.data.billing_exclusion_reason },
  });

  revalidatePath(`/orders/${parsed.data.id}`);
  revalidatePath(LIST);
  return done(back, `Job ${job.order_number} will not be billed. Nothing was deleted.`);
}
