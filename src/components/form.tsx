"use client";

import { useFormStatus } from "react-dom";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { CONTROL, SELECT_CHEVRON, cx } from "./ui";

/**
 * A labelled field.
 *
 * The label is 14px sentence-case sans — it used to be 10px mono uppercase with
 * wide tracking, which is the single change that most made forms read as
 * database admin rather than as a question someone is being asked.
 *
 * Helper text is deliberately optional and used sparingly: a hint under every
 * field is noise that trains people to read none of them.
 */
export function Field({
  label, name, hint, error, required, children, className,
}: {
  label: string; name: string; hint?: string; error?: string;
  required?: boolean; children: ReactNode; className?: string;
}) {
  /*
   * The hint and the error are tied to the control by id, so a screen reader
   * announces them as part of the field rather than leaving them as loose text
   * nearby — and so `aria-invalid` marks which box is actually wrong. Neither
   * was wired up before: `aria-describedby` and `aria-invalid` appeared nowhere
   * in the app, and a refusal was only ever a toast in the corner.
   */
  const hintId = hint && !error ? `${name}-hint` : undefined;
  const errorId = error ? `${name}-error` : undefined;

  return (
    <div className={cx("space-y-1.5", className)}>
      <label htmlFor={name} className="block text-sm font-medium text-foreground">
        {label}
        {/* Decorative — `required` on the control itself is what assistive
            technology announces. */}
        {required ? <span className="ml-1 text-danger" aria-hidden>*</span> : null}
      </label>
      {/* The control is handed the ids rather than each call site repeating
          them; there are ~200 of these and they would not stay in step. */}
      <FieldControlContext value={{ describedBy: errorId ?? hintId, invalid: Boolean(error) }}>
        {children}
      </FieldControlContext>
      {/* A hint is supporting text and goes back to 12px with everything else.
          The *error* does not: it is the one sentence saying why the work did
          not save, there is at most one on screen, and it is the last thing
          that should be hard to read. 13px, medium, in the danger colour. */}
      {hint && !error ? <p id={hintId} className="text-2xs text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p id={errorId} className="text-[0.8125rem] font-medium text-danger">{error}</p>
      ) : null}
    </div>
  );
}

/**
 * Carries the describedby/invalid wiring from `Field` down to whichever control
 * it wraps, so neither the ~200 call sites nor the four control components have
 * to pass it by hand.
 */
const FieldControlContext = createContext<{ describedBy?: string; invalid: boolean }>({
  invalid: false,
});

/**
 * The hint/error wiring `Field` is holding, for a control it does not render.
 *
 * `Input`, `Textarea`, `Select` and `Checkbox` consume this themselves, so
 * nothing had to reach for it — until a **controlled** input needed a hint. The
 * invoice line composer holds its price in React state (the item picked fills it
 * in), so it renders a bare `<input className={CONTROL}>` rather than `Input`,
 * and a bare input joins no context: its hint rendered on screen and was
 * announced by nothing, which is precisely the gap the 2026-08-24 pass closed
 * everywhere else.
 *
 * Exported rather than solved by giving `Input` a controlled mode: that is a
 * shared component with ~200 call sites, and widening its contract to fix two
 * fields is the larger change.
 */
export function useFieldControl() {
  return useContext(FieldControlContext);
}

export function Input({
  name, type = "text", defaultValue, placeholder, required, step, min, max, readOnly, inputMode,
  formId, autoComplete, id,
}: {
  name: string; type?: string; defaultValue?: string | number | null;
  placeholder?: string; required?: boolean; step?: string; min?: string | number;
  max?: string | number; readOnly?: boolean;
  inputMode?: "numeric" | "decimal" | "tel" | "email" | "text";
  /** Associates the input with a <form id=…> elsewhere, so fields can sit visually inside another form without nesting. */
  formId?: string;
  autoComplete?: string;
  /**
   * Overrides the id, which otherwise mirrors `name`. Needed where two forms on
   * one page post the same field name — the sign-in page asks for an email
   * twice — because duplicate ids leave both labels pointing at the first input.
   */
  id?: string;
}) {
  const field = useFieldControl();
  return (
    <input
      id={id ?? name} name={name} type={type} required={required} step={step}
      min={min} max={max} readOnly={readOnly} placeholder={placeholder}
      inputMode={inputMode} form={formId} autoComplete={autoComplete}
      aria-describedby={field.describedBy} aria-invalid={field.invalid || undefined}
      defaultValue={defaultValue ?? undefined} className={CONTROL}
    />
  );
}

/**
 * A password box with a show/hide control.
 *
 * Somebody typing a password on a counter tablet cannot see what they typed,
 * and the only feedback the box gives is "not recognised" a second later.
 * Letting them look is the single largest reduction in failed sign-ins a
 * login form can make (WCAG 3.3.8, Material's own guidance), and it costs
 * nothing: the toggle is a `<button>` inside the box, never a submit.
 *
 * The accessible name stays "Show password" in both states and `aria-pressed`
 * carries which one it is — a toggle whose *name* flips as well as its state
 * reads to a screen reader as two different controls. The label is inside the
 * box's own 44px row, and the button is the app's 36px floor.
 *
 * Joins `Field`'s hint and error wiring the same way `Input` does, so a
 * password field with a rule under it announces the rule.
 */
export function PasswordInput({
  name, required, autoComplete = "current-password", id, placeholder,
}: {
  name: string; required?: boolean;
  /** `current-password` on sign-in, `new-password` where one is being chosen. */
  autoComplete?: "current-password" | "new-password";
  id?: string; placeholder?: string;
}) {
  const field = useFieldControl();
  const [shown, setShown] = useState(false);
  const inputId = id ?? name;
  return (
    <div className="relative">
      <input
        id={inputId} name={name} type={shown ? "text" : "password"} required={required}
        autoComplete={autoComplete} placeholder={placeholder}
        aria-describedby={field.describedBy} aria-invalid={field.invalid || undefined}
        className={cx(CONTROL, "pr-12")}
      />
      <button
        type="button" onClick={() => setShown((value) => !value)}
        aria-pressed={shown} aria-controls={inputId}
        className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center
                   rounded-md text-muted-foreground transition hover:bg-surface-muted
                   hover:text-foreground active:bg-surface-sunken"
      >
        {shown
          ? <EyeOff className="size-[1.15rem]" aria-hidden />
          : <Eye className="size-[1.15rem]" aria-hidden />}
        <span className="sr-only">Show password</span>
      </button>
    </div>
  );
}

export function Textarea({
  name, defaultValue, rows = 3, placeholder,
}: { name: string; defaultValue?: string | null; rows?: number; placeholder?: string }) {
  const field = useFieldControl();
  return (
    <textarea id={name} name={name} rows={rows} placeholder={placeholder}
              defaultValue={defaultValue ?? undefined}
              aria-describedby={field.describedBy} aria-invalid={field.invalid || undefined}
              className={cx(CONTROL, "min-h-[5.5rem] resize-y py-2.5 leading-relaxed")} />
  );
}

export type SelectOption = { value: string; label: string };

export function Select({
  name, options, groups, defaultValue, required, placeholder, id, "aria-label": ariaLabel,
}: {
  name: string;
  options?: ReadonlyArray<SelectOption>;
  /**
   * Grouped choices. Used where a long list has a handful of everyday answers
   * and a long tail — the everyday ones go in the first group so the common
   * case is the first thing read, without hiding the rest behind a toggle.
   */
  groups?: ReadonlyArray<{ label: string; options: ReadonlyArray<SelectOption> }>;
  defaultValue?: string | null; required?: boolean; placeholder?: string;
  /**
   * Overrides the id, which otherwise mirrors `name` — the same escape hatch
   * `Input` carries, and needed for the same reason. A screen that repeats one
   * field name down a list (the People screen has a role and a site picker on
   * *every* member's row) would otherwise emit one `id="role"` per row: invalid
   * HTML, and every `<label for>` on the page resolves to whichever came first.
   */
  id?: string;
  /** For a control with no visible `Field` label — a row of inline edits. */
  "aria-label"?: string;
}) {
  const field = useFieldControl();
  return (
    <select id={id ?? name} name={name} required={required} aria-label={ariaLabel}
            aria-describedby={field.describedBy} aria-invalid={field.invalid || undefined}
            defaultValue={defaultValue ?? ""} className={cx(CONTROL, SELECT_CHEVRON)}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {(options ?? []).map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
      {(groups ?? []).map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function Checkbox({
  name, label, defaultChecked, value, id,
}: {
  name: string; label: string; defaultChecked?: boolean; value?: string;
  /*
   * Defaults to `name`, which is right for the ordinary case and wrong the
   * moment two forms on one page post the same field — the invoice page renders
   * a credit-note "GST applies" beside the line composer's, both named
   * `taxable`. The label association survives either way because the input is
   * *inside* the label, but two elements sharing a DOM id is invalid and makes
   * `getElementById` ambiguous. The same override `Input` and `Select` already
   * carry, added for the same reason (the People screen, 2026-08-27).
   */
  id?: string;
}) {
  // The padded label is the hit area, not just the 18px box — the whole row is
  // tappable, which is what makes a checklist usable one-handed in a truck.
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg py-1.5 text-sm
                      transition hover:bg-surface-muted/60">
      <input id={id ?? name} name={name} type="checkbox" value={value} defaultChecked={defaultChecked}
             className="size-[1.15rem] shrink-0 rounded border-control-border accent-primary" />
      {label}
    </label>
  );
}

/** Weekday picker for service patterns — ISO 1=Mon … 7=Sun. */
export function WeekdayPicker({
  name, defaultValue = [],
}: { name: string; defaultValue?: readonly number[] }) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">Service days</legend>
      {days.map((day, index) => {
        const value = index + 1;
        const id = `${name}-${value}`;
        return (
          <span key={value}>
            <input type="checkbox" id={id} name={name} value={value}
                   defaultChecked={defaultValue.includes(value)} className="peer sr-only" />
            <label htmlFor={id}
                   className="flex min-h-11 min-w-[3.25rem] cursor-pointer items-center justify-center
                              rounded-lg border border-strong bg-surface px-3 text-sm font-medium
                              shadow-xs transition hover:bg-surface-muted
                              peer-checked:border-primary peer-checked:bg-primary
                              peer-checked:text-primary-foreground
                              peer-focus-visible:outline peer-focus-visible:outline-2
                              peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
              {day}
            </label>
          </span>
        );
      })}
    </fieldset>
  );
}

/** Disables itself while the server action is in flight. */
export function SubmitButton({
  children = "Save", variant = "primary", pendingLabel = "Saving…", size = "lg", formId,
  className, formAction,
}: {
  children?: ReactNode;
  variant?: "primary" | "danger" | "secondary" | "ghost" | "dangerGhost";
  pendingLabel?: string;
  size?: "md" | "lg";
  formId?: string;
  /** For the few places the button should fill its column — a sign-in form. */
  className?: string;
  /**
   * A second verb for the same selection — the billing queue's Price and
   * Approve act on one set of ticks, so they are two buttons in one form rather
   * than two forms whose checkboxes would have to be kept in step.
   *
   * `useFormStatus` is form-wide, so while either is pending both show their own
   * pending label and neither can be pressed. That is the honest state: one
   * request is in flight over this selection.
   */
  formAction?: (formData: FormData) => void | Promise<void>;
}) {
  const { pending } = useFormStatus();
  // Mirrors BUTTON_VARIANTS in ui.tsx.
  const variants = {
    primary: "bg-action text-action-foreground shadow-xs hover:brightness-110 active:brightness-95",
    danger: "bg-danger text-on-status shadow-xs hover:brightness-110 active:brightness-95",
    secondary: "border border-strong bg-surface shadow-xs hover:bg-surface-muted active:bg-surface-sunken",
    // For a third verb in a row that already has two: present, and not
    // competing with them. Mirrors `ghost` in BUTTON_VARIANTS.
    ghost: "text-primary hover:bg-primary/8 active:bg-primary/15",
    // A destructive control inside a list row — Remove beside a line, not the
    // action the reader came for. §10b: teal means "this is the action", so a
    // Remove drawn in it competes with the one that is. Mirrors
    // `dangerGhost` in BUTTON_VARIANTS.
    dangerGhost: "text-danger hover:bg-danger/8 active:bg-danger/15",
  } as const;
  const sizes = { md: "min-h-10 px-4", lg: "min-h-11 px-5" } as const;
  return (
    <button type="submit" disabled={pending} form={formId} formAction={formAction}
            aria-busy={pending || undefined}
            className={cx(
              "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition",
              "disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0",
              sizes[size], variants[variant], className,
            )}>
      {/* The label already changes to "Saving…"; the spinner is the part that
          says it is *still* going, which matters on a slow van connection
          where a request can take several seconds and a dimmed button reads
          as broken rather than busy. Under reduced motion the global rule
          freezes it to a static glyph, which is what that preference asks. */}
      {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
      {pending ? pendingLabel : children}
    </button>
  );
}

/**
 * The action row at the foot of a form.
 *
 * On a phone it sticks to the bottom of the viewport: a long entry form
 * otherwise buries "Create job" below several screenfuls of scrolling, and the
 * one thing the operator came to do should never need hunting for.
 */
export function FormActions({ children, sticky = true }: { children: ReactNode; sticky?: boolean }) {
  return (
    <div className={cx(
      "flex flex-wrap items-center gap-3 border-t bg-surface px-4 py-4 sm:rounded-xl sm:border sm:px-5 sm:shadow-sm",
      /* On a phone the bar sits on the bottom edge, which on a handset with a
         home indicator is exactly where the gesture bar is. The inset is 0 in a
         browser tab today and only reads non-zero once the viewport opts into
         `viewport-fit=cover`; it is written now so the bar is already right the
         day that flag is set, rather than the day somebody notices. */
      sticky && "sticky bottom-0 z-20 -mx-4 pb-[max(1rem,env(safe-area-inset-bottom))] " +
        "shadow-[0_-2px_8px_rgb(16_24_40/0.06)] sm:static sm:mx-0 sm:pb-4 sm:shadow-sm",
    )}>
      {children}
    </div>
  );
}
