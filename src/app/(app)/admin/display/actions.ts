"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, firstIssue, toObject } from "@/lib/actions";
import { serialiseUiMode, UI_MODES, UI_MODE_LABELS } from "@/lib/ui-mode";

const BACK = "/admin/display";

const schema = z.object({ ui_mode: z.enum(UI_MODES) });

export async function saveDisplayMode(formData: FormData): Promise<void> {
  const session = await assertCapability("admin.write");
  const parsed = schema.safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const supabase = await createClient();

  // Read-modify-write on the one settings column, same contract as the
  // notification screen: this form must not reset the preferences it does not
  // show, and that one must not reset this.
  const { data: tenant, error: readError } = await supabase
    .from("tenants").select("settings").eq("id", session.tenantId)
    .maybeSingle<{ settings: unknown }>();
  if (readError) return fail(BACK, describeDbError(readError));

  const { error } = await supabase
    .from("tenants")
    .update({ settings: serialiseUiMode(parsed.data.ui_mode, tenant?.settings) })
    .eq("id", session.tenantId);
  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, {
    entity: "tenant_settings", entityId: session.tenantId, action: "update",
    summary: `menu set to ${parsed.data.ui_mode}`,
  });

  // The menu is rendered by the (app) layout, so it is on every screen in the
  // app rather than on this one — the whole layout tree is revalidated, not
  // just this path. Rare enough (a tenant sets this once) to be worth the sweep.
  revalidatePath("/", "layout");
  return done(BACK, `Menu set to: ${UI_MODE_LABELS[parsed.data.ui_mode].toLowerCase()}.`);
}
