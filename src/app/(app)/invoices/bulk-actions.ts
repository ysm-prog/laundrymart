"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { done, fail, returnTo } from "@/lib/actions";
import { counted, money } from "@/lib/format";
import { approveJob, priceAndSaveJob } from "@/lib/orders/job-billing";
import { placeApprovedJobs } from "@/lib/orders/approve";
import { issueOneInvoice } from "@/lib/invoices/issue";
import { sendInvoice } from "@/lib/invoices/send";

/**
 * Bulk billing: approve a selection, invoice a selection, send a selection.
 *
 * **Server-side operations, not a loop of individual server actions.** Each of
 * these is one request that reads its whole selection in one query and does the
 * set-based part in one statement. The alternative — the browser firing one
 * action per row — is what makes a fifty-row selection take fifty round trips,
 * fail halfway with no record of where, and leave the operator guessing.
 *
 * The other half of that is honesty about partial success. A selection of forty
 * where three cannot proceed reports **both** numbers and names the reasons; it
 * never reports forty and it never fails the whole batch over three. That is why
 * every one of these returns a summary rather than the first error it met.
 *
 * `invoices.bulk` gates all three, on top of the capability the single-record
 * version needs — the same operation, but a mistake is multiplied by the size of
 * the selection.
 */

const QUEUE = "/invoices/awaiting";
const REGISTER = "/invoices";
const DRAFTS = "/invoices/drafts";

/**
 * The selected ids, from a checkbox group.
 *
 * Capped at 200. Not arbitrary: it is well past any real day's work, and it
 * bounds how long one request can run and how many invoice numbers a single
 * press can consume. A selection over the cap is refused with a sentence rather
 * than silently truncated — a bulk action that quietly does part of the job is
 * worse than one that declines.
 */
const MAX_SELECTION = 200;

function selectedIds(formData: FormData, field = "selected"): string[] | null {
  const raw = formData.getAll(field).filter((value): value is string => typeof value === "string");
  const parsed = z.array(z.string().uuid()).safeParse(raw);
  if (!parsed.success) return null;
  return [...new Set(parsed.data)];
}

/* --------------------------------------------------------- price selected --- */

/**
 * Price a selection of jobs from each customer's own rates.
 *
 * The step that used to have no bulk form at all, which is what made month-end
 * a per-job errand: approving in bulk needs charges on every job, and the only
 * way to put them there was to open each job and press Price. Forty jobs was
 * forty page loads before a single tick could be made.
 *
 * Per job rather than one statement, because each reads its own customer's rate
 * card and price list and writes its own snapshot — and it goes through the very
 * helper the single button uses, so twenty cannot be priced differently from one.
 *
 * A job that cannot be priced is **reported and skipped**, never guessed at: a
 * kind of laundry neither tier covers is a decision somebody has to take, and a
 * zero line looks exactly like a decision already taken.
 */
export async function priceSelectedJobs(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  await assertCapability("billing.write");

  const ids = selectedIds(formData);
  if (!ids) return fail(QUEUE, "That selection could not be read. Please try again.");
  if (ids.length === 0) return fail(QUEUE, "Select at least one job to price.");
  if (ids.length > MAX_SELECTION) {
    return fail(QUEUE, `Select ${MAX_SELECTION} jobs or fewer at a time.`);
  }

  const supabase = await createClient();

  const priced: string[] = [];
  const refused: string[] = [];
  let total = 0;
  let gaps = 0;
  let anyCard = false;

  for (const id of ids) {
    const result = await priceAndSaveJob(supabase, session, id);
    if (result.ok) {
      priced.push(result.orderNumber);
      total += result.subtotal;
      gaps += result.unpriced;
    } else {
      refused.push(result.error);
      if (result.card) anyCard = true;
    }
  }

  await recordAudit(session, {
    entity: "laundry_order", action: "update",
    summary: `bulk price: ${priced.length} of ${ids.length}`,
    metadata: { priced: priced.length, refused: refused.length, unpricedItems: gaps },
  });

  revalidatePath(QUEUE);

  // Where the failures point depends on which tier was missing. With no rate
  // card anywhere in the selection the answer is the price list, which is the
  // tier that covers a customer who has never negotiated one.
  const link = anyCard
    ? undefined
    : { href: "/invoices/prices", label: "Set your laundry prices" };

  if (priced.length === 0) {
    return fail(QUEUE, refused[0] ?? "None of those jobs could be priced.", link);
  }

  const gapNote = gaps > 0
    ? ` ${gaps} item(s) had no rate and were left for you to add by hand.`
    : "";
  const refusedNote = refused.length > 0
    ? ` ${refused.length} could not be priced — ${refused[0]}`
    : "";

  // Said as a failure when anything was refused, for the same reason the month
  // -end run does: an unpriced job is invisible on the invoices themselves, and
  // looks exactly like laundry that was never taken in.
  const summary = `Priced ${priced.length} job(s), ${money(total)} before GST.${gapNote}${refusedNote}`;
  return refused.length > 0 ? fail(QUEUE, summary, link) : done(QUEUE, summary);
}

/* ------------------------------------------------------- approve selected --- */

export async function approveSelectedJobs(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  await assertCapability("invoices.approve");

  const ids = selectedIds(formData);
  if (!ids) return fail(QUEUE, "That selection could not be read. Please try again.");
  if (ids.length === 0) return fail(QUEUE, "Select at least one job to approve.");
  if (ids.length > MAX_SELECTION) {
    return fail(QUEUE, `Select ${MAX_SELECTION} jobs or fewer at a time.`);
  }

  const supabase = await createClient();

  // Approval freezes each job's own charge lines and stamps its own approver, so
  // this is genuinely per job rather than one UPDATE — and it goes through the
  // very function the single-job button uses, so twenty cannot take a different
  // path from one.
  const approvedIds: string[] = [];
  const approved: string[] = [];
  const refused: string[] = [];
  let total = 0;

  for (const id of ids) {
    const result = await approveJob(supabase, session, id);
    if (result.ok) {
      approvedIds.push(id);
      approved.push(result.orderNumber);
      total += result.subtotal;
    } else {
      refused.push(result.error);
    }
  }

  // **Placed in one pass, not one per job.** Forty of one customer's jobs
  // approved together join one draft in a single grouped run, which is both
  // faster and the only way the roll-up can be computed once over the lot.
  const placements = await placeApprovedJobs(supabase, session, approvedIds);
  const placedOn = new Map<string, number>();
  let unplaced = 0;
  for (const placement of placements.values()) {
    if (placement.kind === "placed") {
      placedOn.set(placement.invoiceNumber, (placedOn.get(placement.invoiceNumber) ?? 0) + 1);
    } else unplaced += 1;
  }

  await recordAudit(session, {
    entity: "laundry_order", action: "status_change",
    summary: `bulk approve: ${approved.length} of ${ids.length}`,
    metadata: {
      approved: approved.length, refused: refused.length,
      drafts: [...placedOn.keys()], unplaced,
    },
  });

  revalidatePath(QUEUE);
  revalidatePath(REGISTER);
  revalidatePath(DRAFTS);

  if (approved.length === 0) {
    return fail(QUEUE, refused[0] ?? "None of those jobs could be approved.");
  }

  // Counted in *invoices*, because that is the number the owner is checking: a
  // month's approvals landing on three drafts is the promise being kept, and
  // landing on thirty is the defect this whole change exists to close.
  const draftNote = placedOn.size > 0
    ? ` They are on ${counted(placedOn.size, "draft invoice")}`
      + `${placedOn.size <= 3 ? ` (${[...placedOn.keys()].join(", ")})` : ""}.`
    : "";
  const unplacedNote = unplaced > 0
    ? ` ${unplaced} could not be put on a draft — they are still in this queue.`
    : "";
  const note = refused.length > 0
    ? ` ${refused.length} could not be approved — ${refused[0]}`
    : "";

  const summary = `Approved ${approved.length} job(s), ${money(total)} before GST.`
    + `${draftNote}${unplacedNote}${note}`;

  // An unplaced job is reported as a failure even though its approval stood: it
  // has left the review list either way, and a draft that was never started
  // looks exactly like one that was.
  return unplaced > 0 ? fail(QUEUE, summary) : done(QUEUE, summary,
    placedOn.size > 0 ? { href: DRAFTS, label: "Open drafts" } : undefined);
}

/* --------------------------------------------------------- place selected --- */

/**
 * Put approved jobs on their customers' draft invoices.
 *
 * **This replaced Generate Selected, and the difference is the point.** That
 * button turned a selection of jobs straight into invoices — for a per-job or a
 * `manual` customer it minted a fresh document per press, which is the one route
 * by which a job could become an invoice without a draft in between. There is no
 * such route now: a job's money reaches a customer by joining a draft and the
 * draft being issued, and this button is the first half of that.
 *
 * It exists at all because a placement can fail. Approval freezes the charges
 * whatever happens next — deliberately, since un-approving a decision somebody
 * made because a later write failed is the worse outcome — so a transient error
 * can leave a job `approved` and on no draft. This is how it gets there, and it
 * goes through `placeApprovedJobs`, the very function approval uses, so a retry
 * cannot take a different path from the original.
 */
export async function placeSelectedJobs(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  await assertCapability("invoices.write");

  const ids = selectedIds(formData);
  if (!ids) return fail(QUEUE, "That selection could not be read. Please try again.");
  if (ids.length === 0) return fail(QUEUE, "Select at least one approved job to put on a draft.");
  if (ids.length > MAX_SELECTION) {
    return fail(QUEUE, `Select ${MAX_SELECTION} jobs or fewer at a time.`);
  }

  const supabase = await createClient();
  const placements = await placeApprovedJobs(supabase, session, ids);

  const placedOn = new Map<string, boolean>();
  const reasons: string[] = [];
  let placedJobs = 0;
  for (const placement of placements.values()) {
    if (placement.kind === "placed") {
      placedJobs += 1;
      // `opened` is per invoice, and several jobs share one — first write wins,
      // which is the one that actually opened it.
      if (!placedOn.has(placement.invoiceNumber)) {
        placedOn.set(placement.invoiceNumber, placement.opened);
      }
    } else {
      reasons.push(placement.reason);
    }
  }

  await recordAudit(session, {
    entity: "invoice", action: "generate",
    summary: `bulk place: ${placedJobs} of ${ids.length} job(s) onto ${placedOn.size} draft(s)`,
    metadata: { jobs: placedJobs, drafts: [...placedOn.keys()], refused: reasons.length },
  });

  revalidatePath(QUEUE);
  revalidatePath(REGISTER);
  revalidatePath(DRAFTS);

  if (placedJobs === 0) {
    return fail(QUEUE, `Nothing was put on a draft — ${reasons[0] ?? "no charges on the approved jobs."}`);
  }

  // Started and added-to are different facts, and the second is the one the
  // running draft makes common. An operator who reads "4 drafts" every time has
  // no way to notice whether that was four documents or one being filled up.
  const started = [...placedOn.values()].filter(Boolean).length;
  const joined = placedOn.size - started;
  const shape = joined > 0
    ? ` ${started} started, ${joined} already open.`
    : "";
  const skipped = reasons.length > 0
    ? ` ${reasons.length} job(s) could not be placed — ${reasons[0]}`
    : "";

  // Said out loud: a draft is not an invoice. The customer hears nothing until
  // somebody issues it, which is the whole separation phase 5 exists for.
  const summary = `${counted(placedJobs, "job")} on ${counted(placedOn.size, "draft invoice")}.`
    + `${shape} Nothing has been issued or sent.${skipped}`;

  return reasons.length > 0
    ? fail(QUEUE, summary)
    : done(QUEUE, summary, { href: DRAFTS, label: "Open drafts" });
}

/* --------------------------------------------------------- issue selected --- */

/**
 * Issue a selection of drafts.
 *
 * The missing rung between a draft and Send Selected, and the step that actually
 * creates the invoice: approving fills drafts and sending refuses one —
 * correctly, since a draft's lines can still change — so a month-end run of
 * forty invoices needed forty presses of a single-invoice button before the bulk
 * send was usable at all.
 *
 * Each goes through `issueOneInvoice`, so the Xero push and its
 * never-block-the-money contract are the same here as on the single button. A
 * Xero refusal is **not** a failure of the issue: the invoice is issued, the
 * error is on the row with a Retry beside it, and it is counted separately so
 * the operator is told rather than left to find it in the register.
 */
export async function issueSelectedInvoices(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  await assertCapability("invoices.write");

  const back = returnTo(formData, REGISTER);
  const ids = selectedIds(formData);
  if (!ids) return fail(back, "That selection could not be read. Please try again.");
  if (ids.length === 0) return fail(back, "Select at least one draft to issue.");
  if (ids.length > MAX_SELECTION) {
    return fail(back, `Select ${MAX_SELECTION} invoices or fewer at a time.`);
  }

  const supabase = await createClient();

  const issued: string[] = [];
  const failed: string[] = [];
  let xeroFailures = 0;

  for (const id of ids) {
    const result = await issueOneInvoice(supabase, session, id);
    if (!result.ok) {
      failed.push(result.error);
      continue;
    }
    issued.push(id);
    if (result.xero === "failed") xeroFailures += 1;
  }

  await recordAudit(session, {
    entity: "invoice", action: "status_change",
    summary: `bulk issue: ${issued.length} of ${ids.length}`,
    metadata: { issued: issued.length, failed: failed.length, xeroFailures },
  });

  revalidatePath(REGISTER);

  if (issued.length === 0) {
    return fail(back, failed[0]
      ? `Nothing was issued — ${failed[0]}.`
      : "Nothing was issued.");
  }

  const xeroNote = xeroFailures > 0
    ? ` ${xeroFailures} could not be sent to Xero — open them to retry.`
    : "";
  const failNote = failed.length > 0 ? ` ${failed.length} skipped — ${failed[0]}.` : "";
  return done(back,
    `Issued ${issued.length} invoice(s). They can be sent now.${xeroNote}${failNote}`);
}

/* ---------------------------------------------------------- send selected --- */

export async function sendSelectedInvoices(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  await assertCapability("invoices.send");

  const back = returnTo(formData, REGISTER);
  const ids = selectedIds(formData);
  if (!ids) return fail(back, "That selection could not be read. Please try again.");
  if (ids.length === 0) return fail(back, "Select at least one invoice to send.");
  if (ids.length > MAX_SELECTION) {
    return fail(back, `Select ${MAX_SELECTION} invoices or fewer at a time.`);
  }

  const supabase = await createClient();

  // One email per invoice is unavoidable — each carries its own PDF to its own
  // address — but it is one *request*, and every outcome is collected rather
  // than the first failure aborting the rest. A bounce on invoice three must
  // not stop invoices four to forty going out.
  const sent: string[] = [];
  const failed: Array<{ number: string; reason: string }> = [];

  for (const id of ids) {
    const result = await sendInvoice(supabase, session, id);
    if (result.ok) sent.push(result.invoiceNumber);
    else failed.push({ number: result.invoiceNumber ?? "an invoice", reason: result.error });
  }

  await recordAudit(session, {
    entity: "invoice", action: "send",
    summary: `bulk send: ${sent.length} of ${ids.length}`,
    metadata: { sent: sent.length, failed: failed.length },
  });

  revalidatePath(REGISTER);

  if (sent.length === 0) {
    const first = failed[0];
    return fail(back, first ? `${first.number}: ${first.reason}` : "Nothing was sent.");
  }
  const note = failed.length > 0
    ? ` ${failed.length} could not be sent — ${failed[0]?.number}: ${failed[0]?.reason}`
    : "";
  return done(back, `Sent ${sent.length} invoice(s).${note}`);
}

/* --------------------------------------------- record a Xero reference ----- */
//
// **Removed, 2026-08-17.** `recordXeroReference` let a person type an invoice's
// `xero_invoice_id` in by hand, which was the right answer while this codebase
// had no Xero client — the branch it came from could only hold the reference so
// the two systems could be reconciled, and said so on screen.
//
// It is now actively dangerous, because that column stopped being a note and
// became **the push's idempotency key** (§20): a hand-typed value makes the next
// push an *update* to whatever id was entered rather than a create, and the same
// value steers `voidGate` and `paymentGate`. A typo would silently edit some
// other invoice in the laundry's books.
//
// The connection screen and the automatic push replace it. There is deliberately
// no "correct the Xero id" control to replace it with: if a push went wrong, the
// answer is to look in Xero, not to retype a GUID.
