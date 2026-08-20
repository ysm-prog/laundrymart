"use server";

import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail } from "@/lib/actions";

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
