"use server";

import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail } from "@/lib/actions";
import { counted } from "@/lib/format";
import { parseCustomerList } from "@/lib/domain/test-data";
import { planTestDataCleanup, runPricingBackfill, runTestDataCleanup } from "@/lib/admin/tidy";
import { DEFAULT_LATE_CUTOFF } from "@/lib/admin/tidy-defaults";

const BACK = "/admin/data";

/**
 * Hide and restore the business records (0017).
 *
 * Both directions are one RPC, `set_records_archived(t, archive)`, and both go
 * through the caller's **own RLS-bound client** rather than the service-role
 * one. That is the point of the function being SECURITY DEFINER with a
 * membership and role check inside it: `has_role()` resolves `auth.uid()` from
 * the request, so the database decides whether this person may hide this
 * tenant's records. On the admin client there would be no user to check and the
 * tenant id would be whatever the caller passed — the shape CLAUDE.md §3 warns
 * about.
 *
 * `assertCapability("admin.write")` in front of it is the app saying the same
 * thing in the app's vocabulary, so the button is not offered to somebody the
 * database is about to refuse. It is not the boundary; the function is.
 */
async function setArchived(archive: boolean): Promise<never> {
  const session = await assertCapability("admin.write");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("set_records_archived", {
    t: session.tenantId,
    archive,
  });

  if (error) return fail(BACK, describeDbError(error));

  const moved = typeof data === "number" ? data : Number(data ?? 0);

  await recordAudit(session, {
    entity: "tenant",
    entityId: session.tenantId,
    action: "update",
    summary: archive
      ? `Archived the business records (${moved} rows hidden)`
      : `Restored the business records (${moved} rows brought back)`,
    metadata: { archive, rows: moved },
  });

  // The archive touches customers, jobs and invoices, which is most of the app —
  // the rail counts and every list have to be re-read, not served from the
  // router cache. `layout` scope rather than `page` for exactly that reason.
  revalidatePath("/", "layout");

  return done(
    BACK,
    archive
      ? `Your records are hidden. ${moved.toLocaleString()} rows were archived — nothing was deleted.`
      : `Your records are back. ${moved.toLocaleString()} rows were restored.`,
  );
}

export async function archiveRecords(): Promise<void> {
  await setArchived(true);
}

export async function restoreRecords(): Promise<void> {
  await setArchived(false);
}

/* ---------------------------------------------- tidy-up tools (brief 1.3, 1.8) */

/**
 * Price the finished jobs still waiting for a price (brief 1.3). The page's dry
 * run is what offers this button; the work itself re-plans rather than trusting
 * the page. Never approves anything.
 */
export async function priceFinishedJobs(): Promise<void> {
  const session = await assertCapability("admin.write");
  const supabase = await createClient();
  const { priced, needsPrice, failed } = await runPricingBackfill(supabase, session);
  revalidatePath("/invoices/awaiting");
  revalidatePath(BACK);

  const parts = [
    priced > 0 ? `Priced ${counted(priced, "job")}.` : "No job could be priced in full.",
    needsPrice === 1 ? "1 job still needs a price — it is on the Needs a price list." : "",
    needsPrice > 1 ? `${needsPrice} jobs still need a price — they are on the Needs a price list.` : "",
    "Nothing was approved.",
  ].filter(Boolean).join(" ");
  if (failed.length > 0) {
    return fail(`${BACK}?check=pricing`, `${parts} ${failed.length} could not be priced: ${failed.slice(0, 2).join("; ")}`);
  }
  return done(BACK, parts, { href: "/invoices/awaiting", label: "Open Awaiting invoice" });
}

/**
 * Clear out test data (brief 1.8): archive the named customers, void (never
 * delete) their invoices with the reason "Test data", write off and cancel their
 * jobs — and, only when ticked, close the jobs still waiting on a round from
 * before the cutoff. The list is the one the person typed; the plan is rebuilt
 * from it here, inside this laundry, so a posted id can name nothing else.
 */
export async function clearTestData(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const entries = parseCustomerList(String(formData.get("customers") ?? ""));
  const cutoffRaw = String(formData.get("cutoff") ?? "");
  const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(cutoffRaw) ? cutoffRaw : DEFAULT_LATE_CUTOFF;
  const closeLate = formData.get("close_late") === "1";
  if (entries.length === 0 && !closeLate) {
    return fail(`${BACK}?check=testdata`, "Type the customers to clear first, one per line.");
  }

  const supabase = await createClient();
  const plan = await planTestDataCleanup(supabase, session.tenantId, entries, cutoff);
  if (plan.customers.length === 0 && !(closeLate && plan.lateAssigned.length > 0)) {
    return fail(`${BACK}?check=testdata`, "None of those names matched a customer, so nothing was changed.");
  }

  const result = await runTestDataCleanup(supabase, session, plan, { closeLate });
  revalidatePath("/", "layout");

  const summary = `Archived ${counted(result.archived, "customer")}, voided ${counted(result.voided, "invoice")}, `
    + `cancelled ${counted(result.cancelled, "job")} and took ${counted(result.writtenOff, "job")} out of billing`
    + (closeLate ? `, and closed ${counted(result.closed, "late job")}` : "") + ". Nothing was deleted.";
  if (result.problems.length > 0) {
    return fail(BACK, `${summary} Not everything could be done: ${result.problems.slice(0, 3).join("; ")}`
      + (result.problems.length > 3 ? ` and ${result.problems.length - 3} more.` : ""));
  }
  return done(BACK, summary);
}
