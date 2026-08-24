"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button, cx } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { isMovable, isReordered, lockReason, moveStop, moveStopTo } from "./sequence";
import { reorderRunStops } from "./actions";
import { counted } from "@/lib/format";

/**
 * The order of a board's day, dragged or keyed.
 *
 * **Compose locally, commit once.** Nothing is saved until Save order, because
 * ordering a day is a sequence of trial moves and a board that wrote each drag
 * would leave the run sheet transiently wrong after every one — the same
 * argument the dispatch planner makes for Apply plan. The whole order goes in
 * one hidden JSON field, whose contract is `sequence.ts` (a plain module, with
 * tests written against what this component really emits).
 *
 * **Drag is the nice path, not the only one.** Move up and Move down are always
 * visible and always work: a drag-only control is unusable with a keyboard and
 * awkward on a phone, which is where a manager reorders a run while standing on
 * the floor. Both routes call the same tested `moveStop` / `moveStopTo`.
 *
 * A stop the round has already worked cannot move, and says which it is rather
 * than silently refusing — moving anything past it would rewrite where work that
 * already happened happened.
 */

export type SequenceStop = {
  id: string;
  status: string;
  progressStatus: string;
  customerName: string;
  address: string | null;
  jobs: Array<{ id: string; orderNumber: string; itemCount: number }>;
};

export function SequenceBoard({
  boardId, boardName, date, stops, canWrite,
}: {
  boardId: string;
  boardName: string;
  date: string;
  stops: SequenceStop[];
  canWrite: boolean;
}) {
  const original = stops.map((stop) => stop.id);
  const [order, setOrder] = useState<string[]>(original);
  const [dragging, setDragging] = useState<string | null>(null);

  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  const dirty = isReordered(order, original);

  const rows = order.map((id) => byId.get(id)).filter(Boolean) as SequenceStop[];

  const asOrderable = (stop: SequenceStop) => ({
    id: stop.id, status: stop.status, progress_status: stop.progressStatus,
  });

  const move = (id: string, direction: "up" | "down") =>
    setOrder((current) => moveStop(current, id, direction));

  const drop = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    setOrder((current) => moveStopTo(current, dragging, current.indexOf(targetId)));
    setDragging(null);
  };

  return (
    <form action={reorderRunStops} className="space-y-3">
      {/* One field, composed here and committed once. */}
      <input
        type="hidden"
        name="plan"
        value={JSON.stringify({ board_id: boardId, date, stops: order })}
      />

      <ol className="space-y-2">
        {rows.map((stop, index) => {
          const locked = !isMovable(asOrderable(stop));
          const reason = lockReason(asOrderable(stop));
          return (
            <li
              key={stop.id}
              draggable={canWrite && !locked}
              onDragStart={() => setDragging(stop.id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => { if (dragging) event.preventDefault(); }}
              onDrop={(event) => { event.preventDefault(); drop(stop.id); }}
              className={cx(
                "flex items-start gap-3 rounded-lg border bg-surface p-3",
                dragging === stop.id && "opacity-50",
                locked ? "border-border" : "border-strong",
                canWrite && !locked && "cursor-grab active:cursor-grabbing",
              )}
            >
              {/* The position, which is the whole point of the screen. */}
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-lg
                           bg-surface-sunken text-sm font-semibold tabular-nums"
              >
                {index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    <span className="sr-only">Stop {index + 1}: </span>
                    {stop.customerName}
                  </span>
                  {reason ? <Badge tone="neutral">{reason}</Badge> : null}
                </div>
                {stop.address ? (
                  <p className="truncate text-sm text-muted-foreground">{stop.address}</p>
                ) : null}
                <ul className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                  {stop.jobs.map((job) => (
                    <li key={job.id} className="flex items-center gap-1">
                      {/* A padded hit area, not a bare line of text: this row is
                          reordered from a phone, and an 18px-tall link beside a
                          drag handle is a mis-tap waiting to happen. */}
                      <Link
                        href={`/orders/${job.id}`}
                        className="inline-flex min-h-9 items-center rounded-lg px-1 font-medium
                                   hover:underline focus:ring-2 focus:ring-primary/25"
                      >
                        {job.orderNumber}
                      </Link>
                      <span>· {counted(job.itemCount, "item")}</span>
                    </li>
                  ))}
                  {stop.jobs.length === 0 ? <li>No laundry on this stop</li> : null}
                </ul>
              </div>

              {canWrite ? (
                <div className="flex shrink-0 flex-col gap-1">
                  {/* The accessible name is the text, not an aria-label: the
                      arrow alone would announce as "up" with no object. */}
                  {/* `min-w-9` because `size="sm"` sizes on the *content*, and a
                      single arrow measured 34px wide — under the 36px floor,
                      found by measuring the gallery rather than by looking at
                      it. Height was already 36. */}
                  <Button
                    type="button" variant="ghost" size="sm" className="min-w-9"
                    onClick={() => move(stop.id, "up")}
                    disabled={locked || index === 0}
                  >
                    <span aria-hidden>↑</span>
                    <span className="sr-only">Move {stop.customerName} up</span>
                  </Button>
                  <Button
                    type="button" variant="ghost" size="sm" className="min-w-9"
                    onClick={() => move(stop.id, "down")}
                    disabled={locked || index === rows.length - 1}
                  >
                    <span aria-hidden>↓</span>
                    <span className="sr-only">Move {stop.customerName} down</span>
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {canWrite ? (
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pendingLabel="Saving the order…">
            Save order for {boardName}
          </SubmitButton>
          {dirty ? (
            <>
              <Button type="button" variant="ghost" onClick={() => setOrder(original)}>
                Undo changes
              </Button>
              <span className="text-sm text-muted-foreground">
                Not saved yet — the round still sees the old order.
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              This is the order {boardName} will drive.
            </span>
          )}
        </div>
      ) : null}
    </form>
  );
}
