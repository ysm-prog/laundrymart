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
import {
  buildLaundryCharges, describeUnpriced, priceListFor,
  type BillableJob, type LaundryPriceRow, type UnpricedItem,
} from "@/lib/domain/laundry-billing";
import { toInstant } from "@/lib/domain/timezone";
import {
  count, describeDbError, done, fail, firstIssue, money, optionalText,
  optionalUuid, requiredDate, returnTo, toObject,
} from "@/lib/actions";
import { loadInvoiceForPdf } from "@/lib/pdf/invoice-data";
import { invoiceFileName, renderInvoicePdf } from "@/lib/pdf/render";
import { buildInvoiceEmail } from "@/lib/email/invoice-email";
import { sendEmail } from "@/lib/email/send";

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
 *  4. lines up every item of every laundry job the customer had **completed** in
 *     the period, priced from their own laundry price list (0018);
 *  5. writes one invoice whose lines each keep their `agreement_id` and
 *     `location_id` — and, for a laundry line, the `laundry_order_id` of the job
 *     it bills — so every charge still says where it came from.
 *
 * A customer with no contract at all is still invoiced when they handed laundry
 * over the counter, which is the whole point of step 4: the counter's Jobs used
 * to carry no money, so a drop-off customer was never billed by the app.
 *
 * Double-billing is refused twice over. Customers that already have a recurring
 * invoice for the exact period are skipped, so re-running after a fix does not
 * duplicate; and a job already carried on any invoice that is not void is left
 * out, so a job completed near a period boundary cannot be billed by two
 * different runs.
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
  // Completed jobs only: a job still in the plant is work in progress, not work
  // done, and cancelled laundry was never washed. `completed_at` is a
  // timestamptz, so the period's edges are composed in the business timezone —
  // a job finished at 9pm on the 31st belongs to that month's invoice, not to
  // whatever day UTC had already moved on to.
  const periodStartedAt = toInstant(start, "00:00");
  const periodEndedAt = toInstant(addDays(end, 1), "00:00");

  const { data: jobRows, error: jobError } = await supabase
    .from("laundry_orders")
    .select("id, customer_id, order_number, completed_at, " +
            "laundry_order_items(item_type, custom_description, quantity_type, " +
            "exact_quantity, bag_count, estimated_quantity)")
    .eq("status", "completed")
    .gte("completed_at", periodStartedAt)
    .lt("completed_at", periodEndedAt)
    .order("completed_at")
    .returns<Array<BillableJob & { customer_id: string; laundry_order_items: BillableJob["items"] }>>();
  if (jobError) return fail("/invoices", describeDbError(jobError));

  // A job already on an invoice is not billed again. Void invoices do not
  // count: voiding one is how a mistake is undone, and the work still has to be
  // billable afterwards.
  const billedOrderIds = new Set<string>();
  if ((jobRows ?? []).length > 0) {
    const { data: billed, error: billedError } = await supabase
      .from("invoice_lines")
      .select("laundry_order_id, invoices!inner(status)")
      .in("laundry_order_id", (jobRows ?? []).map((row) => row.id))
      .neq("invoices.status", "void")
      .returns<Array<{ laundry_order_id: string | null }>>();
    if (billedError) return fail("/invoices", describeDbError(billedError));
    for (const row of billed ?? []) {
      if (row.laundry_order_id) billedOrderIds.add(row.laundry_order_id);
    }
  }

  const jobsByCustomer = new Map<string, BillableJob[]>();
  for (const row of jobRows ?? []) {
    if (billedOrderIds.has(row.id)) continue;
    const bucket = jobsByCustomer.get(row.customer_id) ?? [];
    bucket.push({
      id: row.id,
      order_number: row.order_number,
      items: row.laundry_order_items ?? [],
    });
    jobsByCustomer.set(row.customer_id, bucket);
  }

  // One read of the tenant's whole price list — the customer rows and the
  // default rows together — resolved per customer in the loop below.
  const priceRows = jobsByCustomer.size > 0
    ? (await supabase
        .from("laundry_prices")
        .select("customer_id, item_type, unit_price, bag_price, taxable")
        .returns<LaundryPriceRow[]>()).data ?? []
    : [];

  // One bill per customer. Grouping happens before anything is priced, because
  // the weight allocation and the replacement charges below are facts about the
  // customer's period and have to be computed once, not once per contract.
  const byCustomer = new Map<string, BillableAgreement[]>();
  for (const agreement of live) {
    const bucket = byCustomer.get(agreement.customer_id) ?? [];
    bucket.push(agreement);
    byCustomer.set(agreement.customer_id, bucket);
  }
  // A customer with laundry but no contract belongs in the run just as much —
  // an empty contract list simply means every charge comes from their jobs.
  for (const customerId of jobsByCustomer.keys()) {
    if (!byCustomer.has(customerId)) byCustomer.set(customerId, []);
  }

  if (byCustomer.size === 0) {
    return fail("/invoices",
      "Nothing to bill for that period — no contract covers it and no laundry job was completed in it.",
      { href: "/agreements", label: "Open contracts" });
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
  let jobsBilled = 0;
  const unpriced: UnpricedItem[] = [];

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

    // The counter's laundry: one line per item on every job finished in the
    // period, at this customer's own price where they have one. It belongs to
    // no contract — the laundry was handed over, not scheduled — so the line
    // carries its job rather than an `agreement_id`.
    const jobs = jobsByCustomer.get(customerId) ?? [];
    if (jobs.length > 0) {
      const charges = buildLaundryCharges({
        jobs, prices: priceListFor(customerId, priceRows),
      });
      for (const entry of charges.lines) {
        draft.push({
          line: entry.line, agreementId: null, locationId: null, orderId: entry.orderId,
        });
      }
      unpriced.push(...charges.unpriced);
      jobsBilled += new Set(charges.lines.map((entry) => entry.orderId)).size;
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

  await recordAudit(session, {
    entity: "invoice", action: "generate",
    summary: `${created} invoice(s) for ${start} – ${end}`,
    metadata: {
      start, end, created, skipped,
      contracts: contractsBilled, jobs: jobsBilled, unpriced: unpriced.length,
    },
  });
  revalidatePath("/invoices");

  // Laundry nobody has priced is reported whether or not anything was created:
  // it is the one outcome an operator cannot see on the invoice itself, since a
  // missing line looks exactly like laundry that was never taken in.
  const unpricedNote = unpriced.length > 0 ? ` ${describeUnpriced(unpriced)}` : "";
  const priceLink = unpriced.length > 0
    ? { href: "/invoices/prices", label: "Set laundry prices" }
    : undefined;

  if (created === 0) {
    return fail("/invoices",
      `Nothing to invoice — ${skipped} customer(s) were already billed for that period, `
      + `or had no charges.${unpricedNote}`,
      priceLink);
  }
  // Said in customers, contracts and jobs rather than in rows: the operator's
  // question is "did everyone get billed", and a consolidated invoice covering
  // two contracts should say so rather than looking like one was missed.
  const parts = [
    contractsBilled > 0 ? `${contractsBilled} contract(s)` : "",
    jobsBilled > 0 ? `${jobsBilled} laundry job(s)` : "",
  ].filter(Boolean);
  const covers = parts.length > 0 ? ` covering ${parts.join(" and ")}` : "";
  const skippedNote = skipped > 0 ? ` ${skipped} customer(s) skipped.` : "";

  const summary = `Created ${created} draft invoice(s)${covers}.${skippedNote}${unpricedNote}`;
  // An unpriced item is a fact the operator has to act on, so it is said as a
  // failure with the screen that fixes it — the invoices were still created.
  return unpriced.length > 0
    ? fail("/invoices", summary, priceLink)
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
  revalidatePath(`/invoices/${id.data}`);
  revalidatePath("/invoices");
  return done(backTo, "Invoice issued.");
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

  const { error } = await supabase.from("payments").insert({
    ...parsed.data, tenant_id: session.tenantId, created_by: session.userId,
  });
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
  }

  await recordAudit(session, {
    entity: "payment", entityId: parsed.data.invoice_id, action: "create",
    summary: `${parsed.data.amount} via ${parsed.data.method}`,
  });
  // Revalidate the routes, not `backTo` — that may carry a query string, which
  // `revalidatePath` does not match against.
  revalidatePath(`/invoices/${parsed.data.invoice_id}`);
  revalidatePath("/invoices");
  return done(backTo, "Payment recorded.");
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

  await recordAudit(session, {
    entity: "invoice", entityId: parsed.data.id, action: "status_change",
    summary: `voided: ${parsed.data.void_reason}`,
  });
  revalidatePath(backTo);
  return done(backTo, "Invoice voided.");
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

  const pdf = await renderInvoicePdf(data);
  const { subject, html, text } = buildInvoiceEmail(data);

  const result = await sendEmail({
    to: recipient,
    subject,
    html,
    text,
    attachments: [{ filename: invoiceFileName(data.invoice.invoice_number), content: pdf }],
  });

  if (!result.ok) {
    // Recorded even on failure: "we tried and it bounced" is exactly the thing
    // someone needs to know when a customer says they never received it.
    await recordAudit(session, {
      entity: "invoice", entityId: parsed.data.id, action: "send_failed",
      summary: `${recipient}: ${result.error}`,
    });
    return fail(backTo, `The invoice could not be sent. ${result.error}`);
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("invoices")
    .update({ emailed_at: new Date().toISOString(), emailed_to: recipient })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) return fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "invoice", entityId: parsed.data.id, action: "send",
    summary: `sent to ${recipient}`,
    metadata: { providerId: result.id },
  });

  revalidatePath(`/invoices/${parsed.data.id}`);
  revalidatePath("/invoices");
  return done(backTo, `Invoice emailed to ${recipient}.`);
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
