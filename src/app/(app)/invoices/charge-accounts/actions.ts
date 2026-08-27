"use server";

import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { counted } from "@/lib/format";
import { describeDbError, done, fail } from "@/lib/actions";
import { parseChargeAccountForm } from "./charge-account-form";

const BACK = "/invoices/charge-accounts";

/**
 * Set the default account for each kind of charge.
 *
 * `purchases.write`, not `invoices.write`: every value on this screen is an
 * account id, and 0036 put the chart of accounts behind `purchases.*`. Gating
 * the map more weakly than the chart it points into would be a side channel onto
 * the chart.
 *
 * **Read, then insert / update / delete — not an upsert.** The same call
 * `laundry_prices` documents, and for a reason that is not style: diffing means
 * a save never has a window in which a laundry's defaults are missing, and it
 * keeps this writer independent of whether PostgREST can infer the constraint
 * behind `on_conflict=`, which this repo has been bitten by once (42P10 on a
 * partial index, found only at request time).
 *
 * A cleared charge type is **deleted** rather than stored as a null. Two
 * spellings of "no default" would make `chargeTypeAccounts()` decide which one
 * counted, and the reader deliberately has no opinion.
 */
export async function saveChargeTypeAccounts(formData: FormData): Promise<void> {
  const session = await assertCapability("purchases.write");
  const parsed = parseChargeAccountForm(formData);
  if (!parsed.ok) return fail(BACK, parsed.error);

  const supabase = await createClient();
  const { data: existing, error: readError } = await supabase
    .from("charge_type_accounts")
    .select("id, charge_type, gl_account_id")
    .eq("tenant_id", session.tenantId)
    .returns<Array<{ id: string; charge_type: string; gl_account_id: string | null }>>();
  if (readError) return fail(BACK, describeDbError(readError));

  const byType = new Map((existing ?? []).map((row) => [row.charge_type, row]));

  const inserts = parsed.entries
    .filter((entry) => !byType.has(entry.chargeType))
    .map((entry) => ({
      tenant_id: session.tenantId,
      created_by: session.userId,
      charge_type: entry.chargeType,
      gl_account_id: entry.accountId,
    }));

  const updates = parsed.entries
    .map((entry) => ({ entry, row: byType.get(entry.chargeType) }))
    .filter((pair) => pair.row && pair.row.gl_account_id !== pair.entry.accountId);

  const removals = parsed.cleared
    .map((chargeType) => byType.get(chargeType))
    .filter((row): row is { id: string; charge_type: string; gl_account_id: string | null } =>
      Boolean(row));

  if (inserts.length > 0) {
    const { error } = await supabase.from("charge_type_accounts").insert(inserts);
    if (error) return fail(BACK, describeDbError(error));
  }
  for (const { entry, row } of updates) {
    const { error } = await supabase
      .from("charge_type_accounts")
      .update({ gl_account_id: entry.accountId })
      .eq("id", row!.id)
      .eq("tenant_id", session.tenantId);
    if (error) return fail(BACK, describeDbError(error));
  }
  if (removals.length > 0) {
    const { error } = await supabase
      .from("charge_type_accounts").delete()
      .in("id", removals.map((row) => row.id))
      .eq("tenant_id", session.tenantId);
    if (error) return fail(BACK, describeDbError(error));
  }

  const changed = inserts.length + updates.length + removals.length;
  await recordAudit(session, {
    entity: "charge_type_account", entityId: session.tenantId, action: "update",
    summary: `${counted(changed, "default")} changed`,
  });
  revalidatePath(BACK);

  /*
   * **Says plainly that nothing already invoiced moves.** A default is read when
   * a charge is written and when a draft's job lines are rebuilt, so changing it
   * codes the work that has not been billed yet and leaves an issued invoice
   * exactly as the customer received it. An operator who expected a retrospective
   * fix and was told only "Saved" would go looking for a bug.
   */
  return done(BACK, changed === 0
    ? "No changes to save."
    : `${counted(changed, "default")} saved. New charges are coded from now on; `
      + "invoices already issued are unchanged.");
}
