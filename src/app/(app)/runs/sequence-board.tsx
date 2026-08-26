"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button, Notice, cx } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import {
  isMovable, isReordered, lockReason, moveStop, moveStopTo, type SequenceStop,
} from "./sequence";
import { reorderRunStops } from "./actions";
import { counted } from "@/lib/format";

/**
 * The order of a board's day: locked by default, edited deliberately, saved once.
 *
 * **Locked is the resting state, and opening the screen never leaves it.** The
 * client's rule is that management determines the order and drivers execute it,
 * and the failure that rule is written against is not malice — it is a manager
 * opening a run to *look* at it on a phone and nudging a row with their thumb.
 * So there is no drag, no handle and no arrow on screen until somebody presses
 * Adjust Run, and pressing it is the only way in.
 *
 * **Editing is a screen state and is deliberately never persisted.** Entering it
 * writes nothing, so Cancel Changes has nothing to undo and a manager who walks
 * away from an open tab leaves no run "checked out" behind them. The lock the
 * database carries (`daily_routes.sequence_locked`) is the standing statement
 * that this order is management's to set; it is not a mutex.
 *
 * **Compose locally, commit once.** Nothing is written until Save & Lock Run,
 * because ordering a day is a sequence of trial moves and a board that wrote
 * each drag would leave the run sheet transiently wrong after every one. The
 * whole order goes in one hidden JSON field whose contract is `sequence.ts` — a
 * plain module, with tests written against what this component really emits,
 * because this repository has shipped two such payloads broken behind a green
 * `verify`.
 *
 * **Drag is the nice path, not the only one.** Move up and Move down are real
 * buttons at 44px: a drag-only control is unusable with a keyboard and awkward
 * on the phone a manager is actually holding on the floor. Both routes call the
 * same tested `moveStop` / `moveStopTo`.
 */

export type { SequenceStop };

export function SequenceBoard({
  boardId, boardName, date, stops, version, canSequence, returnTo,
}: {
  boardId: string;
  boardName: string;
  date: string;
  stops: SequenceStop[];
  /** The order's version when this page was rendered — the concurrency token. */
  version: number;
  /** Whether this person may order a run at all. Drivers and boards may not. */
  canSequence: boolean;
  /**
   * Where the save should land, when it is not the Runs screen.
   *
   * My Runs draws this same board, and a manager who adjusts a run from there
   * has to come back to the round's day rather than be moved to another screen
   * — the `return_to` convention the billing panes already hold. The action
   * re-validates it as a plain same-site path, because a form field is not
   * evidence and an absolute one would make every save an open redirect.
   */
  returnTo?: string;
}) {
  const original = stops.map((stop) => stop.id);
  const signature = `${version}:${original.join(",")}`;

  const [saved, setSaved] = useState(signature);
  const [order, setOrder] = useState<string[]>(original);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  // The server now holds a different order from the one this component was
  // mounted with — a save of our own, or somebody else's landing on a
  // navigation. Adopting it during render is what makes "Save & Lock" return to
  // locked with the new order rather than leaving the old one on screen; the
  // job form adopts a changed customer the same way and for the same reason.
  if (saved !== signature) {
    setSaved(signature);
    setOrder(original);
    setEditing(false);
    setDragging(null);
  }

  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  const dirty = isReordered(order, original);
  const rows = order.map((id) => byId.get(id)).filter(Boolean) as SequenceStop[];
  const frozen = rows.filter((stop) => !isMovable(stop));

  const move = (id: string, direction: "up" | "down") =>
    setOrder((current) => moveStop(current, id, direction));

  const drop = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    setOrder((current) => moveStopTo(current, dragging, current.indexOf(targetId)));
    setDragging(null);
  };

  const cancel = () => {
    setOrder(original);
    setEditing(false);
    setDragging(null);
  };

  return (
    <form action={reorderRunStops} className="space-y-3">
      {/* One field, composed here and committed once. The version travels with
          it so a stale editing session cannot overwrite a newer sequence. */}
      <input
        type="hidden"
        name="plan"
        value={JSON.stringify({
          board_id: boardId, date, stops: order, expected_version: version,
        })}
      />
      {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}

      <StateBanner
        editing={editing} boardName={boardName} stopCount={rows.length}
        canSequence={canSequence}
      />

      {editing && frozen.length > 0 ? (
        <Notice tone="info" title={`${counted(frozen.length, "stop")} cannot be moved`}>
          {frozen.map((stop) => stop.customerName).join(", ")} — the round has already
          been there. Moving a worked stop would rewrite where work that has already
          happened happened, so its place stays put and the rest order around it.
        </Notice>
      ) : null}

      <ol className="space-y-2">
        {rows.map((stop, index) => {
          const locked = !isMovable(stop);
          const reason = lockReason(stop);
          const draggable = editing && !locked;
          return (
            <li
              key={stop.id}
              draggable={draggable}
              onDragStart={() => draggable && setDragging(stop.id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => { if (editing && dragging) event.preventDefault(); }}
              onDrop={(event) => { event.preventDefault(); if (editing) drop(stop.id); }}
              className={cx(
                "flex items-start gap-3 rounded-lg border bg-surface p-3",
                dragging === stop.id && "opacity-50",
                editing && !locked ? "border-strong" : "border-border",
                draggable && "cursor-grab active:cursor-grabbing",
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
                          read from a phone, and an 18px-tall link beside a drag
                          handle is a mis-tap waiting to happen. */}
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

              {/* Only in editing mode: a locked run shows no control at all,
                  rather than a disabled one that invites a press. */}
              {editing ? (
                <div className="flex shrink-0 flex-col gap-1">
                  {/* The accessible name is the text, not an aria-label: the
                      arrow alone would announce as "up" with no object.
                      `min-w-11`/`min-h-11` because these are now the primary
                      way a run is reordered — a 36px arrow is a mis-tap on the
                      phone this is actually used from. */}
                  <Button
                    type="button" variant="ghost" size="sm" className="min-h-11 min-w-11"
                    onClick={() => move(stop.id, "up")}
                    disabled={locked || index === 0}
                  >
                    <span aria-hidden>↑</span>
                    <span className="sr-only">Move {stop.customerName} up</span>
                  </Button>
                  <Button
                    type="button" variant="ghost" size="sm" className="min-h-11 min-w-11"
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

      {/* The controls. A person who may not order a run sees none of this — not
          a disabled button, and not an explanation of a thing they cannot do. */}
      {canSequence ? (
        <div className="flex flex-wrap items-center gap-3">
          {editing ? (
            <>
              <SubmitButton pendingLabel="Saving the order…">Save &amp; Lock Run</SubmitButton>
              <Button type="button" variant="ghost" className="min-h-11" onClick={cancel}>
                Cancel Changes
              </Button>
              <span className="text-sm text-muted-foreground">
                {dirty
                  ? "Not saved yet — the round still sees the old order."
                  : "Drag a stop, or use the arrows."}
              </span>
            </>
          ) : (
            <>
              <Button type="button" className="min-h-11" onClick={() => setEditing(true)}>
                Adjust Run
              </Button>
              <span className="text-sm text-muted-foreground">
                This is the order {boardName} will drive.
              </span>
            </>
          )}
        </div>
      ) : null}
    </form>
  );
}

/**
 * Which state the run is in, said in one line at the top of the list.
 *
 * `aria-live` because the change is announced by a button press elsewhere on
 * the page: a sighted person sees the arrows appear, and without this a screen
 * reader user gets no confirmation that Adjust Run did anything.
 */
function StateBanner({
  editing, boardName, stopCount, canSequence,
}: { editing: boolean; boardName: string; stopCount: number; canSequence: boolean }) {
  return (
    <div
      aria-live="polite"
      className={cx(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2",
        editing ? "border-strong bg-surface-sunken" : "border-border bg-surface",
      )}
    >
      <span className="font-medium">
        <span aria-hidden>{editing ? "🔓" : "🔒"}</span>{" "}
        {editing ? "Editing run" : "Run locked"}
      </span>
      <span className="text-sm text-muted-foreground">
        {editing
          ? `Drag stops to change the order ${boardName} drives in. Nothing is saved until you press Save & Lock Run.`
          : canSequence
            ? `${counted(stopCount, "stop")} — press Adjust Run to change the order.`
            : `${counted(stopCount, "stop")}, in the order the office set.`}
      </span>
    </div>
  );
}
