import { Notice, CONTROL, SELECT_CHEVRON, cx } from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { formatAdelaideDate } from "@/lib/domain/timezone";
import { startableJobs } from "@/lib/domain/run-assignment";
import type { DayJob } from "@/lib/runs/my-runs";
import { startMyDay } from "./actions";

/**
 * The round's one button before it drives: **Start my day** (brief 2.4, G8).
 *
 * It replaces Confirm Load and Start Route, which were two presses with two
 * confirms minutes apart. The two facts are still recorded separately — the
 * load is confirmed and the route started in the same press, on the jobs and
 * on the day's internal runs — because the depot screen, the unload sweep and
 * `guard_route_transition` read them separately. What went is the second press.
 *
 * Still not an inspection: no checklist, no pass or fail, no vehicle status.
 *
 * **Who is driving today** rides the same form. A board is a shared login; the
 * person operating it is what answers "who had that parcel?", so it is asked
 * once, here, defaulting to whoever drove this round last.
 *
 * Late work — a job assigned after the van left — is not on it, so the same
 * press is offered again as "Load and take", and covers exactly those jobs.
 */
export function DayWorkflow({
  jobs, boardId, date, returnTo, assignee = "you", drivers = [], defaultDriverId = null,
}: {
  jobs: DayJob[];
  boardId: string;
  date: string;
  returnTo: string;
  /**
   * Who the work is assigned to, in the sentence. "you" for the round's own
   * login; the board's name when a manager is looking at somebody else's day.
   */
  assignee?: string;
  drivers?: Array<{ id: string; full_name: string }>;
  defaultDriverId?: string | null;
}) {
  const startable = startableJobs(jobs);
  const outForDelivery = jobs.filter((job) => job.status === "out_for_delivery");
  const row = "flex flex-wrap items-center gap-3 rounded-xl border bg-surface-sunken px-4 py-3";

  if (startable.length === 0) {
    return outForDelivery.length > 0 ? (
      <Notice tone="info" title="On the road">
        {outForDelivery.length} {outForDelivery.length === 1 ? "job is" : "jobs are"} out for
        delivery. Press Delivered on each one as you hand it over.
      </Notice>
    ) : null;
  }

  const late = outForDelivery.length > 0;
  const what = `${startable.length} ${startable.length === 1 ? "job" : "jobs"}`;

  return (
    <form action={startMyDay} className={row}>
      <input type="hidden" name="board_id" value={boardId} />
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="return_to" value={returnTo} />
      <p className="min-w-0 flex-1 basis-60 text-sm">
        <span className="font-semibold">{late ? "More work for today." : "Next: start your day."}</span>{" "}
        {what} assigned to {assignee} for {formatAdelaideDate(date, "medium")}
        {late ? " came in after you left." : "."}
      </p>
      {drivers.length > 0 ? (
        <div className="min-w-44">
          <label htmlFor={`driver-${boardId}`} className="mb-1 block text-sm font-medium">Who is driving</label>
          <select id={`driver-${boardId}`} name="driver_id" defaultValue={defaultDriverId ?? ""}
                  className={cx(CONTROL, SELECT_CHEVRON)}>
            <option value="">Not recorded</option>
            {drivers.map((driver) => (
              <option key={driver.id} value={driver.id}>{driver.full_name}</option>
            ))}
          </select>
        </div>
      ) : null}
      <ConfirmSubmit
        label={late ? `Load and take ${startable.length} more` : "Start my day"}
        variant="primary"
        eyebrow="Before you set off"
        consequence={
          `You are confirming that the ${what} for ${formatAdelaideDate(date, "medium")} `
          + "are on the van, and taking them out for delivery. Press Delivered on each one "
          + "as you hand it over."
        }
        pendingLabel="Starting…"
      />
    </form>
  );
}
