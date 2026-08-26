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
import { counted } from "@/lib/format";
import { loadInvoiceForPdf } from "@/lib/pdf/invoice-data";
import { pushInvoiceToXero } from "@/lib/xero/push";
import { pushPaymentToXero } from "@/lib/xero/push-payment";
import { pushVoidToXero } from "@/lib/xero/push-void";
import { accountForLine, incomeAccountsForItems } from "@/lib/invoices/account-coding";
import { generateInvoicesForJobs } from "@/lib/invoices/from-jobs";
import { findOrOpenDraft, removeJobFromDraft } from "@/lib/invoices/open-draft";
import { issueOneInvoice } from "@/lib/invoices/issue";
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
 * `manual` is deliberately left alone here — `sweptByMonthEndRun`, and now the
 * whole of what that setting means: this is a sweep, not somebody's
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
  // Which *documents* this run touched. Both halves now write onto the same
  // per-customer draft, so counting "contract invoices" and "job invoices"
  // separately would report two where the customer receives one.
  const touched = new Set<string>();

  for (const [customerId, contracts] of byCustomer) {
    // **Has this customer's contracts already been billed for this window?**
    // Asked of the *lines* rather than of the invoice type, because since 0040
    // the contract charges and the month's job charges share one document —
    // `invoice_type` can no longer answer it, and `origin` can. The legacy
    // `recurring` shape is still recognised beside it, so a period billed by the
    // code that shipped before this is not billed a second time.
    const { data: periodInvoices } = await supabase
      .from("invoices").select("id, invoice_type")
      .eq("tenant_id", session.tenantId)
      .eq("customer_id", customerId)
      .eq("period_start", start).eq("period_end", end)
      .neq("status", "void")
      .returns<Array<{ id: string; invoice_type: string }>>();

    if ((periodInvoices ?? []).some((row) => row.invoice_type === "recurring")) {
      skipped += 1; continue;
    }
    if ((periodInvoices ?? []).length > 0) {
      const { count: contractLines } = await supabase
        .from("invoice_lines").select("id", { count: "exact", head: true })
        .eq("tenant_id", session.tenantId)
        .in("invoice_id", (periodInvoices ?? []).map((row) => row.id))
        .eq("origin", "contract");
      if ((contractLines ?? 0) > 0) { skipped += 1; continue; }
    }

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

    // **The contract charges go on the customer's draft for this period, not on
    // an invoice of their own.** `CLAUDE.md` §4 has said "one invoice per
    // customer per period, carrying every contract they hold and every laundry
    // job they had completed in it" since the recurring run was written, and the
    // code did not do it: this half wrote a `recurring` invoice and the jobs half
    // below wrote a second, `consolidated` one. A customer with a contract and
    // counter laundry received two documents for one month. Nothing was billed
    // twice — the month was simply split.
    //
    // The header values below are used only if this call is what *opens* the
    // draft. When the month's approvals already opened one, its header stands:
    // rewriting the terms on an invoice somebody may have looked at, because a
    // second writer arrived with its own opinion, is not an improvement.
    const opened = await findOrOpenDraft(
      supabase, session,
      {
        id: customerId,
        payment_terms_days: terms,
        depot_id: depotId,
        purchase_order_number: purchaseOrder,
      },
      { start, end },
      end,
    );
    if (!opened.ok) return fail("/invoices", opened.error);
    const invoiceId = opened.draft.id;

    // Same rule as the per-job generator, from the same module: a line that names
    // an item is coded to that item's income account, and everything else is
    // reported as uncoded on the invoice rather than guessed at.
    const accountByItem = await incomeAccountsForItems(
      supabase, session.tenantId, draft.map((entry) => entry.line.itemId),
    );

    // After whatever is already on the draft, so the invoice reads laundry first
    // and the contract charges under it. `rebuildJobLines` re-sequences these
    // again the next time a job joins, which is what keeps the order stable.
    const { count: existingLines } = await supabase
      .from("invoice_lines").select("id", { count: "exact", head: true })
      .eq("invoice_id", invoiceId).eq("tenant_id", session.tenantId);

    const { error: lineError } = await supabase.from("invoice_lines").insert(
      draft.map((entry, index) => ({
        tenant_id: session.tenantId,
        created_by: session.userId,
        invoice_id: invoiceId,
        item_id: entry.line.itemId ?? null,
        gl_account_id: accountForLine(entry.line.itemId, accountByItem),
        agreement_id: entry.agreementId,
        location_id: entry.locationId,
        laundry_order_id: entry.orderId ?? null,
        description: entry.line.description,
        charge_type: entry.line.chargeType,
        quantity: entry.line.quantity,
        unit_price: entry.line.unitPrice,
        amount: entry.line.amount,
        taxable: entry.line.taxable,
        // Not `job`: nothing may re-derive these from a frozen job charge, and
        // `rebuildJobLines` deletes exactly the lines marked `job`.
        origin: "contract",
        sequence: (existingLines ?? 0) + index + 1,
      })),
    );
    if (lineError) return fail("/invoices", describeDbError(lineError));

    const { error: totalError } = await supabase.rpc("recalculate_invoice", { p_invoice: invoiceId });
    if (totalError) return fail("/invoices", describeDbError(totalError));

    touched.add(invoiceId);
    created += 1;
    contractsBilled += contracts.length;
  }

  // ------------------------------------------------- the jobs half of the run
  // Contracts are one source of billable work; **completed jobs are the other**,
  // and phase 7's whole point is that both end up on invoices without a second
  // billing system. Approved jobs completed inside the period are swept here,
  // grouped by each customer's own `billing_method`, and written by the same
  // shared generator an approval uses — so a swept job and an approved one land
  // on the same draft rather than on two documents.
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

  // **The same window, so both halves meet on one draft.** Without the period
  // the jobs would find their own from each customer's billing method — which is
  // the calendar month, and therefore the same answer whenever the operator runs
  // a whole month, and a *different* one the moment they run 5–20 August. The
  // window they chose is the window they are billing.
  const jobRun = await generateInvoicesForJobs(
    supabase, session, (periodJobs ?? []).map((row) => row.id),
    { issueDate: end, respectManual: true, period: { start, end } },
  );

  for (const entry of jobRun.created) touched.add(entry.invoiceId);

  await recordAudit(session, {
    entity: "invoice", action: "generate",
    summary: `${touched.size} invoice(s) for ${start} – ${end}`
      + ` — ${contractsBilled} contract(s) and`
      + ` ${jobRun.created.reduce((sum, entry) => sum + entry.jobIds.length, 0)} approved job(s)`,
    metadata: {
      start, end, invoices: touched.size, customersBilled: created, skipped,
      contracts: contractsBilled,
      jobs: jobRun.created.reduce((sum, entry) => sum + entry.jobIds.length, 0),
      jobsSkipped: jobRun.skipped.length,
    },
  });
  revalidatePath("/invoices");
  revalidatePath("/invoices/awaiting");
  revalidatePath("/invoices/drafts");

  // Counted in **documents**, because that is what the customer receives and
  // what the owner is checking. Before the running draft this said "N contract
  // invoices and M job invoices", which was two numbers for one month and, for a
  // customer holding both, literally two invoices.
  const jobCount = jobRun.created.reduce((sum, entry) => sum + entry.jobIds.length, 0);
  const jobNote = jobCount > 0
    ? ` ${counted(jobCount, "approved job")} billed onto them.`
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

  if (touched.size === 0) {
    return fail("/invoices",
      `Nothing to invoice — ${skipped} customer(s) were already billed for that period, `
      + `and no approved job was waiting.${jobSkipNote}`,
      queueLink);
  }

  // Said in customers and contracts rather than in rows: the operator's question
  // is "did everyone get billed", and a consolidated invoice covering two
  // contracts should say so rather than looking like one contract was missed.
  const covers = contractsBilled > 0 ? ` covering ${counted(contractsBilled, "contract")}` : "";
  const summary = `${counted(touched.size, "draft invoice")} for ${start} to ${end}`
    + `${covers}.${skippedNote}${jobNote} Nothing has been sent yet.`;

  // An unbillable job is a fact the operator has to act on, so it is said as a
  // failure with the screen that fixes it — the invoices were still created.
  return skippedJobs.length > 0
    ? fail("/invoices", `${summary}${jobSkipNote}`, queueLink)
    : done("/invoices", summary, { href: "/invoices/drafts", label: "Open drafts" });
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
    /*
     * The account this line codes to. Optional on purpose and in both
     * directions: a line that names neither an item nor an account is exactly
     * the free-text line the client asked to be able to write, and refusing it
     * would push that work back onto a spreadsheet. What the app does instead is
     * *count* the uncoded lines on screen, so a gap is visible rather than
     * silent — the same call the pricer makes about laundry nobody has priced.
     */
    gl_account_id: optionalUuid,
    description: z.string().trim().min(2, "Describe what is being charged"),
    charge_type: z.string().trim().min(2),
    quantity: money,
    unit_price: money,
    taxable: z.preprocess((v) => v === "on", z.boolean()),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const backTo = `/invoices/${parsed.data.invoice_id}`;
  const supabase = await createClient();

  // 0040's `guard_invoice_line_draft_only` is the boundary and refuses this
  // outright; this is the sentence in front of it. Worth having both: the guard
  // covers a request made outside the app, and the check covers a stale page
  // whose Add button is still on screen after somebody else issued the invoice.
  const { data: parent } = await supabase
    .from("invoices").select("status")
    .eq("id", parsed.data.invoice_id).eq("tenant_id", session.tenantId)
    .maybeSingle<{ status: string }>();
  if (!parent) return fail(backTo, "That invoice could not be found.");
  if (parent.status !== "draft") {
    return fail(backTo, parent.status === "void"
      ? "This invoice is void. Its lines are a record of what was said and cannot change."
      : "This invoice is no longer a draft, so its lines cannot change. "
        + "Raise a credit note if it was wrong.");
  }

  const { count: existing } = await supabase
    .from("invoice_lines").select("id", { count: "exact", head: true })
    .eq("invoice_id", parsed.data.invoice_id);

  /*
   * `account_code` is deliberately **not** posted and not trusted from the
   * browser. `sync_invoice_line_account()` derives it from the account id
   * inside the insert, so the two records of one fact cannot disagree and a
   * hand-made request cannot stamp `4-1100` on a line pointing somewhere else.
   * The same trigger refuses a heading and another laundry's account.
   */
  const { error } = await supabase.from("invoice_lines").insert({
    ...parsed.data,
    tenant_id: session.tenantId,
    created_by: session.userId,
    amount: lineAmount(parsed.data.quantity, parsed.data.unit_price),
    // Stated rather than left to the column default, because this is the whole
    // meaning of the value: a typed line is one `rebuildJobLines` may never
    // delete, however many jobs join the draft afterwards.
    origin: "manual",
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

  const { data: parent } = await supabase
    .from("invoices").select("status")
    .eq("id", parsed.data.invoice_id).eq("tenant_id", session.tenantId)
    .maybeSingle<{ status: string }>();
  if (parent && parent.status !== "draft") {
    return fail(backTo,
      "This invoice is no longer a draft, so its lines cannot change. "
      + "Raise a credit note if it was wrong.");
  }

  const { error } = await supabase
    .from("invoice_lines").delete()
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await supabase.rpc("recalculate_invoice", { p_invoice: parsed.data.invoice_id });
  revalidatePath(backTo);
  return done(backTo, "Line removed.");
}

/**
 * Take one job back off a draft.
 *
 * The reverse gear the running draft needs. Voiding is the other way back and it
 * releases *every* job on the invoice — fine for a per-job invoice, and quite
 * wrong for a draft carrying eleven good jobs and one that should not be there.
 *
 * `invoices.write` and drafts only. The rule and the writes are in
 * `lib/invoices/open-draft.ts`; everything here is what the operator reads back.
 */
export async function removeJobFromInvoice(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    invoice_id: z.string().uuid(),
    order_id: z.string().uuid(),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/invoices", firstIssue(parsed.error));

  const back = returnTo(formData, `/invoices/${parsed.data.invoice_id}`);
  const supabase = await createClient();

  const result = await removeJobFromDraft(
    supabase, session, parsed.data.invoice_id, parsed.data.order_id,
  );
  if (!result.ok) return fail(back, result.error);

  await recordAudit(session, {
    entity: "invoice", entityId: parsed.data.invoice_id, action: "update",
    summary: `${result.orderNumber} taken off ${result.invoiceNumber}`,
    metadata: { order_id: parsed.data.order_id, remaining: result.remaining },
  });

  revalidatePath(back);
  revalidatePath(`/invoices/${parsed.data.invoice_id}`);
  revalidatePath("/invoices/drafts");
  revalidatePath("/invoices/awaiting");

  // The job is back in the queue and that is the next thing to do with it, so
  // the toast carries the screen it is on.
  const left = result.remaining === 0
    ? " That invoice now bills no jobs."
    : ` ${counted(result.remaining, "job")} left on it.`;
  return done(back,
    `${result.orderNumber} is off ${result.invoiceNumber} and back in the billing queue.${left}`,
    { href: "/invoices/awaiting", label: "Awaiting invoice" });
}

export async function issueInvoice(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/invoices", "That invoice could not be found.");

  const backTo = returnTo(formData, `/invoices/${id.data}`);
  const supabase = await createClient();

  // The rules — recalculate, draft-only, then Xero without ever blocking the
  // issue — live in `issueOneInvoice`, shared with Issue Selected.
  const issued = await issueOneInvoice(supabase, session, id.data);

  revalidatePath(`/invoices/${id.data}`);
  revalidatePath("/invoices");

  if (!issued.ok) return fail(backTo, `This invoice could not be issued — ${issued.error}.`);
  if (issued.xero === "pushed") return done(backTo, "Invoice issued and sent to Xero.");
  // A laundry that has not connected Xero is not failing at anything.
  if (issued.xero === "skipped") return done(backTo, "Invoice issued.");
  return done(backTo, `Invoice issued, but Xero did not accept it. ${issued.reason ?? ""}`.trim(),
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
