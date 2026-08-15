"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { done, fail, firstIssue, toObject } from "@/lib/actions";
import { approveCompletedJob, generateJobInvoice } from "@/lib/billing/job-billing";

const idsSchema = z.object({ ids: z.string().min(1) });

function ids(formData: FormData): string[] | null {
  const parsed = idsSchema.safeParse(toObject(formData));
  if (!parsed.success) return null;
  const values = parsed.data.ids.split(",").map((value) => value.trim()).filter(Boolean);
  const valid = values.filter((value) => z.string().uuid().safeParse(value).success);
  return valid.length === values.length && valid.length > 0 ? [...new Set(valid)] : null;
}

export async function approveSelectedJobs(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  const selected = ids(formData);
  if (!selected) return fail("/awaiting-invoice", "Select at least one completed job.");
  const supabase = await createClient();
  let approved = 0;
  for (const jobId of selected) {
    const local = new FormData();
    local.set("job_id", jobId);
    try {
      await approveCompletedJob(local);
      approved += 1;
    } catch (error) {
      console.error("bulk approval failed", { jobId, error });
    }
  }
  void session; void supabase;
  revalidatePath("/awaiting-invoice");
  return done("/awaiting-invoice", `Approved ${approved} of ${selected.length} selected job(s).`);
}

export async function generateSelectedJobInvoices(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  const selected = ids(formData);
  if (!selected) return fail("/awaiting-invoice", "Select at least one approved job.");
  let generated = 0;
  for (const jobId of selected) {
    const local = new FormData();
    local.set("job_id", jobId);
    try {
      await generateJobInvoice(local);
      generated += 1;
    } catch (error) {
      console.error("bulk invoice generation failed", { jobId, error });
    }
  }
  void session;
  revalidatePath("/awaiting-invoice");
  revalidatePath("/invoices");
  return done("/awaiting-invoice", `Generated ${generated} of ${selected.length} selected invoice(s).`);
}
