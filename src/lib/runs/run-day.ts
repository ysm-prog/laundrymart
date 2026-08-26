import type { createClient } from "@/lib/supabase/server";
import type { OrderableStop } from "@/app/(app)/runs/sequence";

/**
 * One board's day, read once: the runs it is spread over, the order's version,
 * and the stops in stored order.
 *
 * A plain module rather than part of the Runs actions, for the reason §2 of
 * CLAUDE.md gives: a `"use server"` file may export nothing but server actions,
 * so putting this there would publish it as a callable endpoint — and exporting
 * the type at all would fail the build.
 *
 * The tenant is a **required argument** rather than something left to RLS. A
 * platform admin's session reads every laundry (0019), and the board id here
 * arrives from the browser and is posted back into a write — the exact shape of
 * the 2026-08-18 cross-tenant bug, and the convention `lib/runs/my-runs.ts`
 * already holds.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type RunDay = {
  routeIds: string[];
  /**
   * The order's version, as the highest any of the day's runs carries.
   *
   * A board+date is normally one run, but a closed morning van and a fresh
   * afternoon one are two — so the day's token is the highest of them and
   * `apply_run_sequence()` swaps every run at or below it. That is what lets a
   * run opened after the last save join the day's token instead of deadlocking
   * against a neighbour that has already been ordered.
   */
  version: number;
  locked: boolean;
  stops: Array<OrderableStop & { route_id: string; sequence: number }>;
};

export async function loadRunDay(
  supabase: Supabase, tenantId: string, boardId: string, date: string,
): Promise<RunDay> {
  const { data: routes } = await supabase
    .from("daily_routes")
    .select("id, sequence_version, sequence_locked")
    .eq("tenant_id", tenantId)
    .eq("board_id", boardId)
    .eq("route_date", date)
    .is("deleted_at", null)
    .not("status", "in", "(cancelled)")
    .returns<Array<{ id: string; sequence_version: number; sequence_locked: boolean }>>();

  const rows = routes ?? [];
  const routeIds = rows.map((route) => route.id);
  const version = rows.reduce((high, route) => Math.max(high, route.sequence_version ?? 1), 1);
  // A day is locked unless every run on it says otherwise, which is the safe
  // way round: a missing row must never read as "open for editing".
  const locked = rows.length === 0 || rows.every((route) => route.sequence_locked !== false);

  if (routeIds.length === 0) return { routeIds, version, locked, stops: [] };

  const { data } = await supabase
    .from("jobs")
    .select("id, route_id, sequence, status, progress_status")
    .eq("tenant_id", tenantId)
    .in("route_id", routeIds)
    .is("deleted_at", null)
    .order("sequence")
    .returns<Array<OrderableStop & { route_id: string; sequence: number }>>();

  return { routeIds, version, locked, stops: data ?? [] };
}

