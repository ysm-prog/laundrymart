import { Notice } from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { formatAdelaideDate, formatAdelaideDateTime } from "@/lib/domain/timezone";
import { dispatchableJobs, loadableJobs } from "@/lib/domain/run-assignment";
import type { DayJob } from "@/lib/runs/my-runs";
import { confirmDayLoad, startDayRoute } from "./actions";

/**
 * The driver's two buttons for a day: Confirm Load, then Start Route.
 *
 * This replaces the six-stage run workflow that used to sit here, and with it
 * the vehicle inspection that used to be stage one. **Confirm Load is not an
 * inspection** — there is no checklist, no pass or fail, no defect capture and
 * no vehicle status. It records one fact: the laundry assigned for this day is
 * on the van. That is what Start Route then needs to be true.
 *
 * Exactly one control is offered at a time. A row of buttons of which most are
 * refused is a row of ways to be told no, and this screen is read at arm's
 * length in a vehicle.
 *
 * The two are separate on purpose rather than folded into one "I'm off". Loading
 * and leaving are minutes apart and the gap is where late work arrives: a job
 * assigned after the load is confirmed stays Assigned and is deliberately *not*
 * swept out by Start Route, because it is not on the van. Confirming again picks
 * it up, which is the honest way to say "I went back for it".
 */
export function DayWorkflow({
  jobs, driverId, date, returnTo,
}: {
  jobs: DayJob[];
  driverId: string;
  date: string;
  returnTo: string;
}) {
  const loadable = loadableJobs(jobs);
  const dispatchable = dispatchableJobs(jobs);
  const outForDelivery = jobs.filter((job) => job.status === "out_for_delivery");
  const assigned = jobs.filter((job) => job.status === "assigned");

  const row = "flex flex-wrap items-center gap-3 rounded-xl border bg-surface-sunken px-4 py-3";
  const fields = (
    <>
      <input type="hidden" name="driver_id" value={driverId} />
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="return_to" value={returnTo} />
    </>
  );

  // Nothing assigned at all, or everything already finished: no controls, and
  // the page's own empty state or completed list says the rest.
  if (assigned.length === 0 && outForDelivery.length === 0) return null;

  if (loadable.length > 0) {
    const confirmedAlready = jobs.filter((job) => job.load_confirmed_at).length;
    return (
      <div className={row}>
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">Next: confirm the load.</span>{" "}
          {loadable.length} {loadable.length === 1 ? "job is" : "jobs are"} assigned to you for{" "}
          {formatAdelaideDate(date, "medium")}
          {confirmedAlready > 0
            ? ` (${confirmedAlready} already confirmed — this covers the rest).`
            : "."}
        </p>
        <form action={confirmDayLoad}>
          {fields}
          <ConfirmSubmit
            label="Confirm Load"
            variant="primary"
            eyebrow="Before you set off"
            consequence={
              `You are confirming that the ${loadable.length} `
              + `${loadable.length === 1 ? "job" : "jobs"} assigned to you for `
              + `${formatAdelaideDate(date, "medium")} are loaded and ready for delivery.`
            }
            pendingLabel="Confirming…"
          />
        </form>
      </div>
    );
  }

  if (dispatchable.length > 0) {
    const confirmedAt = jobs.find((job) => job.load_confirmed_at)?.load_confirmed_at ?? null;
    return (
      <div className={row}>
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">Next: start the route.</span>{" "}
          {dispatchable.length} loaded {dispatchable.length === 1 ? "job" : "jobs"} will go out
          for delivery
          {confirmedAt ? `. Load confirmed ${formatAdelaideDateTime(confirmedAt)}.` : "."}
        </p>
        <form action={startDayRoute}>
          {fields}
          <ConfirmSubmit
            label="Start Route"
            variant="primary"
            eyebrow="On the road"
            consequence={
              `This marks the ${dispatchable.length} loaded `
              + `${dispatchable.length === 1 ? "job" : "jobs"} as out for delivery. `
              + "Mark each one delivered as you hand it over."
            }
            pendingLabel="Starting…"
          />
        </form>
      </div>
    );
  }

  if (outForDelivery.length > 0) {
    return (
      <Notice tone="info" title="On the road">
        {outForDelivery.length} {outForDelivery.length === 1 ? "job is" : "jobs are"} out for
        delivery. Open each one and mark it delivered as you hand it over.
      </Notice>
    );
  }

  return null;
}
