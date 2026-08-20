"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { SubmitButton } from "./form";
import { CONTROL, cx } from "./ui";

/**
 * The confirm affordance for final actions (design spec AD-9): the first tap
 * swaps the button for an inline panel that states the consequence in plain
 * words — and, where the action demands one, asks for a reason — with the real
 * submit beside a way out.
 *
 * Inline rather than a modal on purpose. The consequence should sit next to the
 * button that causes it, especially on a phone, where a centred dialog covers
 * the very row the operator is trying to check before they commit.
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
  reasonRequired = true,
  pendingLabel,
  variant = "danger",
}: {
  /** The button text, e.g. "Void invoice". */
  label: string;
  /** One plain sentence on what happens, e.g. "This closes the run for the day. It cannot be reopened." */
  consequence: string;
  /** The short warning heading over the consequence. */
  eyebrow?: string;
  /** When set, a reason input posted under this field name. */
  reasonName?: string;
  reasonLabel?: string;
  /**
   * Whether that reason must be filled in. Defaults to true, which is what
   * voiding an invoice and closing a run both need. Cancelling a laundry job is
   * the exception: the reason is genuinely useful and genuinely optional, and
   * demanding one would only teach people to type "n/a".
   */
  reasonRequired?: boolean;
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
          "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm",
          "font-medium shadow-xs transition",
          variant === "danger"
            ? "border border-danger/40 text-danger hover:bg-danger/8"
            : "bg-action text-action-foreground hover:brightness-110",
        )}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-danger/30 bg-danger/5 p-4">
      <div className="flex gap-3">
        <TriangleAlert className="mt-0.5 size-[1.15rem] shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-danger">{eyebrow}</p>
          <p className="mt-1 text-sm">{consequence}</p>
          {reasonName ? (
            <label className="mt-3 block">
              <span className="text-sm font-medium">
                {reasonLabel}
                {reasonRequired ? null : (
                  <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                )}
              </span>
              <input
                name={reasonName}
                required={reasonRequired}
                autoFocus
                className={cx(CONTROL, "mt-1.5")}
              />
            </label>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <SubmitButton variant={variant === "danger" ? "danger" : "primary"}
                          pendingLabel={pendingLabel ?? "Working…"}>
              {label}
            </SubmitButton>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex min-h-11 items-center rounded-lg border border-strong bg-surface
                         px-4 text-sm font-medium shadow-xs transition hover:bg-surface-muted"
            >
              Keep it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
