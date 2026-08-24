"use client";

import { useFormStatus } from "react-dom";
import { createContext, useContext, type ReactNode } from "react";
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
      <label htmlFor={name} className="block text-base font-medium text-foreground">
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
      {/* `text-sm` here, not `text-xs`. A hint nobody can read is decoration,
          and an error nobody can read is worse — it is the sentence that says
          why the work did not save. */}
      {hint && !error ? <p id={hintId} className="text-sm text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p id={errorId} className="text-sm font-medium text-danger">{error}</p>
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

function useFieldControl() {
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
  name, options, groups, defaultValue, required, placeholder,
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
}) {
  const field = useFieldControl();
  return (
    <select id={name} name={name} required={required}
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
  name, label, defaultChecked, value,
}: { name: string; label: string; defaultChecked?: boolean; value?: string }) {
  // The padded label is the hit area, not just the 18px box — the whole row is
  // tappable, which is what makes a checklist usable one-handed in a truck.
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg py-1.5 text-sm
                      transition hover:bg-surface-muted/60">
      <input id={name} name={name} type="checkbox" value={value} defaultChecked={defaultChecked}
             className="size-[1.15rem] shrink-0 rounded border-strong accent-primary" />
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
  variant?: "primary" | "danger" | "secondary";
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
    primary: "bg-action text-action-foreground shadow-xs hover:brightness-110",
    danger: "bg-danger text-on-status shadow-xs hover:brightness-110",
    secondary: "border border-strong bg-surface shadow-xs hover:bg-surface-muted",
  } as const;
  const sizes = { md: "min-h-10 px-4", lg: "min-h-11 px-5" } as const;
  return (
    <button type="submit" disabled={pending} form={formId} formAction={formAction}
            className={cx(
              "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition",
              "disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0",
              sizes[size], variants[variant], className,
            )}>
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
      sticky && "sticky bottom-0 z-20 -mx-4 shadow-[0_-2px_8px_rgb(16_24_40/0.06)] sm:static sm:mx-0 sm:shadow-sm",
    )}>
      {children}
    </div>
  );
}
