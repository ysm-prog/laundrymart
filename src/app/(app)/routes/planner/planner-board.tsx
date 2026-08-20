"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Eyebrow, StatusBadge, cx, humanise } from "@/components/ui";
import { UNASSIGNED, estimateLoad, type DispatchPlan } from "./plan";

export type PlannerJob = {
  id: string;
  jobNumber: string;
  customer: string;
  site: string;
  serviceType: string;
  status: string;
  /** Set when the stop can no longer be moved; the string says why. */
  lockedBecause: string | null;
  /** Mean of the customer's recent weighed collections, or null with no history. */
  estimateKg: number | null;
};

export type PlannerColumn = {
  /** `UNASSIGNED` for the tray, otherwise the daily route id. */
  id: string;
  code: string;
  name: string;
  status: string | null;
  /** False for closed and cancelled runs: their stops are settled. */
  open: boolean;
  driverId: string;
  vehicleId: string;
  capacityKg: number | null;
  jobIds: string[];
};

export type Option = { value: string; label: string; capacityKg?: number | null };

/**
 * The payload, and it is `DispatchPlan` on purpose — the type the action's own
 * schema infers, so a board that stops posting what the server reads is a
 * compile error rather than a toast nobody can act on.
 *
 * It was exactly that, until 2026-08-14: the board posted `{columns:[{id…}]}`
 * with no date at all, `planSchema` wanted `{date, columns:[{routeId…}]}`, and
 * every single "Apply plan" was refused. Nothing caught it because the schema
 * lived in a `"use server"` module and the two shapes were only ever compared
 * at runtime, in production.
 */
function toPlan(date: string, columns: PlannerColumn[]): DispatchPlan {
  return {
    date,
    columns: columns.map((column) => ({
      routeId: column.id,
      jobIds: [...column.jobIds],
      driverId: column.driverId,
      vehicleId: column.vehicleId,
    })),
  };
}

/**
 * The dispatch board (design pack, screen 03).
 *
 * The whole day is arranged locally and committed once. That is deliberate:
 * dispatching is a series of trial moves — "if that stop goes to the north run,
 * does the west run still fit?" — and a board that saved every drag would leave
 * the run sheet transiently wrong after each one, with no way to back out of a
 * rearrangement halfway through.
 *
 * Dragging is never the only way to move a stop. Every card carries up/down
 * controls and a run picker that do exactly the same thing, because a depot
 * office is as likely to be driving this from a keyboard as a mouse.
 */
export function PlannerBoard({
  date, columns: initial, jobs, drivers, vehicles, action,
}: {
  /** The day being planned. Posted inside the payload — the action reads it
      from there, not from the URL, so the plan carries its own date. */
  date: string;
  columns: PlannerColumn[];
  jobs: Record<string, PlannerJob>;
  drivers: Option[];
  vehicles: Option[];
  action: (formData: FormData) => Promise<void>;
}) {
  const [columns, setColumns] = useState<PlannerColumn[]>(initial);
  const [dragging, setDragging] = useState<string | null>(null);

  const baseline = useMemo(() => JSON.stringify(toPlan(date, initial)), [date, initial]);
  const plan = toPlan(date, columns);
  const dirty = JSON.stringify(plan) !== baseline;

  const changes = useMemo(() => countChanges(initial, columns), [initial, columns]);

  function place(jobId: string, targetColumnId: string, targetIndex: number) {
    const job = jobs[jobId];
    if (!job) return;

    setColumns((current) => {
      const fromIndex = current.findIndex((column) => column.jobIds.includes(jobId));
      const toIndex = current.findIndex((column) => column.id === targetColumnId);
      if (fromIndex < 0 || toIndex < 0) return current;

      const from = current[fromIndex]!;
      const to = current[toIndex]!;

      // Mirrors the server's rules so the board never composes a plan the
      // action will reject — a rejection after ten moves loses all ten.
      if (fromIndex !== toIndex) {
        if (job.lockedBecause) return current;
        if (!from.open || !to.open) return current;
      }

      const next = current.map((column) => ({ ...column, jobIds: [...column.jobIds] }));
      const source = next[fromIndex]!;
      const at = source.jobIds.indexOf(jobId);
      source.jobIds.splice(at, 1);

      const destination = next[toIndex]!;
      const clamped = Math.max(0, Math.min(targetIndex, destination.jobIds.length));
      destination.jobIds.splice(clamped, 0, jobId);
      return next;
    });
  }

  function nudge(columnId: string, index: number, delta: number) {
    const column = columns.find((entry) => entry.id === columnId);
    const jobId = column?.jobIds[index];
    if (!column || !jobId) return;
    const target = index + delta;
    if (target < 0 || target >= column.jobIds.length) return;
    place(jobId, columnId, target);
  }

  function setCrew(columnId: string, field: "driverId" | "vehicleId", value: string) {
    setColumns((current) => current.map((column) =>
      column.id === columnId ? { ...column, [field]: value } : column));
  }

  const overloaded = columns.filter((column) => {
    if (column.id === UNASSIGNED) return false;
    const capacity = vehicles.find((v) => v.value === column.vehicleId)?.capacityKg ?? column.capacityKg;
    return estimateLoad(column.jobIds.map((id) => jobs[id]!).filter(Boolean), capacity ?? null).over;
  });

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="plan" value={JSON.stringify(plan)} />

      <div className="flex gap-3 overflow-x-auto pb-1">
        {columns.map((column) => {
          const capacity = column.id === UNASSIGNED
            ? null
            : vehicles.find((v) => v.value === column.vehicleId)?.capacityKg ?? null;
          const load = estimateLoad(
            column.jobIds.map((id) => jobs[id]!).filter(Boolean),
            capacity,
          );

          return (
            <section
              key={column.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging) place(dragging, column.id, column.jobIds.length);
                setDragging(null);
              }}
              className={cx(
                // `relative` is load-bearing, not cosmetic. Each stop card holds
                // an `sr-only` label, which is absolutely positioned; with no
                // positioned ancestor inside the board its containing block is
                // the page, so it escaped the board's horizontal scroller and
                // stretched the document ~230px wide on a phone. Making the
                // column a containing block keeps it clipped where it belongs.
                "relative flex w-[268px] shrink-0 flex-col rounded-xl border bg-surface shadow-sm",
                column.id === UNASSIGNED && "border-strong",
                !column.open && "opacity-70",
              )}
            >
              <header className="border-b px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-semibold">{column.code}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {column.jobIds.length}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-muted-foreground">{column.name}</span>
                  {column.status ? <StatusBadge status={column.status} /> : null}
                </div>

                {column.id === UNASSIGNED ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Stops scheduled for this date with no run.
                  </p>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    <CrewSelect
                      label="Driver" value={column.driverId} options={drivers} disabled={!column.open}
                      onChange={(value) => setCrew(column.id, "driverId", value)}
                    />
                    <CrewSelect
                      label="Vehicle" value={column.vehicleId} options={vehicles} disabled={!column.open}
                      onChange={(value) => setCrew(column.id, "vehicleId", value)}
                    />
                    <LoadMeter load={load} />
                  </div>
                )}
              </header>

              <ol className="flex-1 space-y-1.5 p-2">
                {column.jobIds.length === 0 ? (
                  <li className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                    {column.open ? "Drop a stop here" : "No stops"}
                  </li>
                ) : null}

                {column.jobIds.map((jobId, index) => {
                  const job = jobs[jobId];
                  if (!job) return null;
                  const movable = !job.lockedBecause && column.open;

                  return (
                    <li
                      key={jobId}
                      draggable={movable}
                      onDragStart={() => setDragging(jobId)}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(event) => {
                        event.preventDefault();
                        if (dragging && dragging !== jobId) place(dragging, column.id, index);
                      }}
                      className={cx(
                        "rounded-lg border bg-surface px-2.5 py-2",
                        dragging === jobId && "opacity-50",
                        job.status === "exception" && "border-l-[3px] border-l-danger",
                        !movable && "bg-surface-muted",
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {index + 1}
                        </span>
                        <Link href={`/jobs/${job.id}`}
                              className="truncate text-xs text-primary hover:underline">
                          {job.jobNumber}
                        </Link>
                      </div>
                      <p className="mt-0.5 truncate text-sm font-semibold">{job.customer}</p>
                      <p className="truncate text-xs text-muted-foreground">{job.site}</p>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <Badge>{humanise(job.serviceType)}</Badge>
                        {job.status === "exception" ? <Badge tone="danger">Exception</Badge> : null}
                        {job.lockedBecause ? <Badge tone="neutral">{job.lockedBecause}</Badge> : null}
                        {job.estimateKg != null ? (
                          <span className="text-2xs tabular-nums text-muted-foreground">
                            ≈{Math.round(job.estimateKg)}kg
                          </span>
                        ) : null}
                      </div>

                      {movable ? (
                        <div className="mt-1.5 flex items-center gap-1">
                          <button type="button" onClick={() => nudge(column.id, index, -1)}
                                  disabled={index === 0}
                                  aria-label={`Move ${job.jobNumber} earlier`}
                                  className="rounded-lg border border-strong px-1.5 py-0.5 text-2xs disabled:opacity-40">↑</button>
                          <button type="button" onClick={() => nudge(column.id, index, 1)}
                                  disabled={index === column.jobIds.length - 1}
                                  aria-label={`Move ${job.jobNumber} later`}
                                  className="rounded-lg border border-strong px-1.5 py-0.5 text-2xs disabled:opacity-40">↓</button>
                          <label className="sr-only" htmlFor={`move-${jobId}`}>
                            Move {job.jobNumber} to another run
                          </label>
                          <select
                            id={`move-${jobId}`}
                            value={column.id}
                            onChange={(event) => place(jobId, event.target.value, Number.MAX_SAFE_INTEGER)}
                            className="rounded-lg min-w-0 flex-1 border border-strong bg-surface-muted px-1 py-0.5 text-2xs"
                          >
                            {columns.filter((target) => target.open || target.id === column.id).map((target) => (
                              <option key={target.id} value={target.id}>{target.code}</option>
                            ))}
                          </select>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>

      {overloaded.length > 0 ? (
        <p className="rounded-lg border border-l-[5px] border-l-warning border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning">
          {overloaded.map((column) => column.code).join(", ")} {overloaded.length === 1 ? "is" : "are"} over
          the vehicle&rsquo;s rated capacity on recent-average weights. The plan can still be applied — the
          estimate is history, not a booking.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t pt-3">
        <button type="submit" disabled={!dirty}
                className="rounded-lg inline-flex items-center justify-center bg-action px-3 py-1.5 text-sm
 font-medium text-action-foreground transition hover:brightness-110
 disabled:pointer-events-none disabled:opacity-50">
          Apply plan
        </button>
        <button type="button" onClick={() => setColumns(initial)} disabled={!dirty}
                className="rounded-lg inline-flex items-center justify-center border border-strong bg-surface px-3 py-1.5
 text-sm font-medium transition hover:bg-surface-muted
 disabled:pointer-events-none disabled:opacity-50">
          Discard changes
        </button>
        <span className="text-sm text-muted-foreground">
          {dirty ? describeChanges(changes) : "No changes to apply."}
        </span>
      </div>
    </form>
  );
}

function CrewSelect({
  label, value, options, disabled, onChange,
}: {
  label: string; value: string; options: Option[]; disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <Eyebrow className="w-12 shrink-0">{label}</Eyebrow>
      <select
        value={value} disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg min-w-0 flex-1 border border-strong bg-surface-muted px-1.5 py-0.5 text-xs disabled:opacity-60"
      >
        <option value="">Unassigned</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * The meter reports what it can stand behind: the bar is the estimated load
 * against the truck's rating, and the caption says how many stops the estimate
 * actually covers. A run whose customers have never been weighed shows an empty
 * bar rather than a confident-looking zero.
 */
function LoadMeter({ load }: { load: ReturnType<typeof estimateLoad> }) {
  if (load.capacityKg == null) {
    return (
      <p className="text-2xs text-muted-foreground">
        {load.known > 0 ? `≈${load.kg} kg est.` : "No load estimate"} · no rated vehicle
      </p>
    );
  }

  const percent = Math.min(100, Math.round((load.ratio ?? 0) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <Eyebrow className={load.over ? "text-warning" : undefined}>Load est.</Eyebrow>
        <span className={cx(
          "text-2xs tabular-nums",
          load.over ? "text-warning" : "text-muted-foreground",
        )}>
          {load.kg} / {Math.round(load.capacityKg)} kg
        </span>
      </div>
      <div aria-hidden className="mt-0.5 h-[5px] bg-surface-muted">
        <div className={cx("h-full", load.over ? "bg-warning" : "bg-primary")}
             style={{ width: `${percent}%` }} />
      </div>
      {load.unknown > 0 ? (
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {load.known} of {load.known + load.unknown} stops weighed before
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ summary */

type Changes = { moved: number; resequenced: number; crew: number };

function countChanges(initial: PlannerColumn[], current: PlannerColumn[]): Changes {
  const before = new Map<string, { columnId: string; index: number }>();
  for (const column of initial) {
    column.jobIds.forEach((jobId, index) => before.set(jobId, { columnId: column.id, index }));
  }

  let moved = 0;
  let resequenced = 0;
  for (const column of current) {
    column.jobIds.forEach((jobId, index) => {
      const was = before.get(jobId);
      if (!was) return;
      if (was.columnId !== column.id) moved += 1;
      else if (was.index !== index) resequenced += 1;
    });
  }

  const crewBefore = new Map(initial.map((column) => [column.id, `${column.driverId}|${column.vehicleId}`]));
  const crew = current.filter((column) =>
    crewBefore.get(column.id) !== `${column.driverId}|${column.vehicleId}`).length;

  return { moved, resequenced, crew };
}

function describeChanges({ moved, resequenced, crew }: Changes): string {
  const parts = [
    moved > 0 && `${moved} stop${moved === 1 ? "" : "s"} moved`,
    resequenced > 0 && `${resequenced} resequenced`,
    crew > 0 && `${crew} crew change${crew === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return parts.length ? `Unapplied: ${parts.join(", ")}.` : "Unapplied changes.";
}
