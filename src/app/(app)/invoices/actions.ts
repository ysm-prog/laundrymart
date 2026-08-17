"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { addDays } from "@/lib/domain/dates";
import {
  allocateWeightCharges, buildReplacementCharges, lineAmount, round2,
  type DraftLine,
} from "@/lib/domain/pricing";
import {
  consolidate, contractCharges,
  type BillableAgreement, type BillableLine,
} from "@/lib/domain/invoicing";
import { toInstant } from "@/lib/domain/timezone";
import {
  count, describeDbError, done, fail, firstIssue, money, optionalText,
  optionalUuid, requiredDate, returnTo, toObject,
} from "@/lib/actions";
import { loadInvoiceForPdf } from "@/lib/pdf/invoice-data";
import { pushInvoiceToXero } from "@/lib/xero/push";
import { pushPaymentToXero } from "@/lib/xero/push-payment";
import { pushVoidToXero } from "@/lib/xero/push-void";
import { generateInvoicesForJobs } from "@/lib/invoices/from-jobs";
import {
  markInvoiceJobsPaid, releaseVoidedInvoiceJobs, sendInvoice,
} from "@/lib/invoices/send";

/**
 * Generate recurring invoices for a billing period — **one invoice per
 * customer**, carrying the charges from every contract they hold.
 *
 * This used to loop per agreement while de-duplicating on customer + period, so
 * a customer with two active contracts had the first billed and the second
 * silently skipped as "already invoiced". Consolidating is the fix, and it is
 * also the only shape that can be right: the weighed collections and the
 * damaged/missing linen are recorded against the *customer*, not the contract,
 * so two invoices from one customer's pickups would have billed the same
 * kilograms and the same lost towels twice.
 *
 * Per customer the generator:
 *  1. splits the period's weighed collections across every per-kg line the
 *     customer holds, across all their contracts, so the weight is allocated
 *     once;
 *  2. for each contract, expands its own service calendar (its own holiday
 *     rule and region), prices its lines by visit count, tops up to *its*
 *     minimum charge and applies *its* levies and surcharges — a levy on one
 *     contract must not reach another contract's services;
 *  3. adds the period's replacement charges once, for the customer;
 *  4. writes one invoice whose lines each keep their `agreement_id` and
 *     `location_id`, so every charge still says where it came from.
 *
 * **Then it bills the jobs, and that is a separate half with different rules.**
 * `generateInvoicesForJobs` sweeps every job in the period whose
 * `billing_status` is `approved`, and writes its lines from the **frozen**
 * `job_charge_snapshots` rather than pricing anything now. So the money on an
 * invoice is the money a person signed off, and re-pricing a customer between
 * approval and generation cannot move it.
 *
 * That half groups by the customer's own `billing_method` — one invoice per job,
 * or one weekly/fortnightly/monthly — which is why switching a customer between
 * those shapes is a column and not a second code path. A customer set to
 * `manual` is deliberately left alone here: this is a sweep, not somebody's
 * explicit selection, and "manual" means a person decides each time.
 *
 * A customer with no contract at all is still invoiced when they handed laundry
 * over the counter — their invoice simply comes entirely from the jobs half.
 *
 * Double-billing is refused three ways over. Customers that already have a
 * recurring invoice for the exact period are skipped, so re-running after a fix
 * does not duplicate; only `approved` jobs are swept, and generation moves them
 * straight to `invoice_generated`; and underneath both,
 * `uq_invoice_source_jobs_once` is a unique index on (tenant, job), so two runs
 * racing each other end with one winner rather than two invoices.
 */
export async function generateInvoices(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    period_start: requiredDate,
    period_end: requiredDate,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const { period_start: start, period_end: end } = parsed.data;
  if (start > end) return fail("/invoices", "The period start must be on or before the period end.");

  const supabase = await createClient();

  const { data: agreements, error: agreementError } = await supabase
    .from("service_agreements")
    .select("id, customer_id, depot_id, location_id, start_date, end_date, pickup_pattern, " +
            "minimum_charge, holiday_rule, holiday_region, weekend_surcharge_pct, " +
            "holiday_surcharge_pct, fuel_levy_pct, payment_terms_days, purchase_order_number, " +
            "emergency_service")
    .eq("status", "active").is("deleted_at", null)
    .lte("start_date", end)
    .returns<BillableAgreement[]>();
  if (agreementError) return fail("/invoices", describeDbError(agreementError));

  // Contracts are no longer a precondition: a counter-only customer holds none
  // and is billed entirely from their laundry jobs below.
  const live = (agreements ?? []).filter((a) => !a.end_date || a.end_date >= start);

  const { data: holidayRows } = await supabase
    .from("public_holidays").select("holiday_date, region")
    .gte("holiday_date", start).lte("holiday_date", end);

  const linesByAgreement = new Map<string, BillableLine[]>();
  if (live.length > 0) {
    const { data: agreementLines } = await supabase
      .from("service_agreement_lines")
      .select("id, agreement_id, item_id, charge_type, pricing_model, unit_price, percentage, " +
              "standard_quantity, included_quantity, taxable, " +
              "items(name, sku, rental_price, wash_only_price, replacement_cost)")
      .in("agreement_id", live.map((a) => a.id))
      .returns<BillableLine[]>();

    for (const line of agreementLines ?? []) {
      const bucket = linesByAgreement.get(line.agreement_id) ?? [];
      bucket.push(line);
      linesByAgreement.set(line.agreement_id, bucket);
    }
  }

  // ------------------------------------------------ the period's laundry ---
  // **Counter laundry is no longer priced here.** It used to be: this action
  // read every completed job, priced it from `laundry_prices` on the spot, and
  // appended the lines to the customer's consolidated invoice.
  //
  // A job's money is now decided once, by a person, at review time — and frozen
  // (0017). So the run bills what was *approved*, from `job_charge_snapshots`,
  // through `generateInvoicesForJobs` below. That module also honours the
  // customer's `billing_method`, which is what makes "one invoice per job" a
  // column and not a second code path.
  //
  // The consequence worth stating: a job nobody has reviewed is **not billed**,
  // where before it was billed automatically at list price. That is the point of
  // the change, and it is why the Awaiting invoice queue carries a badge.
  const byCustomer = new Map<string, BillableAgreement[]>();
  for (const agreement of live) {
    const bucket = byCustomer.get(agreement.customer_id) ?? [];
    bucket.push(agreement);
    byCustomer.set(agreement.customer_id, bucket);
  }

  // Terms fall back to the customer's own when their contracts disagree — the
  // one answer that is defensible without picking a winner between contracts.
  const { data: customerRows } = await supabase
    .from("customers").select("id, payment_terms_days, depot_id")
    .in("id", [...byCustomer.keys()])
    .returns<Array<{ id: string; payment_terms_days: number; depot_id: string | null }>>();
  const customerById = new Map((customerRows ?? []).map((row) => [row.id, row]));

  let created = 0;
  let skipped = 0;
  let contractsBilled = 0;

  for (const [customerId, contracts] of byCustomer) {
    const { data: existing } = await supabase
      .from("invoices").select("id")
      .eq("customer_id", customerId)
      .eq("invoice_type", "recurring")
      .eq("period_start", start).eq("period_end", end)
      .maybeSingle();
    if (existing) { skipped += 1; continue; }

    const contractLines = new Map(
      contracts.map((agreement) => [agreement.id, linesByAgreement.get(agreement.id) ?? []]),
    );

    // Per-kg lines bill what the run actually weighed, not what the pattern
    // predicted, so the weight comes from the period's pickups rather than from
    // the service calendar (§11). Allocated across every per-kg line the
    // customer holds — split by contract, the same kilograms would be billed
    // once per contract.
    const weightLines = contracts.flatMap((agreement) =>
      (contractLines.get(agreement.id) ?? []).filter((line) => line.pricing_model === "per_kg"),
    );
    const weightByLine = new Map<string, { billableKg: number; allowanceKg: number }>();
    let weighedCollections = 0;

    if (weightLines.length > 0) {
      const { data: weighed } = await supabase
        .from("pickups")
        .select("total_weight_kg")
        .eq("customer_id", customerId)
        .gte("pickup_date", start).lte("pickup_date", end)
        .gt("total_weight_kg", 0)
        .returns<Array<{ total_weight_kg: number }>>();

      weighedCollections = (weighed ?? []).length;
      const totalWeightKg = (weighed ?? [])
        .reduce((sum, row) => sum + Number(row.total_weight_kg ?? 0), 0);

      for (const allocation of allocateWeightCharges({
        totalWeightKg,
        collections: weighedCollections,
        lines: weightLines.map((line) => ({
          key: line.id,
          standardQuantity: Number(line.standard_quantity ?? 0),
          includedQuantity: Number(line.included_quantity ?? 0),
        })),
      })) {
        weightByLine.set(allocation.key, allocation);
      }
    }

    // Every line keeps the contract it came from, so a consolidated invoice can
    // still be read back per contract.
    const draft: Array<{
      line: DraftLine;
      agreementId: string | null;
      locationId: string | null;
      /** Set on a laundry line: the job it bills, and the mark that it is billed. */
      orderId?: string | null;
    }> = [];

    // Each contract's minimum, levies and surcharges apply to its own services
    // and nothing else, so each is priced on its own and the results appended.
    for (const agreement of contracts) {
      for (const line of contractCharges({
        agreement,
        lines: contractLines.get(agreement.id) ?? [],
        holidays: holidayRows ?? [],
        weightByLine,
        weighedCollections,
        start, end,
      })) {
        draft.push({ line, agreementId: agreement.id, locationId: agreement.location_id });
      }
    }

    // Damaged and missing linen picked up during the period becomes a
    // replacement charge on the same invoice (§11). Recorded against the
    // customer's collections, so it is charged once no matter how many
    // contracts they hold — and it belongs to no single contract, hence the
    // null `agreement_id`.
    const { data: damaged } = await supabase
      .from("pickup_lines")
      .select("item_id, damaged_quantity, missing_quantity, " +
              "pickups!inner(customer_id, pickup_date), items(name, replacement_cost)")
      .eq("pickups.customer_id", customerId)
      .gte("pickups.pickup_date", start).lte("pickups.pickup_date", end)
      .returns<Array<{
        item_id: string; damaged_quantity: number; missing_quantity: number;
        items: { name: string; replacement_cost: number } | null;
      }>>();

    for (const line of buildReplacementCharges(
      (damaged ?? []).map((row) => ({
        itemId: row.item_id,
        itemName: row.items?.name ?? "Item",
        damagedQuantity: row.damaged_quantity,
        missingQuantity: row.missing_quantity,
        replacementCost: Number(row.items?.replacement_cost ?? 0),
      })),
    )) {
      draft.push({ line, agreementId: null, locationId: null });
    }

    if (draft.length === 0) { skipped += 1; continue; }

    const { data: invoiceNumber, error: numberError } = await supabase
      .rpc("next_number", { t: session.tenantId, k: "invoice", p: "INV" });
    if (numberError) return fail("/invoices", describeDbError(numberError));

    const terms = consolidate(
      contracts.map((agreement) => Number(agreement.payment_terms_days ?? 14)),
      Number(customerById.get(customerId)?.payment_terms_days ?? 14),
    );
    const depotId = contracts.find((agreement) => agreement.depot_id)?.depot_id
      ?? customerById.get(customerId)?.depot_id
      ?? null;
    // A purchase order number belongs to one contract; on a consolidated
    // invoice it is only stamped when every contract agrees on it, rather than
    // quoting one customer's PO against another contract's charges.
    const purchaseOrder = consolidate(
      contracts.map((agreement) => agreement.purchase_order_number),
      null,
    );

    const { data: invoice, error } = await supabase
      .from("invoices")
      .insert({
        tenant_id: session.tenantId,
        created_by: session.userId,
        customer_id: customerId,
        depot_id: depotId,
        invoice_number: invoiceNumber as string,
        invoice_type: "recurring",
        status: "draft",
        issue_date: end,
        due_date: addDays(end, terms),
        period_start: start,
        period_end: end,
        payment_terms_days: terms,
        purchase_order_number: purchaseOrder,
      })
      .select("id")
      .single();
    if (error) return fail("/invoices", describeDbError(error));

    const { error: lineError } = await supabase.from("invoice_lines").insert(
      draft.map((entry, index) => ({
        tenant_id: session.tenantId,
        created_by: session.userId,
        invoice_id: invoice.id,
        item_id: entry.line.itemId ?? null,
        agreement_id: entry.agreementId,
        location_id: entry.locationId,
        laundry_order_id: entry.orderId ?? null,
        description: entry.line.description,
        charge_type: entry.line.chargeType,
        quantity: entry.line.quantity,
        unit_price: entry.line.unitPrice,
        amount: entry.line.amount,
        taxable: entry.line.taxable,
        sequence: index + 1,
      })),
    );
    if (lineError) return fail("/invoices", describeDbError(lineError));

    const { error: totalError } = await supabase.rpc("recalculate_invoice", { p_invoice: invoice.id });
    if (totalError) return fail("/invoices", describeDbError(totalError));

    created += 1;
    contractsBilled += contracts.length;
  }

  // ------------------------------------------------- the jobs half of the run
  // Contracts are one source of billable work; **completed jobs are the other**,
  // and phase 7's whole point is that both end up on invoices without a second
  // billing system. Approved jobs completed inside the period are swept here,
  // grouped by each customer's own `billing_method`, and written by the same
  // shared generator the queue's Generate Selected uses.
  //
  // `respectManual` is on: this is a scheduled-style run over everything, not a
  // person's explicit selection, so a customer set to `manual` is left for
  // somebody to decide about — which is the entire meaning of that setting.
  //
  // The period's edges are composed in the **business timezone**, not in UTC.
  // `completed_at` is a `timestamptz`, so `${end}T23:59:59Z` would put a job
  // finished at 9am Sydney on the 1st into the previous month's invoice — and
  // silently, since the job simply appears on the wrong bill. `toInstant` is the
  // same helper the rest of the app dates a receipt with.
  const periodStartedAt = toInstant(start, "00:00");
  const periodEndedAt = toInstant(addDays(end, 1), "00:00");

  const { data: periodJobs } = await supabase
    .from("laundry_orders")
    .select("id")
    .eq("billing_status", "approved")
    .gte("completed_at", periodStartedAt)
    .lt("completed_at", periodEndedAt)
    .limit(1000)
    .returns<Array<{ id: string }>>();

  const jobRun = await generateInvoicesForJobs(
    supabase, session, (periodJobs ?? []).map((row) => row.id),
    { issueDate: end, respectManual: true },
  );

  await recordAudit(session, {
    entity: "invoice", action: "generate",
    summary: `${created} contract invoice(s) and ${jobRun.created.length} job invoice(s) for ${start} – ${end}`,
    metadata: {
      start, end, created, skipped, contracts: contractsBilled,
      jobInvoices: jobRun.created.length, jobsSkipped: jobRun.skipped.length,
    },
  });
  revalidatePath("/invoices");
  revalidatePath("/invoices/awaiting");

  // Said separately rather than added together: "3 invoices" made of two
  // different things, counted as one number, is the kind of summary somebody
  // reconciles against and finds wrong.
  const jobCount = jobRun.created.reduce((sum, entry) => sum + entry.jobIds.length, 0);
  const jobNote = jobRun.created.length > 0
    ? ` Also billed ${jobRun.created.length} invoice(s) from ${jobCount} approved job(s).`
    : "";

  // A job the run could not bill is reported rather than left silent — it is the
  // one outcome an operator cannot see on the invoices themselves, because a
  // missing job looks exactly like laundry that was never taken in. The link
  // goes to the queue, which is where the job is and where it gets approved.
  const skippedJobs = jobRun.skipped;
  const jobSkipNote = skippedJobs.length > 0
    ? ` ${skippedJobs.length} approved job(s) could not be billed: `
      + `${skippedJobs.slice(0, 3).map((entry) => `${entry.orderNumber} (${entry.reason})`).join("; ")}`
      + `${skippedJobs.length > 3 ? "…" : ""}`
    : "";
  const queueLink = skippedJobs.length > 0
    ? { href: "/invoices/awaiting", label: "Open the queue" }
    : undefined;

  const skippedNote = skipped > 0 ? ` ${skipped} customer(s) skipped.` : "";

  if (created === 0 && jobRun.created.length === 0) {
    return fail("/invoices",
      `Nothing to invoice — ${skipped} customer(s) were already billed for that period, `
      + `and no approved job was waiting.${jobSkipNote}`,
      queueLink);
  }

  // Said in customers and contracts rather than in rows: the operator's question
  // is "did everyone get billed", and a consolidated invoice covering two
  // contracts should say so rather than looking like one contract was missed.
  const covers = contractsBilled > created ? ` covering ${contractsBilled} contract(s)` : "";
  const summary = created === 0
    ? jobNote.trim()
    : `Created ${created} draft invoice(s)${covers}.${skippedNote}${jobNote}`;

  // An unbillable job is a fact the operator has to act on, so it is said as a
  // failure with the screen that fixes it — the invoices were still created.
  return skippedJobs.length > 0
    ? fail("/invoices", `${summary}${jobSkipNote}`, queueLink)
    : done("/invoices", summary);
}

export async function createManualInvoice(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    customer_id: z.string().uuid("Choose a customer"),
    issue_date: requiredDate,
    payment_terms_days: count,
    purchase_order_number: optionalText,
    notes: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const supabase = await createClient();
  const { data: invoiceNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "invoice", p: "INV" });
  if (numberError) return fail("/invoices", describeDbError(numberError));

  const { data, error } = await supabase
    .from("invoices")
    .insert({
      ...parsed.data,
      tenant_id: session.tenantId,
      created_by: session.userId,
      invoice_number: invoiceNumber as string,
      invoice_type: "manual",
      status: "draft",
      due_date: addDays(parsed.data.issue_date, parsed.data.payment_terms_days),
    })
    .select("id, invoice_number")
    .single();
  if (error) return fail("/invoices", describeDbError(error));

  await recordAudit(session, {
    entity: "invoice", entityId: data.id, action: "create", summary: data.invoice_number,
  });
  revalidatePath("/invoices");

  // Raised from the billing two-pane, the new draft opens in the pane the user
  // is already working in rather than throwing them onto a full page.
  const inPane = formData.get("pane") === "1";
  return done(
    inPane ? `/invoices?selected=${data.id}` : `/invoices/${data.id}`,
    `Invoice ${data.invoice_number} created.`,
  );
}

export async function addInvoiceLine(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    invoice_id: z.string().uuid(),
    item_id: optionalUuid,
    description: z.string().trim().min(2, "Describe what is being charged"),
    charge_type: z.string().trim().min(2),
    quantity: money,
    unit_price: money,
    taxable: z.preprocess((v) => v === "on", z.boolean()),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const backTo = `/invoices/${parsed.data.invoice_id}`;
  const supabase = await createClient();

  const { count: existing } = await supabase
    .from("invoice_lines").select("id", { count: "exact", head: true })
    .eq("invoice_id", parsed.data.invoice_id);

  const { error } = await supabase.from("invoice_lines").insert({
    ...parsed.data,
    tenant_id: session.tenantId,
    created_by: session.userId,
    amount: lineAmount(parsed.data.quantity, parsed.data.unit_price),
    sequence: (existing ?? 0) + 1,
  });
  if (error) return fail(backTo, describeDbError(error));

  const { error: totalError } = await supabase
    .rpc("recalculate_invoice", { p_invoice: parsed.data.invoice_id });
  if (totalError) return fail(backTo, describeDbError(totalError));

  await recordAudit(session, {
    entity: "invoice_line", entityId: parsed.data.invoice_id, action: "create",
    summary: parsed.data.description,
  });
  revalidatePath(backTo);
  return done(backTo, "Line added.");
}

export async function removeInvoiceLine(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    id: z.string().uuid(), invoice_id: z.string().uuid(),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const backTo = `/invoices/${parsed.data.invoice_id}`;
  const supabase = await createClient();
  const { error } = await supabase
    .from("invoice_lines").delete()
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await supabase.rpc("recalculate_invoice", { p_invoice: parsed.data.invoice_id });
  revalidatePath(backTo);
  return done(backTo, "Line removed.");
}

export async function issueInvoice(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/invoices", "That invoice could not be found.");

  const backTo = returnTo(formData, `/invoices/${id.data}`);
  const supabase = await createClient();
  await supabase.rpc("recalculate_invoice", { p_invoice: id.data });

  const { error } = await supabase
    .from("invoices")
    .update({ status: "issued", issued_at: new Date().toISOString() })
    .eq("id", id.data).eq("tenant_id", session.tenantId).eq("status", "draft");
  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, { entity: "invoice", entityId: id.data, action: "status_change", summary: "issued" });

  // Xero comes after the invoice is issued, and never blocks it. The money
  // record is ours; Xero is a copy. A provider outage must leave the invoice
  // issued with a visible failure and a retry, not refuse to issue an invoice
  // the customer is about to be sent.
  const push = await pushInvoiceToXero(supabase, id.data, session.tenantId);

  revalidatePath(`/invoices/${id.data}`);
  revalidatePath("/invoices");

  if (push.ok) return done(backTo, "Invoice issued and sent to Xero.");
  // A laundry that has not connected Xero is not failing at anything.
  if (push.skipped) return done(backTo, "Invoice issued.");
  return done(backTo, `Invoice issued, but Xero did not accept it. ${push.reason}`,
              { href: `/invoices/${id.data}`, label: "Open the invoice" });
}

/**
 * Try Xero again for an invoice whose push failed.
 *
 * Separate from issuing because the two fail for different reasons and the
 * operator needs the second one on its own: the invoice is already issued, and
 * this is the button beside the error the register shows.
 */
export async function retryXeroPush(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/invoices", "That invoice could not be found.");

  const backTo = returnTo(formData, `/invoices/${id.data}`);
  const supabase = await createClient();

  // **Which retry this is depends on the invoice's own status.** A voided
  // invoice whose Xero push failed needs the *void* retried; sending it through
  // `pushInvoiceToXero` would be refused by `canPushToXero` and report "a void
  // invoice is not sent to Xero" — technically true, useless as an answer, and
  // it would leave the real failure (Xero still shows it as authorised) with no
  // way to retry at all.
  const { data: row } = await supabase
    .from("invoices").select("status")
    .eq("id", id.data).eq("tenant_id", session.tenantId)
    .maybeSingle<{ status: string }>();

  if (row?.status === "void") {
    const voided = await pushVoidToXero(supabase, id.data, session.tenantId);
    revalidatePath(`/invoices/${id.data}`);
    revalidatePath("/invoices");
    if (voided.ok) return done(backTo, "Voided in Xero.");
    return fail(backTo, voided.reason,
                voided.skipped ? { href: "/invoices/xero", label: "Xero settings" } : undefined);
  }

  const push = await pushInvoiceToXero(supabase, id.data, session.tenantId);

  revalidatePath(`/invoices/${id.data}`);
  revalidatePath("/invoices");

  if (push.ok) return done(backTo, "Sent to Xero.");
  return fail(backTo, push.reason,
              push.skipped ? { href: "/invoices/xero", label: "Xero settings" } : undefined);
}

export async function recordPayment(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    invoice_id: z.string().uuid(),
    customer_id: z.string().uuid(),
    paid_on: requiredDate,
    amount: money.pipe(z.number().positive("Payment must be greater than zero")),
    method: z.enum(["bank_transfer", "credit_card", "direct_debit", "cash", "cheque", "other"]),
    reference: optionalText,
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const backTo = returnTo(formData, `/invoices/${parsed.data.invoice_id}`);
  const supabase = await createClient();

  // `select("id")` because the Xero push needs the row: the payment's own id is
  // sent as Xero's Idempotency-Key, which is what stops a retry posting the
  // money twice.
  const { data: payment, error } = await supabase.from("payments").insert({
    ...parsed.data, tenant_id: session.tenantId, created_by: session.userId,
  }).select("id").single<{ id: string }>();
  if (error) return fail(backTo, describeDbError(error));

  await supabase.rpc("recalculate_invoice", { p_invoice: parsed.data.invoice_id });

  const { data: invoice } = await supabase
    .from("invoices").select("total, amount_paid").eq("id", parsed.data.invoice_id).single();

  if (invoice) {
    const paid = Number(invoice.amount_paid) >= Number(invoice.total);
    await supabase.from("invoices")
      .update({
        status: paid ? "paid" : "part_paid",
        paid_at: paid ? new Date().toISOString() : null,
      })
      .eq("id", parsed.data.invoice_id).eq("tenant_id", session.tenantId);

    // Settling the invoice settles every job on it. A part payment moves
    // nothing: a job is paid when the document covering it is, not when some
    // of it is.
    if (paid) await markInvoiceJobsPaid(supabase, session, parsed.data.invoice_id);
  }

  await recordAudit(session, {
    entity: "payment", entityId: parsed.data.invoice_id, action: "create",
    summary: `${parsed.data.amount} via ${parsed.data.method}`,
  });
  // Xero after the money is recorded, and never in front of it: somebody has
  // handed over payment, and recording that is what must succeed.
  const push = payment
    ? await pushPaymentToXero(supabase, payment.id, session.tenantId)
    : null;

  // Revalidate the routes, not `backTo` — that may carry a query string, which
  // `revalidatePath` does not match against.
  revalidatePath(`/invoices/${parsed.data.invoice_id}`);
  revalidatePath("/invoices");

  if (push?.ok) return done(backTo, "Payment recorded and sent to Xero.");
  // A laundry with no Xero, no bank account chosen, or an invoice that never
  // reached Xero is not failing at anything — say nothing extra.
  if (!push || push.skipped) return done(backTo, "Payment recorded.");
  return done(backTo, `Payment recorded, but Xero did not accept it. ${push.reason}`,
              { href: `/invoices/${parsed.data.invoice_id}`, label: "Open the invoice" });
}

/**
 * Try Xero again for a payment whose push failed.
 *
 * Separate from recording it, for the same reason the invoice has its own
 * retry: the money is already recorded here, and this is the button beside the
 * error rather than a reason to re-enter the payment.
 */
export async function retryXeroPayment(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    payment_id: z.string().uuid(),
    invoice_id: z.string().uuid(),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const backTo = returnTo(formData, `/invoices/${parsed.data.invoice_id}`);
  const supabase = await createClient();
  const push = await pushPaymentToXero(supabase, parsed.data.payment_id, session.tenantId);

  revalidatePath(`/invoices/${parsed.data.invoice_id}`);
  revalidatePath("/invoices");

  if (push.ok) return done(backTo, "Payment sent to Xero.");
  return fail(backTo, push.reason,
              push.skipped ? { href: "/invoices/xero", label: "Xero settings" } : undefined);
}

export async function voidInvoice(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    id: z.string().uuid(),
    void_reason: z.string().trim().min(3, "Give a reason for voiding"),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const backTo = `/invoices/${parsed.data.id}`;
  const supabase = await createClient();
  const { error } = await supabase
    .from("invoices")
    .update({
      status: "void",
      voided_at: new Date().toISOString(),
      void_reason: parsed.data.void_reason,
    })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  // Voiding is how a wrong invoice is undone, and the work on it still has to
  // be billable afterwards — so the jobs go back to `approved` with their
  // frozen charges intact. This is the *only* way out of an invoiced billing
  // state, which is why the guard checks the link rows rather than trusting a
  // caller (migration 0017).
  await releaseVoidedInvoiceJobs(supabase, session, parsed.data.id);

  // Void it in Xero too, *after* voiding it here and never blocking on it. An
  // invoice voided here used to stay AUTHORISED in Xero, so a void was a
  // two-place job and the books disagreed until somebody noticed — which is
  // worse than never pushing, because the first successful push teaches
  // everyone that the two systems agree.
  //
  // The refusal that will actually happen is a paid invoice: Xero will not void
  // one with payments applied, and it is right not to — that protects a
  // reconciled bank line. `voidGate` catches it before the request so the
  // message can name the remedy rather than relay validation text.
  const voided = await pushVoidToXero(supabase, parsed.data.id, session.tenantId);

  await recordAudit(session, {
    entity: "invoice", entityId: parsed.data.id, action: "status_change",
    summary: `voided: ${parsed.data.void_reason}`,
    metadata: { xero: voided.ok ? "voided" : (voided.skipped ? "skipped" : "refused") },
  });
  revalidatePath(backTo);
  revalidatePath("/invoices/awaiting");

  const released = "Invoice voided. Any jobs on it are back in the ready-to-invoice queue.";

  // A refusal the operator has to act on is said as a failure — the void here
  // still happened, and the sentence has to make clear that Xero did not follow.
  // A skip (never pushed, already void there, not connected) is silent.
  if (!voided.ok && !voided.skipped) {
    return fail(backTo, `${released} But Xero did not: ${voided.reason}`);
  }
  return done(backTo, released);
}

/** Credit notes always reference the original invoice (acceptance criteria §10). */
export async function createCreditNote(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    invoice_id: z.string().uuid(),
    customer_id: z.string().uuid(),
    reason: z.string().trim().min(3, "Give a reason for the credit"),
    amount: money.pipe(z.number().positive("Credit must be greater than zero")),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const backTo = `/invoices/${parsed.data.invoice_id}`;
  const supabase = await createClient();

  const { data: creditNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "credit_note", p: "CN" });
  if (numberError) return fail(backTo, describeDbError(numberError));

  const { data: tenant } = await supabase
    .from("tenants").select("gst_rate").eq("id", session.tenantId).maybeSingle();
  const gstRate = Number(tenant?.gst_rate ?? 0.1);
  const tax = round2(parsed.data.amount * gstRate);

  const { data: note, error } = await supabase
    .from("credit_notes")
    .insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      customer_id: parsed.data.customer_id,
      invoice_id: parsed.data.invoice_id,
      credit_note_number: creditNumber as string,
      status: "issued",
      reason: parsed.data.reason,
      subtotal: parsed.data.amount,
      tax_amount: tax,
      total: round2(parsed.data.amount + tax),
    })
    .select("id, credit_note_number")
    .single();
  if (error) return fail(backTo, describeDbError(error));

  const { error: lineError } = await supabase.from("credit_note_lines").insert({
    tenant_id: session.tenantId,
    created_by: session.userId,
    credit_note_id: note.id,
    description: parsed.data.reason,
    quantity: 1,
    unit_price: parsed.data.amount,
    amount: parsed.data.amount,
  });
  if (lineError) return fail(backTo, describeDbError(lineError));

  await recordAudit(session, {
    entity: "credit_note", entityId: note.id, action: "create",
    summary: `${note.credit_note_number} against invoice`,
  });
  revalidatePath(backTo);
  return done(backTo, `Credit note ${note.credit_note_number} issued.`);
}

/**
 * Email the invoice to the customer with the rendered PDF attached (§7.14).
 *
 * Two rules the customer's inbox depends on:
 *  - a draft is never sent. Draft lines are still editable, so sending one
 *    means a customer holding a document the system may contradict tomorrow;
 *  - the address the invoice actually went to is stamped on the invoice, not
 *    inferred later from the customer record, which can change.
 */
export async function emailInvoice(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    id: z.string().uuid(),
    to: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().email("That is not a valid email address").optional(),
    ),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const backTo = returnTo(formData, `/invoices/${parsed.data.id}`);

  const data = await loadInvoiceForPdf(parsed.data.id, session.tenantId);
  if (!data) return fail(backTo, "That invoice could not be found.");

  if (data.invoice.status === "draft") {
    return fail(backTo, "Issue the invoice before emailing it — a draft can still change.");
  }
  if (data.invoice.status === "void") {
    return fail(backTo, "This invoice is void and cannot be sent.");
  }

  const recipient = parsed.data.to ?? data.customer.billing_email;
  if (!recipient) {
    // The fix is one click away (design B4): the toast links the customer form.
    const supabase = await createClient();
    const { data: owner } = await supabase
      .from("invoices").select("customer_id").eq("id", parsed.data.id).maybeSingle();
    return fail(backTo, "This customer has no billing email. Add one, or type an address to send to.",
      owner ? { href: `/customers/${owner.customer_id}/edit`, label: "Add their billing email" } : undefined);
  }

  // The send itself lives in `lib/invoices/send.ts`, shared with Send Selected —
  // one implementation of putting a document in front of a customer, and one
  // place where every job on the invoice moves to `invoice_sent`.
  const supabase = await createClient();
  const result = await sendInvoice(supabase, session, parsed.data.id, recipient);
  if (!result.ok) return fail(backTo, `The invoice could not be sent. ${result.error}`);

  revalidatePath(`/invoices/${parsed.data.id}`);
  revalidatePath("/invoices");
  return done(backTo, `Invoice emailed to ${result.recipient}.`);
}

/** Marks overdue anything past its due date that is still unpaid. */
export async function refreshOverdue(_session?: Session): Promise<void> {
  const session = _session ?? (await assertCapability("invoices.write"));
  const supabase = await createClient();
  await supabase
    .from("invoices")
    .update({ status: "overdue" })
    .eq("tenant_id", session.tenantId)
    .in("status", ["issued", "part_paid"])
    .lt("due_date", new Date().toISOString().slice(0, 10));
}
