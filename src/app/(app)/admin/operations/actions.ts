"use server";

import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { readOperationsForm } from "@/lib/domain/operations-settings";
import { describeDbError, done, fail } from "@/lib/actions";

const BACK = "/admin/operations";

/** Settings › How you work (brief 3.4, 3.9). The Owner's, like every settings key. */
export async function saveOperationsSettings(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const read = readOperationsForm({
    plantStages: formData.get("plantStages"),
    defaultTurnaroundDays: formData.get("defaultTurnaroundDays"),
  });
  if (!read.ok) return fail(BACK, read.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc("save_tenant_settings", {
    t: session.tenantId, p_key: "operations", p_value: read.value,
  });
  if (error) {
    return fail(BACK, error.code === "22023"
      ? "This setting cannot be saved until the latest database update has been applied."
      : describeDbError(error));
  }

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId, action: "update",
    summary: "operations settings changed", metadata: read.value,
  });
  // The plant switch changes the rail count, Today and Linen, so everything.
  revalidatePath("/", "layout");
  return done(BACK, "Saved.");
}
