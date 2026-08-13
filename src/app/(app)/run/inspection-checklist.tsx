"use client";

import { useRef } from "react";

/**
 * The pre-run checklist, deliberately starting unchecked: an inspection is an
 * attestation, so ticking must be an act, not a default. "All checks OK" keeps
 * the fast path to one deliberate tap for the everyday case where the vehicle
 * is fine — it ticks the real (uncontrolled) inputs, so the form posts exactly
 * as if each box had been tapped.
 */
export function InspectionChecklist({ items }: { items: Array<{ name: string; label: string }> }) {
  const container = useRef<HTMLDivElement>(null);

  function tickAll() {
    container.current
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((box) => { box.checked = true; });
  }

  return (
    <div className="space-y-2.5">
      <div ref={container} className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <label key={item.name} className="flex items-center gap-2 text-sm">
            <input
              id={item.name}
              name={item.name}
              type="checkbox"
              className="h-3.5 w-3.5 border border-strong accent-primary"
            />
            {item.label}
          </label>
        ))}
      </div>
      <button
        type="button"
        onClick={tickAll}
        className="rounded-lg border border-strong bg-surface px-2.5 py-1.5 text-xs font-medium hover:bg-surface-muted"
      >
        All checks OK — tick everything
      </button>
    </div>
  );
}
