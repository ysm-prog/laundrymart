"use client";

import { useState } from "react";
import { Card, CONTROL, SELECT_CHEVRON, cx } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { reassignJobsToBoard } from "./actions";
import type { RunBoard } from "@/lib/runs/my-runs";

/**
 * Move work between boards — one job or a selection of them.
 *
 * The client's operational point: Driver A is off, so Board 1's afternoon goes
 * to Board 3. That must not mean opening every job.
 *
 * **One press is one request.** The whole selection posts to a single action
 * which re-reads every id and re-checks every job, so a stale tick is refused
 * rather than acted on — the same contract the billing bulk actions hold. The
 * counts beside the button are the operator's confirmation of what they are
 * about to do, not a source of truth.
 *
 * The checkboxes take the shared `Checkbox`'s **skin and padded hit area**
 * rather than the component itself: that one is uncontrolled and this selection
 * is React state. The rule the design system actually cares about is that a tap
 * target is never the bare 16px box, and a `min-h-11` label satisfies it — the
 * same compromise the billing queue makes for the same reason.
 */

const CHECKBOX = "size-[1.15rem] shrink-0 rounded border-strong accent-primary";

type MovableJob = { id: string; orderNumber: string; customerName: string };

export function MoveToBoard({
  date, fromBoard, boards, jobs,
}: {
  date: string;
  fromBoard: RunBoard;
  boards: RunBoard[];
  jobs: MovableJob[];
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  if (jobs.length === 0) return null;

  const others = boards.filter((board) => board.id !== fromBoard.id);
  const allSelected = jobs.length > 0 && jobs.every((job) => selected.has(job.id));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card
      title="Move work to another board"
      description={`Take jobs off ${fromBoard.name} and give them to another round for the same day. Nothing about the job itself changes.`}
    >
      <form action={reassignJobsToBoard} className="space-y-3">
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="return_date" value={date} />
        <input type="hidden" name="return_board" value={fromBoard.id} />

        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
          <input
            type="checkbox"
            className={CHECKBOX}
            checked={allSelected}
            onChange={() =>
              setSelected(allSelected ? new Set() : new Set(jobs.map((job) => job.id)))}
          />
          Select all {jobs.length} job(s)
        </label>

        <ul className="divide-y divide-border rounded-lg border border-border">
          {jobs.map((job) => (
            <li key={job.id}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  name="selected"
                  value={job.id}
                  className={CHECKBOX}
                  checked={selected.has(job.id)}
                  onChange={() => toggle(job.id)}
                />
                <span className="font-medium">{job.orderNumber}</span>
                <span className="text-muted-foreground">{job.customerName}</span>
              </label>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-48">
            <label htmlFor="move-board" className="mb-1 block text-sm font-medium">
              Move to
            </label>
            <select
              id="move-board" name="board_id" required defaultValue=""
              className={cx(CONTROL, SELECT_CHEVRON)}
            >
              <option value="">Choose a board…</option>
              {others.map((board) => (
                <option key={board.id} value={board.id}>{board.name}</option>
              ))}
            </select>
          </div>
          <SubmitButton pendingLabel="Moving…">
            Move {selected.size} job(s)
          </SubmitButton>
          {selected.size === 0 ? (
            <span className="text-sm text-muted-foreground">Tick the jobs to move first.</span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
