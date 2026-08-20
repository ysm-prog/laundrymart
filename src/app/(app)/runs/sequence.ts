import { z } from "zod";

/**
 * Ordering a board's day: the rules the board and the action both obey.
 *
 * **Why this is a plain module and not part of `actions.ts`.** A `"use server"`
 * file may export nothing but server actions, so a payload contract written
 * inside one is unreachable from a unit test — and this repository has shipped
 * two such contracts broken behind a green `verify` (the job form's items, and
 * the dispatch planner's entire board, which was refused on every single press
 * for its whole shipped life because the producer and the schema disagreed about
 * a field name). The contract lives here, with tests written against what the
 * board actually emits.
 *
 * It is also imported by a **client** component, so it may not reach
 * `lib/actions` — that module pulls in `next/headers`, which typechecks, lints
 * and tests clean and then fails at `next build`. Hence the date rule restated
 * below rather than imported.
 *
 * **What is being ordered is the stop, not the job.** A stop is one visit to one
 * customer, and a customer with two jobs on the same day is one stop: the van
 * goes there once. Ordering the two jobs independently would mean driving to the
 * same address twice. On screen each position shows the jobs under it, so for
 * the ordinary case — one job per customer — it reads exactly as the client
 * describes it.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker");

/* ------------------------------------------------------------ the payload */

export const sequenceSchema = z.object({
  board_id: z.uuid(),
  date: isoDate,
  /** The stop ids in their new order, first to last. */
  stops: z.array(z.uuid()).min(1, "There is nothing to reorder."),
});

export type SequencePlan = z.infer<typeof sequenceSchema>;

/**
 * Read a posted plan, or say why it could not be read.
 *
 * Returning the reason rather than an empty plan is the lesson of the job form:
 * an unreadable payload that surfaced as "please add at least one laundry item"
 * described a problem the operator could see was untrue and named nothing they
 * could act on.
 */
export function parseSequencePlan(
  raw: unknown,
): { ok: true; plan: SequencePlan } | { ok: false; error: string } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: "The new order could not be read. Reload the page and try again." };
    }
  }
  const parsed = sequenceSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue
        ? `The new order could not be read (${issue.path.join(".") || "plan"}: ${issue.message}).`
        : "The new order could not be read.",
    };
  }
  return { ok: true, plan: parsed.data };
}

/* --------------------------------------------------------- what may move */

/** The minimum a stop has to say about itself to be ordered. */
export type OrderableStop = {
  id: string;
  status: string;
  progress_status: string;
};

/**
 * A stop stops being movable the moment the round touches it.
 *
 * Reordering a stop that has been arrived at, collected from or completed would
 * rewrite where work that has already happened happened. The same rule the
 * dispatch planner states, applied to the same column.
 */
export function isMovable(stop: OrderableStop): boolean {
  return !["completed", "cancelled"].includes(stop.status)
    && stop.progress_status === "not_started";
}

export function lockReason(stop: OrderableStop): string | null {
  if (stop.status === "completed") return "Delivered";
  if (stop.status === "cancelled") return "Cancelled";
  if (stop.progress_status !== "not_started") return "Round on site";
  return null;
}

/**
 * Check a proposed order against what is actually on the run.
 *
 * Three ways a plan can be wrong, and each gets its own sentence because the
 * remedy differs:
 *
 *   * it names a stop that is not on this day's run — a stale page;
 *   * it leaves one out — likewise, and silently dropping it would lose a visit;
 *   * it moves a stop the round has already worked.
 *
 * The board enforces all three so a plan is never composed that the action will
 * reject, and the action re-enforces them because the browser is not the
 * boundary.
 */
export function checkSequence(
  proposed: readonly string[],
  stops: readonly OrderableStop[],
): { ok: true } | { ok: false; error: string } {
  const known = new Map(stops.map((stop) => [stop.id, stop]));

  const seen = new Set<string>();
  for (const id of proposed) {
    if (!known.has(id)) {
      return {
        ok: false,
        error: "That order names a stop that is not on this run any more. Reload the page and try again.",
      };
    }
    if (seen.has(id)) {
      return { ok: false, error: "That order lists the same stop twice." };
    }
    seen.add(id);
  }

  if (seen.size !== stops.length) {
    return {
      ok: false,
      error: "That order is missing a stop. Reload the page so you are ordering the whole run.",
    };
  }

  // A worked stop must still be where it was. Compared by position rather than
  // by "did it move at all", because moving anything *around* it moves it too.
  const before = stops.map((stop) => stop.id);
  for (const [index, id] of proposed.entries()) {
    const stop = known.get(id)!;
    if (isMovable(stop)) continue;
    if (before[index] !== id) {
      return {
        ok: false,
        error: `${lockReason(stop) ?? "That stop"} — a stop the round has already worked cannot be moved.`,
      };
    }
  }

  return { ok: true };
}

/* -------------------------------------------------------- the move itself */

/**
 * Move one stop up or down by a position, returning the new order.
 *
 * The keyboard and no-JavaScript path, and the thing the drag handler commits
 * too — so both routes into the same change go through one tested rule. A move
 * that would run off either end is a no-op rather than an error: pressing "up"
 * on the first row should do nothing, not complain.
 */
export function moveStop(
  order: readonly string[], id: string, direction: "up" | "down",
): string[] {
  const next = [...order];
  const from = next.indexOf(id);
  if (from === -1) return next;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** Move a stop to an arbitrary position — what a drop performs. */
export function moveStopTo(order: readonly string[], id: string, to: number): string[] {
  const next = [...order];
  const from = next.indexOf(id);
  if (from === -1 || to < 0 || to >= next.length || from === to) return next;
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Whether a proposed order actually differs from the one on the run. */
export function isReordered(proposed: readonly string[], current: readonly string[]): boolean {
  if (proposed.length !== current.length) return true;
  return proposed.some((id, index) => id !== current[index]);
}
