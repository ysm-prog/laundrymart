"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability, type Session } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { addDays } from "@/lib/domain/dates";
import { generateServiceDates, parsePattern, type HolidayRule } from "@/lib/domain/service-calendar";
import {
  allocateWeightCharges, buildReplacementCharges, buildServiceCharges, lineAmount,
  resolvePrice, round2,
  type DraftLine,
} from "@/lib/domain/pricing";
import {
  count, describeDbError, done, fail, firstIssue, money, optionalText,
  optionalUuid, requiredDate, returnTo, toObject,
} from "@/lib/actions";
import { loadInvoiceForPdf } from "@/lib/pdf/invoice-data";
import { invoiceFileName, renderInvoicePdf } from "@/lib/pdf/render";
import { buildInvoiceEmail } from "@/lib/email/invoice-email";
import { sendEmail } from "@/lib/email/send";

type BillableAgreement = {
  id: string;
  customer_id: string;
  depot_id: string | null;
  location_id: string | null;
  start_date: string;
  end_date: string | null;
  pickup_pattern: unknown;
  minimum_charge: number;
  holiday_rule: string;
  holiday_region: string;
  weekend_surcharge_pct: number;
  holiday_surcharge_pct: number;
  fuel_levy_pct: number;
  payment_terms_days: number;
  purchase_order_number: string | null;
  emergency_service: boolean;
};

type BillableLine = {
  id: string;
  agreement_id: string;
  item_id: string | null;
  charge_type: string;
  pricing_model: string;
  unit_price: number;
  percentage: number | null;
  standard_quantity: number;
  included_quantity: number;
  taxable: boolean;
  items: { name: string; sku: string; rental_price: number; wash_only_price: number; replacement_cost: number } | null;
};

/**
 * Generate recurring invoices for a billing period.
 *
 * For each active agreement the generator:
 *  1. expands the service calendar over the period (holiday rules applied);
 *  2. prices the agreement's lines by visit count;
 *  3. tops up to the minimum charge and applies levies/surcharges;
 *  4. adds replacement charges for anything damaged or missing on the run.
 *
 * Customers that already have a recurring invoice for the exact period are
 * skipped, so re-running after a fix does not double-bill.
 */
export async function generateInvoices(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    period_start: requiredDate,
    period_end: requiredDate,
  }).safeParse(toObject(formData));
  if (!parsed.success) fail("/invoices", firstIssue(parsed.error));

  const { period_start: start, period_end: end } = parsed.data;
  if (start > end) fail("/invoices", "The period start must be on or before the period end.");

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
  if (agreementError) fail("/invoices", describeDbError(agreementError));

  const live = (agreements ?? []).filter((a) => !a.end_date || a.end_date >= start);
  if (live.length === 0) fail("/invoices", "No active agreements cover that period.");

  const { data: holidayRows } = await supabase
    .from("public_holidays").select("holiday_date, region")
    .gte("holiday_date", start).lte("holiday_date", end);

  const { data: agreementLines } = await supabase
    .from("service_agreement_lines")
    .select("id, agreement_id, item_id, charge_type, pricing_model, unit_price, percentage, " +
            "standard_quantity, included_quantity, taxable, " +
            "items(name, sku, rental_price, wash_only_price, replacement_cost)")
    .in("agreement_id", live.map((a) => a.id))
    .returns<BillableLine[]>();

  const linesByAgreement = new Map<string, BillableLine[]>();
  for (const line of agreementLines ?? []) {
    const bucket = linesByAgreement.get(line.agreement_id) ?? [];
    bucket.push(line);
    linesByAgreement.set(line.agreement_id, bucket);
  }

  let created = 0;
  let skipped = 0;

  for (const agreement of live) {
    const { data: existing } = await supabase
      .from("invoices").select("id")
      .eq("customer_id", agreement.customer_id)
      .eq("invoice_type", "recurring")
      .eq("period_start", start).eq("period_end", end)
      .maybeSingle();
    if (existing) { skipped += 1; continue; }

    const holidays = (holidayRows ?? [])
      .filter((row) => row.region === agreement.holiday_region)
      .map((row) => row.holiday_date as string);

    const visits = generateServiceDates({
      pattern: parsePattern(agreement.pickup_pattern),
      from: start, to: end,
      holidays,
      holidayRule: agreement.holiday_rule as HolidayRule,
      startDate: agreement.start_date,
      endDate: agreement.end_date,
    });

    const lines = linesByAgreement.get(agreement.id) ?? [];

    // Per-kg lines bill what the run actually weighed, not what the pattern
    // predicted, so the weight comes from the period's pickups rather than from
    // the service calendar (§11).
    const weightLines = lines.filter((line) => line.pricing_model === "per_kg");
    const weightByLine = new Map<string, { billableKg: number; allowanceKg: number }>();
    let weighedCollections = 0;

    if (weightLines.length > 0) {
      const { data: weighed } = await supabase
        .from("pickups")
        .select("total_weight_kg")
        .eq("customer_id", agreement.customer_id)
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

    const serviceItems = lines.flatMap((line) => {
      const item = line.items;

      // Pricing precedence §11: agreement line first, then the item default.
      // A per-kg line is a rate per kilogram, and no item carries one, so it can
      // only ever be priced by the agreement itself.
      const { price } = resolvePrice({
        agreementLinePrice: line.unit_price > 0 ? line.unit_price : null,
        itemPrice: line.pricing_model === "per_kg"
          ? null
          : line.charge_type === "wash_only" ? item?.wash_only_price : item?.rental_price,
      });

      const quantity = (() => {
        switch (line.pricing_model) {
          case "per_item": return Math.max(0, line.standard_quantity - line.included_quantity) * visits.length;
          case "per_collection": return visits.length;
          case "per_kg": return weightByLine.get(line.id)?.billableKg ?? 0;
          case "monthly": return 1;
          default: return 0; // percentage lines charge off the subtotal below
        }
      })();

      if (quantity <= 0 || price <= 0) return [];

      const detail = (() => {
        switch (line.pricing_model) {
          case "per_collection":
            return `${visits.length} collection(s)`;
          case "per_kg": {
            const allowance = weightByLine.get(line.id)?.allowanceKg ?? 0;
            return `${quantity} kg over ${weighedCollections} collection(s)` +
              (allowance > 0 ? `, ${allowance} kg included` : "");
          }
          default:
            return `${quantity} × ${start} to ${end}`;
        }
      })();

      return [{
        itemId: line.item_id,
        description: `${item?.name ?? "Service"} — ${detail}`,
        quantity: round2(quantity),
        unitPrice: price,
        chargeType: line.charge_type as DraftLine["chargeType"],
        taxable: line.taxable,
      }];
    });

    // Percentage lines are a rate against the service subtotal, so they are
    // handed to the pricing engine alongside the levies to share one base.
    const percentageLines = lines.flatMap((line) =>
      line.pricing_model === "percentage" && Number(line.percentage ?? 0) > 0
        ? [{
            label: line.items?.name ?? "Agreement charge",
            pct: Number(line.percentage),
            chargeType: line.charge_type as DraftLine["chargeType"],
            itemId: line.item_id,
            taxable: line.taxable,
          }]
        : [],
    );

    const draft = buildServiceCharges({
      items: serviceItems,
      percentageLines,
      minimumCharge: Number(agreement.minimum_charge ?? 0),
      fuelLevyPct: Number(agreement.fuel_levy_pct ?? 0),
      weekendSurchargePct: Number(agreement.weekend_surcharge_pct ?? 0),
      holidaySurchargePct: Number(agreement.holiday_surcharge_pct ?? 0),
      servicedOnWeekend: visits.some((visit) => visit.isWeekend),
      servicedOnHoliday: visits.some((visit) => visit.isPublicHoliday),
    });

    // Damaged and missing linen picked up during the period becomes a
    // replacement charge on the same invoice (§11).
    const { data: damaged } = await supabase
      .from("pickup_lines")
      .select("item_id, damaged_quantity, missing_quantity, " +
              "pickups!inner(customer_id, pickup_date), items(name, replacement_cost)")
      .eq("pickups.customer_id", agreement.customer_id)
      .gte("pickups.pickup_date", start).lte("pickups.pickup_date", end)
      .returns<Array<{
        item_id: string; damaged_quantity: number; missing_quantity: number;
        items: { name: string; replacement_cost: number } | null;
      }>>();

    draft.push(...buildReplacementCharges(
      (damaged ?? []).map((row) => ({
        itemId: row.item_id,
        itemName: row.items?.name ?? "Item",
        damagedQuantity: row.damaged_quantity,
        missingQuantity: row.missing_quantity,
        replacementCost: Number(row.items?.replacement_cost ?? 0),
      })),
    ));

    if (draft.length === 0) { skipped += 1; continue; }

    const { data: invoiceNumber, error: numberError } = await supabase
      .rpc("next_number", { t: session.tenantId, k: "invoice", p: "INV" });
    if (numberError) fail("/invoices", describeDbError(numberError));

    const terms = Number(agreement.payment_terms_days ?? 14);
    const { data: invoice, error } = await supabase
      .from("invoices")
      .insert({
        tenant_id: session.tenantId,
        created_by: session.userId,
        customer_id: agreement.customer_id,
        depot_id: agreement.depot_id,
        invoice_number: invoiceNumber as string,
        invoice_type: "recurring",
        status: "draft",
        issue_date: end,
        due_date: addDays(end, terms),
        period_start: start,
        period_end: end,
        payment_terms_days: terms,
        purchase_order_number: agreement.purchase_order_number,
      })
      .select("id")
      .single();
    if (error) fail("/invoices", describeDbError(error));

    const { error: lineError } = await supabase.from("invoice_lines").insert(
      draft.map((line, index) => ({
        tenant_id: session.tenantId,
        created_by: session.userId,
        invoice_id: invoice.id,
        item_id: line.itemId ?? null,
        agreement_id: agreement.id,
        location_id: agreement.location_id,
        description: line.description,
        charge_type: line.chargeType,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        amount: line.amount,
        taxable: line.taxable,
        sequence: index + 1,
      })),
    );
    if (lineError) fail("/invoices", describeDbError(lineError));

    const { error: totalError } = await supabase.rpc("recalculate_invoice", { p_invoice: invoice.id });
    if (totalError) fail("/invoices", describeDbError(totalError));

    created += 1;
  }

  await recordAudit(session, {
    entity: "invoice", action: "generate",
    summary: `${created} invoice(s) for ${start} – ${end}`,
    metadata: { start, end, created, skipped },
  });
  revalidatePath("/invoices");

  if (created === 0) {
    fail("/invoices", `Nothing to invoice — ${skipped} agreement(s) already billed or had no charges.`);
  }
  done("/invoices", `Generated ${created} draft invoice(s). ${skipped} skipped.`);
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
  if (!parsed.success) fail("/invoices", firstIssue(parsed.error));

  const supabase = await createClient();
  const { data: invoiceNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "invoice", p: "INV" });
  if (numberError) fail("/invoices", describeDbError(numberError));

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
  if (error) fail("/invoices", describeDbError(error));

  await recordAudit(session, {
    entity: "invoice", entityId: data.id, action: "create", summary: data.invoice_number,
  });
  revalidatePath("/invoices");

  // Raised from the billing two-pane, the new draft opens in the pane the user
  // is already working in rather than throwing them onto a full page.
  const inPane = formData.get("pane") === "1";
  done(
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
  if (!parsed.success) fail("/invoices", firstIssue(parsed.error));

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
  if (error) fail(backTo, describeDbError(error));

  const { error: totalError } = await supabase
    .rpc("recalculate_invoice", { p_invoice: parsed.data.invoice_id });
  if (totalError) fail(backTo, describeDbError(totalError));

  await recordAudit(session, {
    entity: "invoice_line", entityId: parsed.data.invoice_id, action: "create",
    summary: parsed.data.description,
  });
  revalidatePath(backTo);
  done(backTo, "Line added.");
}

export async function removeInvoiceLine(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    id: z.string().uuid(), invoice_id: z.string().uuid(),
  }).safeParse(toObject(formData));
  if (!parsed.success) fail("/invoices", firstIssue(parsed.error));

  const backTo = `/invoices/${parsed.data.invoice_id}`;
  const supabase = await createClient();
  const { error } = await supabase
    .from("invoice_lines").delete()
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) fail(backTo, describeDbError(error));

  await supabase.rpc("recalculate_invoice", { p_invoice: parsed.data.invoice_id });
  revalidatePath(backTo);
  done(backTo, "Line removed.");
}

export async function issueInvoice(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) fail("/invoices", "That invoice could not be found.");

  const backTo = returnTo(formData, `/invoices/${id.data}`);
  const supabase = await createClient();
  await supabase.rpc("recalculate_invoice", { p_invoice: id.data });

  const { error } = await supabase
    .from("invoices")
    .update({ status: "issued", issued_at: new Date().toISOString() })
    .eq("id", id.data).eq("tenant_id", session.tenantId).eq("status", "draft");
  if (error) fail(backTo, describeDbError(error));

  await recordAudit(session, { entity: "invoice", entityId: id.data, action: "status_change", summary: "issued" });
  revalidatePath(`/invoices/${id.data}`);
  revalidatePath("/invoices");
  done(backTo, "Invoice issued.");
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
  if (!parsed.success) fail("/invoices", firstIssue(parsed.error));

  const backTo = returnTo(formData, `/invoices/${parsed.data.invoice_id}`);
  const supabase = await createClient();

  const { error } = await supabase.from("payments").insert({
    ...parsed.data, tenant_id: session.tenantId, created_by: session.userId,
  });
  if (error) fail(backTo, describeDbError(error));

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
  done(backTo, "Payment recorded.");
}

export async function voidInvoice(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");
  const parsed = z.object({
    id: z.string().uuid(),
    void_reason: z.string().trim().min(3, "Give a reason for voiding"),
  }).safeParse(toObject(formData));
  if (!parsed.success) fail("/invoices", firstIssue(parsed.error));

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
  if (error) fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "invoice", entityId: parsed.data.id, action: "status_change",
    summary: `voided: ${parsed.data.void_reason}`,
  });
  revalidatePath(backTo);
  done(backTo, "Invoice voided.");
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
  if (!parsed.success) fail("/invoices", firstIssue(parsed.error));

  const backTo = `/invoices/${parsed.data.invoice_id}`;
  const supabase = await createClient();

  const { data: creditNumber, error: numberError } = await supabase
    .rpc("next_number", { t: session.tenantId, k: "credit_note", p: "CN" });
  if (numberError) fail(backTo, describeDbError(numberError));

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
  if (error) fail(backTo, describeDbError(error));

  const { error: lineError } = await supabase.from("credit_note_lines").insert({
    tenant_id: session.tenantId,
    created_by: session.userId,
    credit_note_id: note.id,
    description: parsed.data.reason,
    quantity: 1,
    unit_price: parsed.data.amount,
    amount: parsed.data.amount,
  });
  if (lineError) fail(backTo, describeDbError(lineError));

  await recordAudit(session, {
    entity: "credit_note", entityId: note.id, action: "create",
    summary: `${note.credit_note_number} against invoice`,
  });
  revalidatePath(backTo);
  done(backTo, `Credit note ${note.credit_note_number} issued.`);
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
  if (!parsed.success) fail("/invoices", firstIssue(parsed.error));

  const backTo = returnTo(formData, `/invoices/${parsed.data.id}`);

  const data = await loadInvoiceForPdf(parsed.data.id, session.tenantId);
  if (!data) fail(backTo, "That invoice could not be found.");

  if (data.invoice.status === "draft") {
    fail(backTo, "Issue the invoice before emailing it — a draft can still change.");
  }
  if (data.invoice.status === "void") {
    fail(backTo, "This invoice is void and cannot be sent.");
  }

  const recipient = parsed.data.to ?? data.customer.billing_email;
  if (!recipient) {
    fail(backTo, "This customer has no billing email. Add one, or type an address to send to.");
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
    fail(backTo, `The invoice could not be sent. ${result.error}`);
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("invoices")
    .update({ emailed_at: new Date().toISOString(), emailed_to: recipient })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId);
  if (error) fail(backTo, describeDbError(error));

  await recordAudit(session, {
    entity: "invoice", entityId: parsed.data.id, action: "send",
    summary: `sent to ${recipient}`,
    metadata: { providerId: result.id },
  });

  revalidatePath(`/invoices/${parsed.data.id}`);
  revalidatePath("/invoices");
  done(backTo, `Invoice emailed to ${recipient}.`);
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
