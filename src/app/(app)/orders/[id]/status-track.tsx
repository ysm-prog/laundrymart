import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import { cx } from "@/components/ui";
import type { StatusStep } from "@/lib/domain/laundry-orders";

/**
 * The job's stages, as a track you can press.
 *
 * Adopted from `ysm-prog/ysm-hub`'s job detail (`.status-track`), which is the
 * same problem one product over: a job that walks a known sequence, and staff who
 * need to move it *back* as often as forward — their own note beside it reads
 * "useful when a job has to go back, e.g. In Repair → Awaiting Parts if a missing
 * part turns up". Ours replaced a row of buttons that offered exactly one step at
 * a time, so a counter hand who marked a job ready by mistake had no way back and
 * a job that skipped the plant took two presses and two page loads.
 *
 * Three departures from YSM's version, each following a rule this app already
 * holds rather than diverging from it:
 *
 *  - **Steps are form submits, not click handlers.** Every screen here is an
 *    async server component, so the move has to be a post to a server action —
 *    which also makes the track work with no JavaScript at all, and that matters
 *    on a counter tablet and a phone in a van.
 *  - **Sentence case, not uppercase mono.** YSM spends mono freely on step
 *    labels; §10b records the 2026-08-13 sweep that took that voice out of 28
 *    files because counter staff read it as a developer console.
 *  - **A step that cannot be pressed says why**, rather than being silently
 *    inert. Assigned and Completed are never pressable — each captures more than
 *    a status — so each carries the sentence naming its own control.
 *
 * The rule behind every one of those states is `buildStatusTrack`, which is pure
 * and tested. This file draws what it is handed and decides nothing.
 */
export function StatusTrack({
  steps, orderId, action, returnTo,
}: {
  steps: StatusStep[];
  orderId: string;
  action: (formData: FormData) => Promise<void>;
  /** Where the action should land. Re-validated server-side as a same-site path. */
  returnTo?: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={orderId} />
      {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
      {/* Three columns on a phone and one per stage from `sm` up — YSM Hub's own
          answer (`@media (max-width: …) { .status-track { grid-template-columns:
          repeat(3, 1fr) } }`), and measuring is what showed it was needed: six
          columns at 320px leaves each step 35px wide, under the 36px floor §10b
          holds for anything a thumb has to find. The column count rides a CSS
          variable rather than an inline `grid-template-columns`, because an
          inline style would win over the breakpoint and there would be nothing
          to wrap. */}
      <ol
        className="grid grid-cols-3 gap-x-1 gap-y-5 sm:[grid-template-columns:repeat(var(--track-cols),minmax(0,1fr))]"
        style={{ "--track-cols": steps.length } as CSSProperties}
      >
        {steps.map((step, index) => (
          <Step key={step.status} step={step} last={index === steps.length - 1} />
        ))}
      </ol>
    </form>
  );
}

function Step({ step, last }: { step: StatusStep; last: boolean }) {
  const done = step.state === "done";
  const current = step.state === "current";

  /* The dot, and the rail running to the next step. The rail is drawn behind the
     dot and stops at the last step, so the track reads as one line rather than
     as six detached markers. `aria-hidden`, because the label is what carries
     the meaning — a screen reader announcing six decorative rules between the
     labels would make the track harder to use rather than easier. */
  const marker = (
    <span className="relative flex h-4 w-full items-center justify-center" aria-hidden>
      {/* Hidden below `sm`, where the track wraps: a rail drawn from the end of
          one row would point at nothing. YSM hides them at its own breakpoint
          for the same reason. */}
      {last ? null : (
        <span
          className={cx(
            "absolute left-1/2 top-1/2 hidden h-0.5 w-full -translate-y-1/2 sm:block",
            done ? "bg-primary" : "bg-border",
          )}
        />
      )}
      <span
        className={cx(
          "relative z-10 flex size-4 items-center justify-center rounded-full border-2 transition",
          done && "border-primary bg-primary text-primary-foreground",
          current && "border-primary bg-primary ring-4 ring-primary/20",
          !done && !current && "border-strong bg-surface",
        )}
      >
        {done ? <Check className="size-2.5" strokeWidth={3.5} /> : null}
      </span>
    </span>
  );

  const label = (
    <span
      className={cx(
        "block text-center text-2xs leading-tight sm:text-xs",
        current && "font-semibold text-primary",
        done && "text-foreground",
        !done && !current && "text-muted-foreground",
      )}
    >
      {step.label}
    </span>
  );

  return (
    /* The list item is the grid column. `display: contents` would have been
       tidier markup and is the thing to avoid here — it drops the item out of
       the accessibility tree in more than one shipping browser, which on a list
       of steps is the whole structure gone. */
    <li className="min-w-0">
      {step.jump ? (
        /* 44px of target, per §10b — pressed on a counter tablet and a driver's
           phone. The label sits inside the button so the target is the whole
           column rather than four legible pixels of dot. No focus styling: the
           app's own `:focus-visible` rule already draws a 3px ring, and turning
           it off at a call site is the defect the 2026-08-24 pass swept out. */
        <button
          type="submit"
          name="status"
          value={step.status}
          title={`Move this job to ${step.label.toLowerCase()}`}
          className="group flex min-h-11 w-full cursor-pointer flex-col items-center gap-2 rounded-lg px-0.5 py-1 transition hover:bg-primary/8"
        >
          {marker}
          <span className="w-full group-hover:text-primary">{label}</span>
        </button>
      ) : (
        <div
          className={cx("flex min-h-11 w-full flex-col items-center gap-2 px-0.5 py-1",
                        step.note ? "cursor-help" : undefined)}
          title={current ? "Where this job is now" : step.note ?? undefined}
          aria-current={current ? "step" : undefined}
        >
          {marker}
          {label}
        </div>
      )}
    </li>
  );
}
