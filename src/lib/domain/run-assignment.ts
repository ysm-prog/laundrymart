/**
 * Giving a Job to a Driver for a day, with no database in sight.
 *
 * Three vocabularies meet in this feature and it is worth naming them once,
 * because the words and the tables do not line up:
 *
 *   - a **Job**   is `laundry_orders` — a customer's laundry, counter to hand-back;
 *   - a **Run**   is `daily_routes` — one van, one day, one driver;
 *   - a **Stop**  is `public.jobs` — one visit to one customer on that run.
 *
 * The **user-facing model is only the first of those**: `Job → Driver →
 * Delivery Date`, stored as `assigned_driver_id` + `assigned_delivery_date` on
 * the job itself (migration 0016). Neither office staff nor drivers ever name a
 * run. Runs and stops are still created and maintained underneath — the depot
 * load, the inventory unload sweep and the offline capture screen are built on
 * them — but they are resolved by the server action, never chosen by a person.
 *
 * Everything here is pure so the places that must agree actually do: the assign
 * dialog deciding what to offer, the Jobs list deciding which rows carry the
 * action, My Runs deciding how to group a day, the server actions deciding
 * whether to write, and `guard_laundry_order_assignment()` /
 * `guard_laundry_order_transition()` in migration 0016, whose rules are a
 * transcription of what follows. The action gives a sentence; the trigger is the
 * boundary.
 */

import { ORDER_STATUS_LABELS, type OrderStatus } from "@/lib/domain/laundry-orders";

/* --------------------------------------------------------- eligibility --- */

/** What the rules need to know about a job. Deliberately less than a row. */
export type AssignableJob = {
  status: OrderStatus | string;
  delivery_required: boolean;
  assigned_driver_id?: string | null;
};

/**
 * The status a job must reach before it can be given to a driver.
 *
 * Not `out_for_delivery`: that means it has already physically left, so it has a
 * driver by definition and what it needs is reassignment, not assignment. Not
 * `in_progress`: it is still in the plant, and a van cannot carry what is in a
 * washing machine.
 */
export const ASSIGNABLE_STATUS: OrderStatus = "ready_for_delivery";

/**
 * The statuses My Runs shows a driver for a day.
 *
 * Cancelled is excluded on purpose. A cancelled job is not work, and listing it
 * among the day's deliveries — even greyed out — is an invitation to drive to it.
 * It stays visible on the job record itself, where the cancellation reason is.
 */
export const DRIVER_DAY_STATUSES: readonly OrderStatus[] = [
  "assigned", "out_for_delivery", "completed",
];

/** Statuses a job may hold while it legitimately carries an assignment. */
export const ASSIGNED_STATUSES: readonly OrderStatus[] = ["assigned", "out_for_delivery"];

/**
 * May this job be given to a driver — and if not, why, in a sentence the person
 * looking at it can act on?
 *
 * `allowAssigned` is the difference between assigning and reassigning: the
 * dialog offering a fresh assignment refuses a job that already has a driver,
 * while the reassign action expects one.
 */
export function checkAssignable(
  job: AssignableJob, options: { allowAssigned?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!job.delivery_required) {
    return {
      ok: false,
      reason: "This customer pickup job cannot be assigned for delivery.",
    };
  }
  if (job.status === "cancelled") {
    return { ok: false, reason: "This job was cancelled, so it cannot be assigned." };
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
  if (job.status === "out_for_delivery" && !options.allowAssigned) {
    return { ok: false, reason: "This job is already out for delivery." };
  }
  if (!options.allowAssigned && job.assigned_driver_id) {
    return { ok: false, reason: "This job is already assigned to another driver." };
  }
  return { ok: true };
}

/**
 * May this job's assignment be taken away entirely?
 *
 * Only from `assigned`. Once the van has left, the job is somewhere on a road
 * and pretending otherwise puts a delivery back in the ready queue while the
 * driver is holding it — so past that point reassignment is the tool, and it is
 * a management override.
 */
export function checkAssignmentRemovable(
  job: AssignableJob,
): { ok: true } | { ok: false; reason: string } {
  if (!job.assigned_driver_id) {
    return { ok: false, reason: "This job is not assigned to a driver." };
  }
  if (job.status !== "assigned") {
    return {
      ok: false,
      reason: job.status === "out_for_delivery"
        ? "This job is already out for delivery. Reassign it instead of removing the driver."
        : `A ${ORDER_STATUS_LABELS[job.status as OrderStatus]?.toLowerCase() ?? job.status}`
          + " job has no assignment to remove.",
    };
  }
  return { ok: true };
}

/** The list filter behind "Ready for delivery — unassigned". */
export function isUnassignedDeliveryWork(job: AssignableJob): boolean {
  return job.delivery_required && !job.assigned_driver_id && job.status === ASSIGNABLE_STATUS;
}

/**
 * Which day this job should be scheduled for.
 *
 * The customer's promised delivery date wins when it has not already gone,
 * because that is the promise. Otherwise the day the user is actually looking
 * at — silently scheduling a Tuesday job onto Tuesday when the office is
 * planning Thursday is the failure this rule exists to prevent, and so is
 * silently scheduling it into the past.
 */
export function preferredRunDate(
  job: { due_date?: string | null }, selectedDate: string,
): string {
  const due = job.due_date ?? null;
  if (!due) return selectedDate;
  return due < selectedDate ? selectedDate : due;
}

/* ------------------------------------------------------- the driver day --- */

/** What grouping a day needs to know about a job. Again, less than a row. */
export type DriverDayJob = { status: OrderStatus | string; load_confirmed_at?: string | null };

export type DriverDay<T extends DriverDayJob> = {
  /** Given to this driver for the day and still on the shelf or in the van. */
  toDeliver: T[];
  outForDelivery: T[];
  completed: T[];
  /** Everything that is not finished — the number the header counts. */
  outstanding: number;
  total: number;
};

/**
 * A day's jobs, in the three groups §18 asks for and in that order.
 *
 * The order is the driver's morning: what is still to load and take, what is on
 * the van, what is done. Completed stays in the list rather than disappearing —
 * a driver who has just delivered wants to see it move, not vanish, and coming
 * back to yesterday must still show yesterday's work.
 */
export function groupDriverDay<T extends DriverDayJob>(jobs: readonly T[]): DriverDay<T> {
  const toDeliver = jobs.filter((job) => job.status === "assigned");
  const outForDelivery = jobs.filter((job) => job.status === "out_for_delivery");
  const completed = jobs.filter((job) => job.status === "completed");
  return {
    toDeliver,
    outForDelivery,
    completed,
    outstanding: toDeliver.length + outForDelivery.length,
    total: jobs.length,
  };
}

/* ------------------------------------------------- confirm load / start --- */

/**
 * Which of the day's jobs a Confirm Load would actually cover.
 *
 * Only jobs still at `assigned` and not already confirmed. Pressing it twice is
 * therefore harmless, and a job added to the day after the load is confirmed is
 * simply not in this set until the driver confirms again — which is the whole
 * point of tracking confirmation per job rather than per day.
 */
export function loadableJobs<T extends DriverDayJob>(jobs: readonly T[]): T[] {
  return jobs.filter((job) => job.status === "assigned" && !job.load_confirmed_at);
}

/**
 * Which of the day's jobs Start Route would send out.
 *
 * Load-confirmed and still `assigned`. **Not** every assigned job: work handed
 * to a driver after they loaded the van is not on the van, and sweeping it out
 * with the rest would record a delivery leaving the depot that never did.
 */
export function dispatchableJobs<T extends DriverDayJob>(jobs: readonly T[]): T[] {
  return jobs.filter((job) => job.status === "assigned" && !!job.load_confirmed_at);
}

export function checkConfirmLoad<T extends DriverDayJob>(
  jobs: readonly T[],
): { ok: true; jobs: T[] } | { ok: false; reason: string } {
  const loadable = loadableJobs(jobs);
  if (loadable.length === 0) {
    return {
      ok: false,
      reason: jobs.some((job) => job.status === "assigned")
        ? "Every job for this day is already confirmed as loaded."
        : "There is nothing assigned to load for this day.",
    };
  }
  return { ok: true, jobs: loadable };
}

export function checkStartRoute<T extends DriverDayJob>(
  jobs: readonly T[],
): { ok: true; jobs: T[] } | { ok: false; reason: string } {
  const dispatchable = dispatchableJobs(jobs);
  if (dispatchable.length === 0) {
    return {
      ok: false,
      reason: loadableJobs(jobs).length > 0
        ? "Confirm the load before starting the route."
        : "There are no loaded jobs left to take out for this day.",
    };
  }
  return { ok: true, jobs: dispatchable };
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

/**
 * The run statuses that mean "still at the depot".
 *
 * Held as literals as well as being derivable from `runStage`, because the one
 * place that needs them is a filter evaluated *in the database*, where
 * `runStage` cannot run. The unit test pins the two together, so a tenth run
 * status cannot be added to one and forgotten in the other.
 */
export const RUN_NOT_STARTED_STATUSES = [
  "planned", "inspection_pending", "inspection_complete", "load_confirmed",
] as const;

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
