"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  describeDbError, done, fail, firstIssue, returnTo, toObject,
} from "@/lib/actions";
import { sweepVehicleToDepot } from "@/lib/routes/unload";
import { confirmRunJobsLoaded, dispatchRunJobs } from "@/lib/orders/complete";

/**
 * Where these actions land when the caller does not say.
 *
 * These belong to `/run`, the depot screen: the load, the road, the return, the
 * unload sweep and the close. My Runs has its own Confirm Load and Start Route,
 * shaped around a driver's *day* rather than a run — but both end up writing the
 * same facts through `confirmRunJobsLoaded` and `dispatchRunJobs`, so the two
 * screens cannot disagree about what is on the van.
 *
 * Each form carries a `return_to` and the action comes back to whichever screen
 * pressed it. `returnTo()` only honours a plain same-site path.
 */
const DEFAULT_BACK = "/run";

/** Both screens that show a run, so a status move refreshes whichever is open. */
function revalidateRunScreens(): void {
  revalidatePath(DEFAULT_BACK);
  revalidatePath("/my-runs");
}

/**
 * The vehicle inspection is gone from the workflow.
 *
 * It stopped gating the run start in migration 0012 — only a driver on this
 * screen could create one, so a run whose inspection went on paper had no legal
 * transition out of `inspection_pending`. It is now removed from the driver's
 * day entirely: no checklist, no pass/fail, no defect capture, no action.
 *
 * **Nothing was deleted to achieve that.** `vehicle_inspections`,
 * `daily_routes.inspection_id`, the `inspection_pending`/`inspection_complete`
 * route statuses, the `inspection_failed` notification kind and every historical
 * row on all of them are untouched, so old runs still read correctly and no
 * report loses its source. What went is the way to create a new one.
 *
 * `confirmLoad` below is the replacement start-of-day action and is deliberately
 * *not* an inspection: it records that the laundry is on the van, and says
 * nothing about the van.
 */

export async function confirmLoad(formData: FormData): Promise<void> {
  const BACK = returnTo(formData, DEFAULT_BACK);
  const session = await assertCapability("run.execute");
  const id = z.string().uuid().safeParse(formData.get("route_id"));
  if (!id.success) return fail(BACK, "That run could not be found.");

  const supabase = await createClient();
  const at = new Date().toISOString();
  // Only where the load has not already been recorded. The screen only offers
  // the button in that state, but the screen is not the boundary: without this
  // a replayed post would rewrite the moment the van was loaded, and — because
  // `guard_route_transition` does not refuse a backwards move — could set a run
  // that is already out on the road back to `load_confirmed`.
  const { error } = await supabase
    .from("daily_routes")
    .update({
      load_confirmed_at: at,
      load_confirmed_by: session.userId,
      status: "load_confirmed",
    })
    .eq("id", id.data).eq("tenant_id", session.tenantId)
    .is("load_confirmed_at", null);

  if (error) return fail(BACK, describeDbError(error));

  // The jobs riding on this run are confirmed with it. Without this the depot
  // screen and My Runs would disagree about what is on the van — and Start Route
  // dispatches only load-confirmed jobs, so confirming here and starting there
  // would send nothing out.
  const confirmed = await confirmRunJobsLoaded(supabase, session, id.data, at);

  await recordAudit(session, { entity: "daily_route", entityId: id.data, action: "status_change", summary: "load confirmed" });
  revalidateRunScreens();
  revalidatePath("/orders");
  return done(BACK, confirmed > 0
    ? `Load confirmed — ${confirmed} job(s) ready to go out.`
    : "Load confirmed.");
}

export async function startRun(formData: FormData): Promise<void> {
  const BACK = returnTo(formData, DEFAULT_BACK);
  const session = await assertCapability("run.execute");
  const id = z.string().uuid().safeParse(formData.get("route_id"));
  if (!id.success) return fail(BACK, "That run could not be found.");

  const supabase = await createClient();
  // The database refuses this transition without a confirmed load — the rule
  // lives there so no client can route around it. Nothing else gates the start:
  // the inspection stopped doing so in 0012 and is out of the workflow entirely.
  const { error } = await supabase
    .from("daily_routes").update({ status: "in_progress" })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, { entity: "daily_route", entityId: id.data, action: "status_change", summary: "started" });

  // The laundry on this run has physically left the depot, so the loaded jobs
  // riding on it move to "out for delivery". A statement of fact, not a
  // shortcut: leaving them at "assigned" would have the Jobs screen claiming the
  // linen is still on the shelf all morning. Nothing is *completed* here — a
  // job is only delivered when somebody says it was.
  const dispatched = await dispatchRunJobs(supabase, session, id.data);

  revalidateRunScreens();
  revalidatePath("/orders");
  return done(BACK, dispatched > 0
    ? `Run started, and ${dispatched} job(s) are now out for delivery. Drive safely.`
    : "Run started. Drive safely.");
}

export async function markReturning(formData: FormData): Promise<void> {
  const BACK = returnTo(formData, DEFAULT_BACK);
  const session = await assertCapability("run.execute");
  const id = z.string().uuid().safeParse(formData.get("route_id"));
  if (!id.success) return fail(BACK, "That run could not be found.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("daily_routes")
    .update({ status: "returning", returned_at: new Date().toISOString() })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail(BACK, describeDbError(error));
  revalidateRunScreens();
  return done(BACK, "Marked as returning to depot.");
}

/**
 * Unload moves everything still on the vehicle into depot receiving
 * (acceptance criterion §10) and stamps the run as unloaded.
 */
export async function unloadRun(formData: FormData): Promise<void> {
  const BACK = returnTo(formData, DEFAULT_BACK);
  const session = await assertCapability("run.execute");
  const parsed = z.object({
    route_id: z.string().uuid(),
    odometer_end_km: z.preprocess(
      (v) => (v === "" || v == null ? undefined : Number(v)),
      z.number().int().min(0).optional(),
    ),
  }).safeParse(toObject(formData));
  if (!parsed.success) return fail(BACK, firstIssue(parsed.error));

  const sweepError = await sweepVehicleToDepot(session.tenantId, parsed.data.route_id);
  if (sweepError) return fail(BACK, sweepError);

  const supabase = await createClient();
  const { error } = await supabase
    .from("daily_routes")
    .update({
      status: "unloading",
      unloaded_at: new Date().toISOString(),
      odometer_end_km: parsed.data.odometer_end_km ?? null,
    })
    .eq("id", parsed.data.route_id).eq("tenant_id", session.tenantId);
  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, {
    entity: "daily_route", entityId: parsed.data.route_id, action: "status_change", summary: "unloaded",
  });
  revalidateRunScreens();
  return done(BACK, "Vehicle unloaded into depot receiving.");
}

export async function closeRun(formData: FormData): Promise<void> {
  const BACK = returnTo(formData, DEFAULT_BACK);
  const session = await assertCapability("run.execute");
  const id = z.string().uuid().safeParse(formData.get("route_id"));
  if (!id.success) return fail(BACK, "That run could not be found.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("daily_routes").update({ status: "closed" })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail(BACK, describeDbError(error));

  await recordAudit(session, { entity: "daily_route", entityId: id.data, action: "status_change", summary: "closed" });
  revalidateRunScreens();
  return done(BACK, "Run closed. Have a good evening.");
}
