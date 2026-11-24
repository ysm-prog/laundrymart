import type { createClient } from "@/lib/supabase/server";
import { parseOperations, type Workflow } from "@/lib/domain/operations-settings";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Which workflow this laundry runs (change request 3, Settings › How you work).
 *
 * Read from `tenants.settings.operations.workflow`, the same key 0065's
 * transition guard reads, so the screen and the database agree. Names the
 * tenant (§23): a platform admin's session reads every laundry, and this answer
 * decides what a write scoped to one of them does.
 *
 * An absent key is the simplified workflow, here and in 0065. A read that
 * **fails**, or a tenant row the caller cannot see, is answered as `full`
 * instead (2026-11-24): that is what the trigger does with a row it cannot
 * read, and it is the safe answer — the simplified workflow completes a new job
 * on save, and a transient error in a Full laundry must not finish a job nobody
 * meant to finish.
 */
export async function laundryWorkflow(supabase: Supabase, tenantId: string): Promise<Workflow> {
  const { data, error } = await supabase
    .from("tenants").select("settings").eq("id", tenantId)
    .maybeSingle<{ settings: unknown }>();
  return workflowFromRead({ data, error });
}

/** The rule above, apart from the query so it can be tested. */
export function workflowFromRead(read: { data: { settings: unknown } | null; error: unknown }): Workflow {
  if (read.error || !read.data) return "full";
  return parseOperations(read.data.settings).workflow;
}
