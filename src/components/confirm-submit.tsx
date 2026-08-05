"use client";

import { useState } from "react";
import { SubmitButton } from "./form";
import { cx } from "./ui";

/**
 * The confirm affordance for final actions (design spec AD-9): the first tap
 * swaps the button for an inline strip that states the consequence in plain
 * words — and, where the action demands one, asks for a reason — with the real
 * submit beside a way out. Inline rather than a modal on purpose: the flat
 * design system has no overlays, and the consequence should sit next to the
 * button that causes it, especially on a phone.
 *
 * Render inside the <form> in place of its submit button. The form still posts
 * to the same server action; this component is pure presentation.
 */
export function ConfirmSubmit({
  label,
  consequence,
  eyebrow = "Cannot be undone",
  reasonName,
  reasonLabel = "Reason",
  pendingLabel,
  variant = "danger",
}: {
  /** The button text, e.g. "Void invoice". */
  label: string;
  /** One plain sentence on what happens, e.g. "This closes the run for the day. It cannot be reopened." */
  consequence: string;
  /** The mono warning label over the consequence. */
  eyebrow?: string;
  /** When set, a required reason input posted under this field name. */
  reasonName?: string;
  reasonLabel?: string;
  pendingLabel?: string;
  variant?: "danger" | "primary";
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx(
          "inline-flex items-center justify-center px-3 py-1.5 text-[12.5px] font-medium transition",
          variant === "danger"
            ? "border border-danger/40 text-danger hover:bg-danger/5"
            : "bg-action text-action-foreground hover:opacity-90",
        )}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="w-full border border-l-[5px] border-danger/40 border-l-danger p-3">
      <p className="font-mono text-3xs uppercase tracking-[0.12em] text-danger">{eyebrow}</p>
      <p className="mt-1 text-[12.5px]">{consequence}</p>
      {reasonName ? (
        <label className="mt-2 block">
          <span className="text-xs font-medium">{reasonLabel}</span>
          <input
            name={reasonName}
            required
            autoFocus
            className="mt-1 w-full border border-strong bg-surface-muted px-2.5 py-1.5 text-[12.5px]"
          />
        </label>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <SubmitButton variant={variant === "danger" ? "danger" : "primary"} pendingLabel={pendingLabel ?? "Working…"}>
          {label}
        </SubmitButton>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="border border-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium hover:bg-surface-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
