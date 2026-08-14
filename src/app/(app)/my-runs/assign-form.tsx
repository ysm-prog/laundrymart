import { CONTROL, SELECT_CHEVRON, cx } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { preferredRunDate } from "@/lib/domain/run-assignment";
import { formatAdelaideDate } from "@/lib/domain/timezone";
import { assignJobToRun } from "./actions";

/**
 * "Assign to run" — one driver, one date, one button.
 *
 * Everything else the brief sketches for this dialog is resolved server-side by
 * `assignJobToRun`, and that is a deliberate simplification rather than a
 * shortcut. Whether the driver already has a run on the day, whether to reuse
 * it, whether to reuse the stop the run already makes at that customer, and
 * what to number a new one are all facts the browser does not have and would
 * have to fetch. Asking for the two decisions a person actually makes — *who*
 * and *when* — keeps this a form that works on a phone, before hydration, with
 * no JavaScript, and keeps the find-or-create logic in the one place that can
 * make it atomic.
 *
 * The one case that still needs a person is a driver with two open runs on the
 * date; the action refuses and says so, and the run picker on the My Runs page
 * is where that choice is made.
 *
 * The date defaults to the job's own promised delivery date, or to the day being
 * planned when that has already passed — never silently to the wrong day (§26).
 */
export function AssignForm({
  orderId, defaultDriverId, defaultDriverName, defaultDate, dueDate, drivers, returnTo,
  currentAssignment, runs = [], compact = false,
}: {
  orderId: string;
  defaultDriverId: string | null;
  defaultDriverName: string | null;
  /** The day in view — the fallback when the job's own date has gone. */
  defaultDate: string;
  dueDate: string | null;
  drivers: Array<{ id: string; full_name: string }>;
  returnTo: string;
  /** Set when the job is already on a run: the form becomes a reassignment. */
  currentAssignment?: { driverName: string; runCode: string; runDate: string } | null;
  /**
   * The open runs the shown driver already has on the shown date.
   *
   * Only offered when there is more than one, and only where the page already
   * knows both — which is My Runs, where the driver and the date *are* the
   * screen. A morning van and an afternoon van are different promises to the
   * customer, so the action refuses to guess between them; this is where the
   * person answers.
   */
  runs?: Array<{ id: string; code: string; name: string }>;
  compact?: boolean;
}) {
  const date = preferredRunDate({ due_date: dueDate }, defaultDate);
  const reassigning = !!currentAssignment;

  if (drivers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        There are no active drivers to assign this to yet.
      </p>
    );
  }

  return (
    <form action={assignJobToRun} className={cx("space-y-3", compact && "space-y-2")}>
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="return_to" value={returnTo} />

      {reassigning ? (
        <p className="text-sm text-muted-foreground">
          Currently with <span className="font-medium text-foreground">
            {currentAssignment.driverName}
          </span>{" "}
          on {currentAssignment.runCode}, {formatAdelaideDate(currentAssignment.runDate, "medium")}.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`driver-${orderId}`} className="mb-1 block text-sm font-medium">
            Driver
          </label>
          <select
            id={`driver-${orderId}`}
            name="driver_id"
            defaultValue={defaultDriverId ?? ""}
            className={cx(CONTROL, SELECT_CHEVRON)}
            required
          >
            <option value="">Choose a driver…</option>
            {drivers.map((driver) => (
              <option key={driver.id} value={driver.id}>
                {driver.full_name}
                {driver.id === defaultDriverId && defaultDriverName ? " (shown above)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={`run-date-${orderId}`} className="mb-1 block text-sm font-medium">
            Run date
          </label>
          <input
            id={`run-date-${orderId}`}
            type="date"
            name="run_date"
            defaultValue={date}
            className={CONTROL}
            required
          />
        </div>
      </div>

      {runs.length > 1 ? (
        <div>
          <label htmlFor={`run-${orderId}`} className="mb-1 block text-sm font-medium">
            Which run?
          </label>
          <select
            id={`run-${orderId}`}
            name="run_id"
            defaultValue=""
            className={cx(CONTROL, SELECT_CHEVRON)}
          >
            <option value="">Choose a run…</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>{run.code} · {run.name}</option>
            ))}
          </select>
          <p className="mt-1 text-sm text-muted-foreground">
            {defaultDriverName ?? "This driver"} has {runs.length} runs on this day.
          </p>
        </div>
      ) : null}

      <SubmitButton size="lg" pendingLabel="Assigning…">
        {reassigning ? "Reassign" : "Assign to run"}
      </SubmitButton>
    </form>
  );
}
