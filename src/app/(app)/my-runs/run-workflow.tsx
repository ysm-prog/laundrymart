import { Notice, cx } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { formatAdelaideDateTime } from "@/lib/domain/timezone";
import { checkRunStart, runStage } from "@/lib/domain/run-assignment";
import { closeRun, confirmLoad, markReturning, startRun, unloadRun } from "@/app/(app)/run/actions";
import type { Run } from "@/lib/runs/my-runs";

/**
 * The run controls, compact.
 *
 * This is **not** a second run workflow. Every button posts to the very actions
 * `/run` posts to — `confirmLoad`, `startRun`, `markReturning`, `unloadRun`,
 * `closeRun` — which carry the load-before-start rule, the depot sweep on
 * unload and the close guard. Those actions gained nothing but a `return_to`
 * when this screen arrived, so the rules cannot drift between the two.
 *
 * What differs is the shape. `/run` is the guided single-run screen a driver
 * works from at the kerb: six numbered stages, one actionable at a time, with
 * the inspection form and the offline capture card in it. My Runs is the day at
 * a glance and may be showing two runs at once, so it offers only **the next
 * step**, in one row, and sends the driver to `/run` for the inspection and for
 * anything captured at a stop.
 *
 * Every timestamp is Adelaide's.
 */
export function RunWorkflow({ run, returnTo }: { run: Run; returnTo: string }) {
  const stage = runStage(run.status);

  if (stage === "cancelled") {
    return <Notice tone="warning">This run was cancelled. Nothing more to do on it.</Notice>;
  }
  if (stage === "completed") {
    return (
      <Notice tone="success" title="Run closed">
        {run.closed_at
          ? `Closed ${formatAdelaideDateTime(run.closed_at)}.`
          : "This run is finished."}
      </Notice>
    );
  }

  const startable = checkRunStart(run);
  const row = "flex flex-wrap items-center gap-3 rounded-xl border bg-surface-sunken px-4 py-3";

  // Exactly one control, chosen by where the run has got to. A row of five
  // buttons of which four are refused is a row of five ways to be told no.
  if (!run.load_confirmed_at) {
    return (
      <div className={cx(row)}>
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">Next: confirm the load.</span>{" "}
          {startable.ok ? null : startable.reason}
        </p>
        <form action={confirmLoad}>
          <input type="hidden" name="route_id" value={run.id} />
          <input type="hidden" name="return_to" value={returnTo} />
          <SubmitButton pendingLabel="Confirming…">Confirm load</SubmitButton>
        </form>
      </div>
    );
  }

  if (!run.started_at) {
    return (
      <div className={cx(row)}>
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">Next: start the run.</span>{" "}
          Load confirmed {formatAdelaideDateTime(run.load_confirmed_at)}.
          {run.inspection_id ? null : " The vehicle inspection has not been recorded yet."}
        </p>
        <form action={startRun}>
          <input type="hidden" name="route_id" value={run.id} />
          <input type="hidden" name="return_to" value={returnTo} />
          <SubmitButton pendingLabel="Starting…">Start run</SubmitButton>
        </form>
      </div>
    );
  }

  if (!run.returned_at) {
    return (
      <div className={cx(row)}>
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">On the road</span> since{" "}
          {formatAdelaideDateTime(run.started_at)}. Mark this when you head back to the depot.
        </p>
        <form action={markReturning}>
          <input type="hidden" name="route_id" value={run.id} />
          <input type="hidden" name="return_to" value={returnTo} />
          <SubmitButton variant="secondary" pendingLabel="Saving…">I&apos;m returning</SubmitButton>
        </form>
      </div>
    );
  }

  if (!run.unloaded_at) {
    return (
      <div className={cx(row)}>
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">Next: unload.</span>{" "}
          Everything still on the vehicle moves into depot receiving.
        </p>
        <form action={unloadRun}>
          <input type="hidden" name="route_id" value={run.id} />
          <input type="hidden" name="return_to" value={returnTo} />
          <SubmitButton pendingLabel="Unloading…">Unload vehicle</SubmitButton>
        </form>
      </div>
    );
  }

  return (
    <div className={cx(row, "block sm:flex")}>
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">Last step: close the run.</span>{" "}
        Unloaded {formatAdelaideDateTime(run.unloaded_at)}.
      </p>
      <form action={closeRun} className="mt-3 sm:mt-0">
        <input type="hidden" name="route_id" value={run.id} />
        <input type="hidden" name="return_to" value={returnTo} />
        <ConfirmSubmit
          label="Close run"
          variant="primary"
          eyebrow="Final step"
          consequence={
            "This closes the run for the day and it cannot be reopened. "
            + "Any job still outstanding stays outstanding — closing a run never marks work delivered."
          }
          pendingLabel="Closing…"
        />
      </form>
    </div>
  );
}
