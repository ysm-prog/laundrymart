"use client";

import { useSyncExternalStore } from "react";
import { cx } from "./ui";
import { applyTextSize } from "./app-nav";
import {
  DEFAULT_TEXT_SIZE, TEXT_SIZES, TEXT_SIZE_ATTRIBUTE, TEXT_SIZE_LABELS, parseTextSize,
} from "@/lib/display";

/**
 * "Is this big enough to read?" — asked in words, on the home screen.
 *
 * The header carries the same preference as a single cycling button, which is
 * right for somebody who knows it is there. This is for somebody who does not:
 * three labelled choices, each drawn at the size it selects, so the control
 * demonstrates itself rather than describing itself. Pressing one changes the
 * page underneath immediately — including this card — which is the whole
 * feedback loop, and it needs no Save.
 *
 * A radio group rather than three buttons: they are one question with one
 * answer, and that is what a screen reader should announce.
 */
export function ReadingComfort() {
  const size = useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, {
        attributes: true, attributeFilter: [TEXT_SIZE_ATTRIBUTE],
      });
      return () => observer.disconnect();
    },
    () => parseTextSize(document.documentElement.getAttribute(TEXT_SIZE_ATTRIBUTE)),
    () => DEFAULT_TEXT_SIZE, // Server render: the bootstrap script has not run yet.
  );

  return (
    <div role="group" aria-labelledby="reading-comfort-label"
         className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4">
      <p id="reading-comfort-label" className="text-sm font-medium">
        Is the writing big enough?
      </p>
      <div className="flex flex-wrap gap-2">
        {TEXT_SIZES.map((option) => {
          const current = option === size;
          return (
            <button
              key={option}
              type="button"
              onClick={() => applyTextSize(option)}
              aria-pressed={current}
              title={TEXT_SIZE_LABELS[option].hint}
              className={cx(
                "inline-flex min-h-11 items-center rounded-lg border px-4 font-medium transition",
                // Each option is drawn at roughly the size it selects, so the
                // choice is visible rather than described.
                option === "normal" && "text-sm",
                option === "large" && "text-base",
                option === "xlarge" && "text-lg",
                current
                  ? "border-primary bg-primary text-primary-foreground shadow-xs"
                  : "border-strong bg-surface hover:bg-surface-muted",
              )}
            >
              {TEXT_SIZE_LABELS[option].label}
              {/* Colour alone never carries meaning in this app — the selected
                  option says so in words as well. */}
              {current ? <span className="sr-only"> (this is the one you are using)</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
