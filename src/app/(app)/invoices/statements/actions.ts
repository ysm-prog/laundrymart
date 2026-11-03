"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { done, fail, returnTo } from "@/lib/actions";
import { sendStatement } from "@/lib/invoices/statement";
import {
  SKIP_TEXT, parseStatementDate, summariseStatementSends, type StatementOutcome,
} from "@/lib/domain/statement";
import { businessToday } from "@/lib/domain/timezone";

const LIST = "/invoices/statements";
/** The same cap, and the same reasoning, as `bulk-actions.ts`. */
const MAX_SELECTION = 200;

/**
 * The statement date and the "up to that date" choice, as the screen posted them.
 * Read again on the server rather than trusted: a date in the future becomes today.
 */
function statementOptions(formData: FormData) {
  return {
    asAt: parseStatementDate(formData.get("as_at"), businessToday()),
    upToAsAt: formData.get("upto") !== "0",
  };
}

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
  const result = await sendStatement(supabase, session, parsed.data.id, {
    ...statementOptions(formData), recipient: parsed.data.to,
  });
  revalidatePath(LIST);
  if (result.kind === "skipped") {
    return fail(back, `The statement was not sent: ${result.customer} ${
      result.reason === "no_email" ? "has no billing email" : "owes nothing on it"}.`);
  }
  if (result.kind === "failed") return fail(back, `The statement could not be sent: ${result.reason}.`);
  return done(back, `Statement emailed to ${result.recipient}.`);
}

/**
 * Email a selection of customers their statements. Every outcome is collected, so a
 * bounce on the third does not stop the fortieth, and skips (nothing owed, no email)
 * are counted apart from failures.
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

  const options = statementOptions(formData);
  const supabase = await createClient();
  const outcomes: StatementOutcome[] = [];
  for (const id of selected) outcomes.push(await sendStatement(supabase, session, id, options));

  const count = (kind: StatementOutcome["kind"]) => outcomes.filter((o) => o.kind === kind).length;
  await recordAudit(session, {
    entity: "customer", action: "send",
    summary: `bulk statements as at ${options.asAt}: ${count("sent")} of ${selected.length}`,
    metadata: {
      asAt: options.asAt, sent: count("sent"), skipped: count("skipped"), failed: count("failed"),
      skips: Object.fromEntries(Object.keys(SKIP_TEXT).map((reason) => [
        reason, outcomes.filter((o) => o.kind === "skipped" && o.reason === reason).length,
      ])),
    },
  });
  revalidatePath(LIST);

  const summary = summariseStatementSends(outcomes);
  return summary.ok ? done(back, summary.message) : fail(back, summary.message);
}
