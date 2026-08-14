/**
 * Putting a Job on a Run, with no database in sight.
 *
 * Three vocabularies meet in this feature and it is worth naming them once,
 * because the words and the tables do not line up:
 *
 *   - a **Run**   is `daily_routes` — one van, one day, one driver;
 *   - a **Stop**  is `public.jobs` — one visit to one customer on that run;
 *   - a **Job**   is `laundry_orders` — a customer's laundry, counter to hand-back.
 *
 * The chain that binds them is `Job → Stop → Run → Driver`, and it is one
 * column: `laundry_orders.stop_id`. Nothing else records who is delivering a
 * job, which is the point — a second copy of the answer is a second thing to
 * keep in step.
 *
 * Everything here is pure so the four places that must agree actually do: the
 * assignment dialog deciding what to offer, the Jobs list deciding which rows
 * carry the action, the server action deciding whether to write, and
 * `guard_laundry_order_assignment()` in migration 0015, whose rules are a
 * transcription of `checkAssignable` below. The action gives a sentence; the
 * trigger is the boundary.
 */

import { ORDER_STATUS_LABELS, type OrderStatus } from "@/lib/domain/laundry-orders";

/* --------------------------------------------------------- eligibility --- */

/** What the rules need to know about a job. Deliberately less than a row. */
export type AssignableJob = {
  status: OrderStatus | string;
  delivery_required: boolean;
  stop_id?: string | null;
};

/**
 * The status a job must reach before it can go on a delivery run.
 *
 * Not `out_for_delivery`: that means it has already physically left, so it is
 * on a run by definition and what it needs is reassignment, not assignment.
 * Not `in_progress`: it is still in the plant, and a van cannot collect what is
 * in a washing machine.
 */
export const ASSIGNABLE_STATUS: OrderStatus = "ready_for_delivery";

/** Statuses a job may hold while it legitimately sits on a run. */
export const ON_RUN_STATUSES: readonly OrderStatus[] = [
  "ready_for_delivery", "out_for_delivery",
];

/**
 * May this job go on a delivery run — and if not, why, in a sentence the person
 * looking at it can act on?
 *
 * `allowAssigned` is the difference between assigning and reassigning: the
 * dialog offering a fresh assignment refuses a job that already has a run
 * (§27), while the reassign action expects one.
 */
export function checkAssignable(
  job: AssignableJob, options: { allowAssigned?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!job.delivery_required) {
    return {
      ok: false,
      reason: "This is a customer pickup job, so it is not eligible for a delivery run.",
    };
  }
  if (job.status === "cancelled") {
    return { ok: false, reason: "This job was cancelled, so it cannot be put on a run." };
  }
  if (job.status === "completed") {
    return { ok: false, reason: "This job is already completed." };
  }
  if (job.status === "new" || job.status === "in_progress") {
    return {
      ok: false,
      reason: "This job is not ready for delivery yet — it is still "
        + `${ORDER_STATUS_LABELS[job.status].toLowerCase()}.`,
    };
  }
  if (!options.allowAssigned && job.stop_id) {
    return { ok: false, reason: "This job is already assigned to a run." };
  }
  return { ok: true };
}

/** The list filter behind "Ready for delivery — unassigned". */
export function isUnassignedDeliveryWork(job: AssignableJob): boolean {
  return job.delivery_required && !job.stop_id && job.status === ASSIGNABLE_STATUS;
}

/**
 * Which day this job should be dispatched on (§26).
 *
 * The job's own expected delivery date wins when it is not in the past, because
 * that is the promise made to the customer. Otherwise the day the user is
 * actually looking at — silently assigning a Tuesday job to Tuesday's van when
 * the dispatcher is planning Thursday's is the failure this rule exists to
 * prevent, and so is silently assigning it to a day that has already gone.
 */
export function preferredRunDate(
  job: { due_date?: string | null }, selectedDate: string,
): string {
  const due = job.due_date ?? null;
  if (!due) return selectedDate;
  return due < selectedDate ? selectedDate : due;
}

/* ----------------------------------------------------------- run status --- */

/**
 * The Run's nine workflow states, collapsed to the four an operator thinks in.
 *
 * No status is added by this feature. `daily_routes.status` already models the
 * day in detail — inspection, load, in progress, returning, unloading, closed —
 * and the guard trigger from 0004 already enforces the ordering. What My Runs
 * needs is the coarse answer ("has it left? is it done?") for a progress line
 * and a button, so the detail is folded here rather than duplicated there.
 */
export type RunStage = "not_started" | "in_progress" | "completed" | "cancelled";

export function runStage(status: string): RunStage {
  if (status === "cancelled") return "cancelled";
  if (status === "closed") return "completed";
  if (["in_progress", "returning", "unloading"].includes(status)) return "in_progress";
  return "not_started";
}

export const RUN_STAGE_LABELS: Record<RunStage, string> = {
  not_started: "Not started",
  in_progress: "On the road",
  completed: "Finished",
  cancelled: "Cancelled",
};

/**
 * Whether the driver can start this run, and what to tell them if not.
 *
 * The rule is the database's, not ours: `guard_route_transition` refuses
 * `in_progress` without a confirmed load. Repeating it here is what turns a
 * failed write into a disabled button with an explanation beside it.
 *
 * A run with no stops is deliberately still startable. Stops get added to a
 * run during the morning, and a driver who cannot press start until dispatch
 * has finished planning is a driver waiting in a car park.
 */
export function checkRunStart(
  run: { status: string; load_confirmed_at: string | null },
): { ok: true } | { ok: false; reason: string } {
  const stage = runStage(run.status);
  if (stage === "cancelled") return { ok: false, reason: "This run was cancelled." };
  if (stage === "completed") return { ok: false, reason: "This run is already finished." };
  if (stage === "in_progress") return { ok: false, reason: "This run is already under way." };
  if (!run.load_confirmed_at) {
    return { ok: false, reason: "Confirm the load before starting the run." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------- progress --- */

export type StopProgress = { total: number; done: number };

/**
 * How far through a run its stops are.
 *
 * A stop counts as done when its own `progress_status` says so — the existing
 * column the run screen and the office pages already read. Nothing is inferred
 * from the laundry: a stop can be visited for a collection with no delivery on
 * it, and a run whose progress was computed from job statuses would report that
 * stop as outstanding forever.
 */
export function stopProgress(
  stops: readonly { progress_status: string; status: string }[],
): StopProgress {
  return {
    total: stops.length,
    done: stops.filter((stop) =>
      stop.progress_status === "completed"
      || stop.status === "completed"
      || stop.status === "cancelled").length,
  };
}

/** How many of a run's laundry jobs have actually been handed over. */
export function jobProgress(
  jobs: readonly { status: string }[],
): StopProgress {
  return {
    total: jobs.length,
    done: jobs.filter((job) => job.status === "completed").length,
  };
}

/** "3 of 8 stops completed" — never "3/8", which reads as a date on a phone. */
export function describeProgress(progress: StopProgress, noun: string, verb = "completed"): string {
  const unit = progress.total === 1 ? noun : `${noun}s`;
  return `${progress.done} of ${progress.total} ${unit} ${verb}`;
}
