"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { done, fail, returnTo } from "@/lib/actions";
import { sendStatement } from "@/lib/invoices/statement";

const LIST = "/invoices/statements";
/** The same cap, and the same reasoning, as `bulk-actions.ts`. */
const MAX_SELECTION = 200;

/** Email one customer their statement. */
export async function emailStatement(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.send");
  const parsed = z.object({
    id: z.string().uuid(),
    to: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().email("That is not a valid email address").optional(),
    ),
  }).safeParse({ id: formData.get("id"), to: formData.get("to") ?? undefined });
  const back = returnTo(formData, LIST);
  if (!parsed.success) return fail(back, parsed.error.issues[0]?.message ?? "That could not be read.");

  const supabase = await createClient();
  const result = await sendStatement(supabase, session, parsed.data.id, parsed.data.to);
  if (!result.ok) return fail(back, `The statement could not be sent: ${result.error}.`);
  return done(back, `Statement emailed to ${result.recipient}.`);
}

/**
 * Email a selection of customers their statements. Every outcome is collected, so a
 * bounce on the third does not stop the fortieth, and both numbers are reported.
 */
export async function sendSelectedStatements(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.bulk");
  await assertCapability("invoices.send");

  const back = returnTo(formData, LIST);
  const raw = formData.getAll("selected").filter((value): value is string => typeof value === "string");
  const ids = z.array(z.string().uuid()).safeParse(raw);
  if (!ids.success) return fail(back, "That selection could not be read. Please try again.");
  const selected = [...new Set(ids.data)];
  if (selected.length === 0) return fail(back, "Select at least one customer.");
  if (selected.length > MAX_SELECTION) return fail(back, `Select ${MAX_SELECTION} customers or fewer at a time.`);

  const supabase = await createClient();
  let sent = 0;
  const failed: Array<{ customer: string; reason: string }> = [];
  for (const id of selected) {
    const result = await sendStatement(supabase, session, id);
    if (result.ok) sent += 1;
    else failed.push({ customer: result.customer ?? "A customer", reason: result.error });
  }

  await recordAudit(session, {
    entity: "customer", action: "send",
    summary: `bulk statements: ${sent} of ${selected.length}`,
    metadata: { sent, failed: failed.length },
  });
  revalidatePath(LIST);

  const first = failed[0];
  if (sent === 0) return fail(back, first ? `${first.customer}: ${first.reason}.` : "Nothing was sent.");
  const note = first ? ` ${failed.length} could not be sent. ${first.customer}: ${first.reason}.` : "";
  return done(back, `Sent ${sent} ${sent === 1 ? "statement" : "statements"}.${note}`);
}
