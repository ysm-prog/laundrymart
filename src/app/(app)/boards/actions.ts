"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  describeDbError, done, fail, firstIssue, optionalText, optionalUuid, toObject,
} from "@/lib/actions";

/**
 * Creating and maintaining the delivery rounds.
 *
 * A board is the operational unit: work is assigned to it, and whoever is
 * driving it that day signs in as it. Two things here carry more weight than
 * ordinary CRUD, and both are about the login.
 *
 * **A board with no login is a round nobody can work.** `current_board_id()`
 * matches `boards.user_id` to the caller, so an unlinked board has no session
 * that can see its own jobs. The screen says so; this is where the link is made.
 *
 * **A login belongs to one board.** Two boards sharing a login would make
 * `current_board_id()` return whichever the planner happened to reach first,
 * and a round would silently show another's work. Refused by name here rather
 * than left to a `limit 1`.
 */

const boardSchema = z.object({
  code: z.string().trim().min(1, "A short code is required").max(20, "Keep the code short"),
  name: z.string().trim().min(2, "A board name is required"),
  depot_id: optionalUuid,
  default_vehicle_id: optionalUuid,
  user_id: optionalUuid,
  notes: optionalText,
  status: z.enum(["active", "inactive"]),
});

/** Refuse a login that is already another round's. */
async function loginIsFree(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string, userId: string, exceptBoardId?: string,
): Promise<string | null> {
  let query = supabase
    .from("boards").select("id, name")
    .eq("tenant_id", tenantId).eq("user_id", userId).is("deleted_at", null);
  if (exceptBoardId) query = query.neq("id", exceptBoardId);
  const { data } = await query.maybeSingle<{ id: string; name: string }>();
  return data ? `That login already operates ${data.name}.` : null;
}

export async function createBoard(formData: FormData): Promise<void> {
  const session = await assertCapability("fleet.write");
  const parsed = boardSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/boards", firstIssue(parsed.error));

  const supabase = await createClient();

  if (parsed.data.user_id) {
    const taken = await loginIsFree(supabase, session.tenantId, parsed.data.user_id);
    if (taken) return fail("/boards", taken);
  }

  const { data, error } = await supabase
    .from("boards")
    .insert({ ...parsed.data, tenant_id: session.tenantId, created_by: session.userId })
    .select("id, name")
    .single();

  if (error) {
    return fail("/boards", error.code === "23505"
      ? `A board with the code ${parsed.data.code} already exists.`
      : describeDbError(error));
  }

  await recordAudit(session, {
    entity: "board", entityId: data.id, action: "create", summary: data.name,
  });
  revalidatePath("/boards");
  return done("/boards", `${data.name} added.`);
}

export async function linkBoardLogin(formData: FormData): Promise<void> {
  const session = await assertCapability("fleet.write");
  const parsed = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid("Choose a login to link."),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/boards", firstIssue(parsed.error));

  const supabase = await createClient();
  const taken = await loginIsFree(supabase, session.tenantId, parsed.data.user_id, parsed.data.id);
  if (taken) return fail("/boards", taken);

  const { data, error } = await supabase
    .from("boards").update({ user_id: parsed.data.user_id })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId)
    .select("name").maybeSingle<{ name: string }>();
  if (error) return fail("/boards", describeDbError(error));
  if (!data) return fail("/boards", "That board belongs to another laundry.");

  await recordAudit(session, {
    entity: "board", entityId: parsed.data.id, action: "update",
    summary: `${data.name} login linked`,
  });
  revalidatePath("/boards");
  return done("/boards", `${data.name} is now linked to a login and can sign in.`);
}

export async function updateBoardStatus(formData: FormData): Promise<void> {
  const session = await assertCapability("fleet.write");
  const parsed = z.object({
    id: z.string().uuid(),
    status: z.enum(["active", "inactive"]),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail("/boards", firstIssue(parsed.error));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("boards").update({ status: parsed.data.status })
    .eq("id", parsed.data.id).eq("tenant_id", session.tenantId)
    .select("name").maybeSingle<{ name: string }>();
  if (error) return fail("/boards", describeDbError(error));
  if (!data) return fail("/boards", "That board belongs to another laundry.");

  await recordAudit(session, {
    entity: "board", entityId: parsed.data.id, action: "status_change",
    summary: `${data.name} → ${parsed.data.status}`,
  });
  revalidatePath("/boards");
  return done("/boards", `${data.name} is now ${parsed.data.status}.`);
}
