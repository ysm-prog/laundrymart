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
 * A read that fails answers with the default — the simplified workflow — which
 * is also what the database assumes when the key is absent, so a transient
 * error cannot make the app offer a move the trigger would refuse.
 */
export async function laundryWorkflow(supabase: Supabase, tenantId: string): Promise<Workflow> {
  const { data } = await supabase
    .from("tenants").select("settings").eq("id", tenantId)
    .maybeSingle<{ settings: unknown }>();
  return parseOperations(data?.settings).workflow;
}
