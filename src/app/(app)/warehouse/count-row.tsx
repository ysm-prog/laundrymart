"use client";

import { useState } from "react";
import { cx } from "@/components/ui";

/**
 * One line of the depot count: what the driver said, and what is actually on
 * the trolley in front of you.
 *
 * Deliberately not a bare number field. The common case is "the driver was
 * right", so the field starts on their figure and most rows need no touch at
 * all; the case after that is "one or two out", which is a tap on − or +. Only
 * a wholesale disagreement needs the keyboard. Big targets because this is used
 * standing on a dock, often on a phone.
 */
export function CountRow({
  itemId, name, sku, driverQuantity,
}: {
  itemId: string; name: string; sku: string; driverQuantity: number;
}) {
  const [value, setValue] = useState(driverQuantity);
  const difference = value - driverQuantity;

  const step = (by: number) => setValue((current) => Math.max(0, current + by));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="min-w-40 flex-1">
        <p className="text-sm font-medium">{name}</p>
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground">
          {sku} · driver said {driverQuantity}
        </p>
      </div>

      <div className="flex items-center gap-2">
        {difference !== 0 ? (
          <span
            className={cx(
              "border px-2 py-1 font-mono text-2xs uppercase tracking-[0.08em]",
              difference < 0
                ? "border-danger/40 bg-danger/10 text-danger"
                : "border-warning/40 bg-warning/10 text-warning",
            )}
          >
            {difference < 0 ? `${-difference} short` : `${difference} extra`}
          </span>
        ) : null}

        <button
          type="button" onClick={() => step(-1)} disabled={value === 0}
          aria-label={`One fewer ${name}`}
          className="h-10 w-10 border border-strong bg-surface-muted text-lg leading-none disabled:opacity-40"
        >
          −
        </button>

        <input
          name={`count_${itemId}`} type="number" min={0} inputMode="numeric"
          value={value}
          onChange={(event) => setValue(Math.max(0, Math.trunc(Number(event.target.value) || 0)))}
          aria-label={`Counted ${name}`}
          className="h-10 w-20 border border-strong bg-surface-muted text-center font-mono text-base"
        />

        <button
          type="button" onClick={() => step(1)}
          aria-label={`One more ${name}`}
          className="h-10 w-10 border border-strong bg-surface-muted text-lg leading-none"
        >
          +
        </button>
      </div>
    </div>
  );
}
