"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { addDays } from "@/lib/domain/dates";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail } from "@/lib/actions";

type JobLine = { id: string; item_type: string; custom_description: string | null; exact_quantity: number | null; estimated_quantity: number | null; bag_count: number | null };
type AgreementLine = { id: string; agreement_id: string; item_id: string | null; charge_type: string; unit_price: number; taxable: boolean; notes: string | null };

async function assertFinancialRole(capability: "invoices.approve" | "invoices.write" | "invoices.send") { return assertCapability(capability); }

export async function approveCompletedJob(formData: FormData): Promise<void> {
  const session = await assertFinancialRole("invoices.approve");
  const id = z.string().uuid().safeParse(formData.get("job_id"));
  if (!id.success) return fail("/awaiting-invoice", "That job could not be found.");
  const supabase = await createClient();
  const { data: job, error: jobError } = await supabase.from("laundry_orders")
    .select("id, order_number, status, billing_status, customer_id")
    .eq("id", id.data).eq("tenant_id", session.tenantId).single();
  if (jobError || !job) return fail("/awaiting-invoice", jobError ? describeDbError(jobError) : "That job could not be found.");
  if (job.status !== "completed") return fail("/awaiting-invoice", "Only completed jobs can be approved for invoicing.");
  if (!['awaiting_review','approved'].includes(job.billing_status)) return fail("/awaiting-invoice", `This job is already ${job.billing_status.replace(/_/g, " ")}.`);

  const { data: items } = await supabase.from("laundry_order_items")
    .select("id, item_type, custom_description, exact_quantity, estimated_quantity, bag_count")
    .eq("order_id", job.id).returns<JobLine[]>();
  if (!items?.length) return fail("/awaiting-invoice", "The completed job has no laundry items to approve.");

  const { data: agreements } = await supabase.from("service_agreements")
    .select("id, customer_id, status, version, start_date, end_date")
    .eq("customer_id", job.customer_id).eq("status", "active").is("deleted_at", null)
    .returns<Array<{ id: string; customer_id: string; status: string; version: number; start_date: string; end_date: string | null }>>();
  if (!agreements?.length) return fail("/awaiting-invoice", "No active customer agreement is available for this completed job.");

  const { data: pricing } = await supabase.from("service_agreement_lines")
    .select("id, agreement_id, item_id, charge_type, unit_price, taxable, notes")
    .in("agreement_id", agreements.map((agreement) => agreement.id))
    .returns<AgreementLine[]>();
  const fallbackLines = (pricing ?? []).filter((line) => line.charge_type === "other" || line.charge_type === "wash_only");
  if (fallbackLines.length === 0) {
    return fail("/awaiting-invoice", "Customer pricing is configured, but there is no safe mapping from the job's laundry items to a billable rate. Add an explicit mapped/catch-all agreement line before approving.");
  }

  const existing = await supabase.from("job_charge_snapshots").select("id").eq("job_id", job.id).limit(1);
  if (existing.data?.length && job.billing_status === "approved") return fail("/awaiting-invoice", `Job ${job.order_number} is already approved; its price snapshot is preserved.`);
  await supabase.from("job_charge_snapshots").delete().eq("job_id", job.id);

  const snapshots: Record<string, unknown>[] = [];
  for (const item of items) {
    const quantity = Number(item.exact_quantity ?? item.estimated_quantity ?? item.bag_count ?? 1);
    const rate = fallbackLines.find((line) => line.notes?.toLowerCase().includes(item.item_type.toLowerCase())) ?? fallbackLines[0];
    snapshots.push({
      tenant_id: session.tenantId, job_id: job.id, source_agreement_id: rate.agreement_id,
      source_agreement_line_id: rate.id, item_description: item.custom_description || item.item_type,
      quantity, unit_price: Number(rate.unit_price ?? 0), taxable: rate.taxable,
      charge_type: rate.charge_type, created_by: session.userId,
    });
  }
  const { error: insertError } = await supabase.from("job_charge_snapshots").insert(snapshots);
  if (insertError) return fail("/awaiting-invoice", describeDbError(insertError));
  const { error } = await supabase.from("laundry_orders").update({
    billing_status: "approved", billing_approved_at: new Date().toISOString(), billing_approved_by: session.userId,
  }).eq("id", job.id).eq("tenant_id", session.tenantId);
  if (error) return fail("/awaiting-invoice", describeDbError(error));
  await recordAudit(session, { entity: "laundry_order", entityId: job.id, action: "generate", summary: `${job.order_number} approved for invoice`, metadata: { billing_status: "approved", snapshot_lines: snapshots.length } });
  revalidatePath("/awaiting-invoice"); revalidatePath(`/orders/${job.id}`);
  return done("/awaiting-invoice", `Job ${job.order_number} approved for invoicing.`);
}

export async function generateJobInvoice(formData: FormData): Promise<void> {
  const session = await assertFinancialRole("invoices.write");
  const id = z.string().uuid().safeParse(formData.get("job_id"));
  if (!id.success) return fail("/awaiting-invoice", "That job could not be found.");
  const supabase = await createClient();
  const { data: job, error: jobError } = await supabase.from("laundry_orders")
    .select("id, order_number, status, billing_status, customer_id, completed_at")
    .eq("id", id.data).eq("tenant_id", session.tenantId).single();
  if (jobError || !job) return fail("/awaiting-invoice", jobError ? describeDbError(jobError) : "That job could not be found.");
  if (job.status !== "completed") return fail("/awaiting-invoice", "Only completed jobs can be invoiced.");
  if (["invoice_generated", "invoice_sent", "paid"].includes(job.billing_status)) return fail("/awaiting-invoice", `Invoice already generated for job ${job.order_number}.`);
  if (job.billing_status !== "approved") return fail("/awaiting-invoice", "Approve the completed job before generating its invoice.");
  const { data: existingSource } = await supabase.from("invoice_source_jobs").select("invoice_id").eq("job_id", job.id).maybeSingle<{ invoice_id: string }>();
  if (existingSource) return fail("/awaiting-invoice", `An invoice is already linked to job ${job.order_number}.`);
  const { data: snapshotRows, error: snapshotError } = await supabase.from("job_charge_snapshots")
    .select("id, item_description, quantity, unit_price, amount, taxable, charge_type, job_id")
    .eq("job_id", job.id)
    .returns<Array<{ id: string; item_description: string; quantity: number; unit_price: number; amount: number; taxable: boolean; charge_type: string; job_id: string }>>();
  if (snapshotError) return fail("/awaiting-invoice", describeDbError(snapshotError));
  if (!snapshotRows?.length) return fail("/awaiting-invoice", "Approve the job first so its agreed prices are snapshotted.");
  const { data: customer, error: customerError } = await supabase.from("customers")
    .select("id, payment_terms_days, depot_id, purchase_order_number").eq("id", job.customer_id)
    .single<{ id: string; payment_terms_days: number; depot_id: string | null; purchase_order_number: string | null }>();
  if (customerError || !customer) return fail("/awaiting-invoice", customerError ? describeDbError(customerError) : "Customer could not be loaded.");
  const { data: invoiceNumber, error: numberError } = await supabase.rpc("next_number", { t: session.tenantId, k: "invoice", p: "INV" });
  if (numberError) return fail("/awaiting-invoice", describeDbError(numberError));
  const issueDate = job.completed_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const terms = Number(customer.payment_terms_days ?? 14);
  const { data: invoice, error: invoiceError } = await supabase.from("invoices").insert({
    tenant_id: session.tenantId, created_by: session.userId, customer_id: job.customer_id, depot_id: customer.depot_id,
    invoice_number: invoiceNumber as string, invoice_type: "manual", source_type: "job", source_job_id: job.id,
    status: "draft", issue_date: issueDate, due_date: addDays(issueDate, terms), payment_terms_days: terms,
    purchase_order_number: customer.purchase_order_number,
  }).select("id, invoice_number").single<{ id: string; invoice_number: string }>();
  if (invoiceError || !invoice) return fail("/awaiting-invoice", invoiceError ? describeDbError(invoiceError) : "Invoice could not be created.");
  const { error: sourceError } = await supabase.from("invoice_source_jobs").insert({ tenant_id: session.tenantId, invoice_id: invoice.id, job_id: job.id, created_by: session.userId });
  if (sourceError) return fail("/awaiting-invoice", describeDbError(sourceError));
  const { error: lineError } = await supabase.from("invoice_lines").insert(snapshotRows.map((line, index) => ({
    tenant_id: session.tenantId, created_by: session.userId, invoice_id: invoice.id, job_id: job.id,
    description: line.item_description, charge_type: line.charge_type, quantity: line.quantity,
    unit_price: line.unit_price, amount: line.amount, taxable: line.taxable, sequence: index + 1,
  })));
  if (lineError) return fail("/awaiting-invoice", describeDbError(lineError));
  const { error: totalError } = await supabase.rpc("recalculate_invoice", { p_invoice: invoice.id });
  if (totalError) return fail("/awaiting-invoice", describeDbError(totalError));
  const { error: jobError2 } = await supabase.from("laundry_orders").update({ billing_status: "invoice_generated", billed_invoice_id: invoice.id }).eq("id", job.id).eq("tenant_id", session.tenantId);
  if (jobError2) return fail("/awaiting-invoice", describeDbError(jobError2));
  await recordAudit(session, { entity: "invoice", entityId: invoice.id, action: "generate", summary: `${invoice.invoice_number} from ${job.order_number}`, metadata: { job_id: job.id, source_type: "job" } });
  revalidatePath("/awaiting-invoice"); revalidatePath("/invoices"); revalidatePath(`/invoices/${invoice.id}`);
  return done(`/invoices/${invoice.id}`, `Invoice ${invoice.invoice_number} generated; it has not been sent.`);
}
