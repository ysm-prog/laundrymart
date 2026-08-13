"use client";

import { useState } from "react";
import { cx } from "./ui";

export type SequencerStop = {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

/**
 * Drag-and-drop stop ordering (spec §7.7).
 *
 * Keyboard users get Move up / Move down buttons that do exactly the same
 * thing — dragging is never the only way to reorder a route.
 */
export function StopSequencer({
  stops, templateId, action,
}: {
  stops: SequencerStop[];
  templateId: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [order, setOrder] = useState(stops);
  const [dragging, setDragging] = useState<string | null>(null);
  const dirty = order.map((s) => s.id).join(",") !== stops.map((s) => s.id).join(",");

  function move(from: number, to: number) {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    setOrder(next);
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="template_id" value={templateId} />
      <input type="hidden" name="order" value={order.map((stop) => stop.id).join(",")} />

      <ol className="space-y-2">
        {order.map((stop, index) => (
          <li
            key={stop.id}
            draggable
            onDragStart={() => setDragging(stop.id)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => {
              event.preventDefault();
              if (!dragging || dragging === stop.id) return;
              move(order.findIndex((s) => s.id === dragging), index);
            }}
            className={cx(
              "flex items-center gap-3 rounded-md border bg-surface p-3",
              dragging === stop.id && "opacity-50",
            )}
          >
            <span aria-hidden className="cursor-grab select-none text-muted-foreground">⋮⋮</span>
            <span className="w-6 shrink-0 text-sm font-semibold tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{stop.title}</span>
              {stop.subtitle ? (
                <span className="block truncate text-xs text-muted-foreground">{stop.subtitle}</span>
              ) : null}
            </span>
            {stop.meta ? <span className="hidden text-xs text-muted-foreground sm:block">{stop.meta}</span> : null}
            <span className="flex shrink-0 gap-1">
              <button type="button" onClick={() => move(index, index - 1)} disabled={index === 0}
                      aria-label={`Move ${stop.title} up`}
                      className="rounded border px-2 py-1 text-xs disabled:opacity-40">↑</button>
              <button type="button" onClick={() => move(index, index + 1)} disabled={index === order.length - 1}
                      aria-label={`Move ${stop.title} down`}
                      className="rounded border px-2 py-1 text-xs disabled:opacity-40">↓</button>
            </span>
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={!dirty}
                className="rounded-md bg-action px-3 py-2 text-sm font-medium text-action-foreground
 transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-50">
          Save order
        </button>
        {dirty ? <span className="text-sm text-muted-foreground">Unsaved changes</span> : null}
      </div>
    </form>
  );
}
