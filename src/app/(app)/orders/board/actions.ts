"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { done, fail } from "@/lib/actions";
import { normaliseDocket } from "@/lib/domain/laundry-board";
import { markOrderReady, type MarkReadyOutcome } from "@/lib/orders/mark-ready";
import { autoAssignSentence } from "@/lib/runs/auto-assign";

const BOARD = "/orders/board";
const MAX_SELECTION = 200;

function refresh() {
  revalidatePath(BOARD);
  revalidatePath("/orders");
  revalidatePath("/dashboard");
  revalidatePath("/my-runs");
}

/**
 * Mark ready, for a selection on the board (brief 3.3). One request, capped and
 * refused past the cap; each job goes through `markOrderReady`, so forty move
 * exactly as one does on the job page. Partial success is said as one.
 */
export async function markSelectedReady(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.status");
  const ids = z.array(z.string().uuid())
    .safeParse(formData.getAll("selected").filter((value) => typeof value === "string"));
  if (!ids.success) return fail(BOARD, "That selection could not be read. Please try again.");
  const unique = [...new Set(ids.data)];
  if (unique.length === 0) return fail(BOARD, "Tick at least one job in the plant.");
  if (unique.length > MAX_SELECTION) return fail(BOARD, `Mark at most ${MAX_SELECTION} at a time.`);

  const supabase = await createClient();
  const outcomes: MarkReadyOutcome[] = [];
  for (const id of unique) outcomes.push(await markOrderReady(supabase, session, id));
  refresh();

  const moved = outcomes.filter((outcome) => outcome.ok);
  const refused = outcomes.filter((outcome): outcome is Extract<MarkReadyOutcome, { ok: false }> => !outcome.ok);
  const onRounds = moved.filter((outcome) => outcome.ok && outcome.assigned.state === "assigned").length;
  const waiting = moved.length - onRounds;

  if (moved.length === 0) {
    return fail(BOARD, `Nothing moved — ${refused[0]!.orderNumber}: ${refused[0]!.reason}.`);
  }
  const parts = [`${moved.length} job(s) marked ready.`];
  if (onRounds > 0) parts.push(`${onRounds} went onto the customer's round.`);
  if (waiting > 0) parts.push(`${waiting} are waiting for a driver or for the customer.`);
  if (refused.length > 0) parts.push(`${refused.length} did not move (${refused[0]!.orderNumber}: ${refused[0]!.reason}).`);
  return refused.length > 0 ? fail(BOARD, parts.join(" ")) : done(BOARD, parts.join(" "));
}

/**
 * The docket scan (brief 3.3): a handheld scanner types the job number off the
 * docket's barcode and presses Enter, and the job is marked ready. A job
 * number typed by hand works the same way — see `normaliseDocket`.
 */
export async function scanDocket(formData: FormData): Promise<void> {
  const session = await assertCapability("orders.status");
  const raw = String(formData.get("docket") ?? "");
  const number = normaliseDocket(raw);
  if (!number) return fail(BOARD, raw.trim() ? `“${raw.trim()}” is not a job number.` : "Scan or type a job number.");

  const supabase = await createClient();
  const { data: order } = await supabase
    .from("laundry_orders").select("id")
    .eq("tenant_id", session.tenantId).eq("order_number", number)
    .maybeSingle<{ id: string }>();
  if (!order) return fail(BOARD, `There is no job ${number} in this laundry.`);

  const outcome = await markOrderReady(supabase, session, order.id);
  refresh();
  if (!outcome.ok) return fail(BOARD, `${outcome.orderNumber} did not move: ${outcome.reason}.`);
  return done(BOARD, `${outcome.orderNumber} is ready.${autoAssignSentence(outcome.assigned)}`,
              { href: `/orders/${order.id}`, label: "Open the job" });
}
